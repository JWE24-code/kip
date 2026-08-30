// Calendar ingestion (kip-app#70). Subscribe to a live ICS URL (Google /
// Outlook / Fastmail "secret iCal address", any webcal:// feed); expand the
// next-N-days window of events; hand them to the existing reminders pipeline
// so each upcoming event gets the same nest-retrieval prep brief + lead-time
// notification a hand-typed reminder does (scripts/lib/reminders.js).
//
// This module is the *ingestion* half only — fetch, parse, expand, store,
// and reconcile into reminders.json. The scheduling / notification / prep
// half already exists and is untouched.
//
// Storage:
//   <coop>/.henhouse/calendars.json   the subscription list — ICS URLs are
//                                      bearer secrets, kept out of the graph
//   <coop>/.roost/calendar-events.json the expanded event cache (derived;
//                                      a rebuild-roost may delete it)
const fs = require('node:fs')
const ICAL = require('ical.js')

const { DEFAULT_VAULT_ROOT, calendarsConfigPath, calendarCachePath } = require('./paths')

const DEFAULT_WINDOW_DAYS = 14
const DEFAULT_REFRESH_MIN = 30
const DEFAULT_LEAD_MIN = 15
const MAX_EVENTS_PER_CAL = 250

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

/** webcal:// (and webcals://) are just http(s) with a calendar MIME hint. */
function normalizeIcsUrl (url) {
  return String(url || '').trim()
    .replace(/^webcals:\/\//i, 'https://')
    .replace(/^webcal:\/\//i, 'https://')
}

/** GET an ICS feed, returning its text. Throws a readable error otherwise. */
async function fetchIcs (url, { fetchImpl, signal } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a))
  const real = normalizeIcsUrl(url)
  if (!/^https?:\/\//i.test(real)) throw new Error(`Not an http(s)/webcal URL: ${url}`)
  let res
  try {
    res = await doFetch(real, { headers: { Accept: 'text/calendar, text/plain, */*' }, signal, redirect: 'follow' })
  } catch (err) {
    throw new Error(`Couldn't reach the calendar feed (${(err && err.message) || err}).`)
  }
  if (!res.ok) throw new Error(`The calendar feed returned ${res.status} ${res.statusText || ''}`.trim())
  const text = await res.text()
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That URL did not return an iCalendar (.ics) feed.')
  return text
}

// ---------------------------------------------------------------------------
// parse + expand
// ---------------------------------------------------------------------------

const iso = (icalTime) => icalTime.toJSDate().toISOString()

function attendeeNames (vevent) {
  return vevent.getAllProperties('attendee').map((p) => {
    const cn = p.getParameter('cn')
    if (cn) return String(cn)
    const v = String(p.getFirstValue() || '')
    return v.replace(/^mailto:/i, '')
  }).filter(Boolean)
}

function organizerName (vevent) {
  const p = vevent.getFirstProperty('organizer')
  if (!p) return ''
  return String(p.getParameter('cn') || String(p.getFirstValue() || '').replace(/^mailto:/i, '') || '')
}

function normalizeOccurrence (event, vevent, startTime, endTime) {
  return {
    uid: String(event.uid || ''),
    // recurrence instances share a uid — the start disambiguates them
    id: `${event.uid || 'evt'}@${startTime.toString()}`,
    title: String(event.summary || '').trim() || '(untitled event)',
    start: iso(startTime),
    end: iso(endTime),
    allDay: !!(event.startDate && event.startDate.isDate),
    location: String(event.location || '').trim(),
    description: String(event.description || '').trim(),
    organizer: organizerName(vevent),
    attendees: attendeeNames(vevent),
    status: String(vevent.getFirstPropertyValue('status') || '').toUpperCase() || null
  }
}

/**
 * Parse an ICS document and return the normalized event occurrences that
 * overlap [now, now + windowDays]. Recurring events are expanded; cancelled
 * occurrences and events with no usable start are dropped.
 */
function parseCalendar (icsText, { windowDays = DEFAULT_WINDOW_DAYS, now = new Date(), max = MAX_EVENTS_PER_CAL } = {}) {
  const comp = new ICAL.Component(ICAL.parse(icsText))
  const vevents = comp.getAllSubcomponents('vevent')

  const rangeStart = ICAL.Time.fromJSDate(now, false)
  const rangeEnd = ICAL.Time.fromJSDate(new Date(now.getTime() + windowDays * 86400000), false)

  const out = []
  for (const vevent of vevents) {
    let event
    try { event = new ICAL.Event(vevent) } catch { continue }
    if (!event.startDate) continue
    // a modified single instance (RECURRENCE-ID) is emitted by its parent's
    // expansion — skip the standalone copy
    if (event.isRecurrenceException()) continue

    if (event.isRecurring()) {
      let iter
      try { iter = event.iterator() } catch { continue }
      let next
      while ((next = iter.next())) {
        if (next.compare(rangeEnd) > 0) break
        let occ
        try { occ = event.getOccurrenceDetails(next) } catch { continue }
        if (occ.endDate.compare(rangeStart) < 0) continue
        const row = normalizeOccurrence(event, occ.item ? occ.item.component : vevent, occ.startDate, occ.endDate)
        if (row.status !== 'CANCELLED') out.push(row)
        if (out.length >= max) break
      }
    } else {
      const endDate = event.endDate || event.startDate
      if (endDate.compare(rangeStart) < 0 || event.startDate.compare(rangeEnd) > 0) continue
      const row = normalizeOccurrence(event, vevent, event.startDate, endDate)
      if (row.status !== 'CANCELLED') out.push(row)
    }
    if (out.length >= max) break
  }
  return out.sort((a, b) => new Date(a.start) - new Date(b.start))
}

// ---------------------------------------------------------------------------
// subscription store  (<coop>/.henhouse/calendars.json)
// ---------------------------------------------------------------------------

/** { calendars: [ { id, url, label, leadMin, refreshMin, enabled,
 *  lastFetchedAt, lastError } ] } — [] on any read problem. */
function loadCalendars (vaultRoot = DEFAULT_VAULT_ROOT) {
  try {
    const parsed = JSON.parse(fs.readFileSync(calendarsConfigPath(vaultRoot), 'utf8'))
    return Array.isArray(parsed && parsed.calendars) ? parsed.calendars : []
  } catch {
    return []
  }
}

function saveCalendars (vaultRoot, calendars) {
  const file = calendarsConfigPath(vaultRoot)
  fs.mkdirSync(require('node:path').dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ calendars }, null, 2) + '\n')
}

function nextCalId (calendars) {
  return calendars.reduce((max, c) => Math.max(max, Number(c.id) || 0), 0) + 1
}

function addCalendar (vaultRoot = DEFAULT_VAULT_ROOT, { url, label, leadMin, refreshMin } = {}) {
  const real = normalizeIcsUrl(url)
  if (!/^https?:\/\//i.test(real)) throw new Error('A calendar subscription needs an http(s):// or webcal:// URL.')
  const calendars = loadCalendars(vaultRoot)
  if (calendars.some((c) => normalizeIcsUrl(c.url) === real)) throw new Error('That calendar is already subscribed.')
  const row = {
    id: nextCalId(calendars),
    url: String(url).trim(),
    label: (label && String(label).trim()) || hostLabel(real),
    leadMin: Number.isFinite(+leadMin) ? Math.max(0, Math.round(+leadMin)) : DEFAULT_LEAD_MIN,
    refreshMin: Number.isFinite(+refreshMin) ? Math.max(5, Math.round(+refreshMin)) : DEFAULT_REFRESH_MIN,
    enabled: true,
    lastFetchedAt: null,
    lastError: null
  }
  calendars.push(row)
  saveCalendars(vaultRoot, calendars)
  return row
}

function removeCalendar (vaultRoot = DEFAULT_VAULT_ROOT, id) {
  const calendars = loadCalendars(vaultRoot)
  const kept = calendars.filter((c) => String(c.id) !== String(id))
  if (kept.length === calendars.length) return null
  saveCalendars(vaultRoot, kept)
  return { id }
}

function setCalendarEnabled (vaultRoot = DEFAULT_VAULT_ROOT, id, enabled) {
  const calendars = loadCalendars(vaultRoot)
  const row = calendars.find((c) => String(c.id) === String(id))
  if (!row) return null
  row.enabled = !!enabled
  saveCalendars(vaultRoot, calendars)
  return row
}

const hostLabel = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return 'Calendar' }
}

// ---------------------------------------------------------------------------
// event cache  (<coop>/.roost/calendar-events.json)
// ---------------------------------------------------------------------------

function loadCachedEvents (vaultRoot = DEFAULT_VAULT_ROOT) {
  try {
    const parsed = JSON.parse(fs.readFileSync(calendarCachePath(vaultRoot), 'utf8'))
    return Array.isArray(parsed && parsed.events) ? parsed.events : []
  } catch {
    return []
  }
}

function saveCachedEvents (vaultRoot, events) {
  const file = calendarCachePath(vaultRoot)
  fs.mkdirSync(require('node:path').dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ refreshedAt: new Date().toISOString(), events }, null, 2) + '\n')
}

// ---------------------------------------------------------------------------
// refresh — fetch every enabled subscription, expand, rewrite the cache
// ---------------------------------------------------------------------------

async function refreshCalendars (vaultRoot = DEFAULT_VAULT_ROOT, { fetchImpl, now = new Date(), windowDays = DEFAULT_WINDOW_DAYS, signal } = {}) {
  const calendars = loadCalendars(vaultRoot)
  const all = []
  let ok = 0
  for (const cal of calendars) {
    if (cal.enabled === false) continue
    try {
      const text = await fetchIcs(cal.url, { fetchImpl, signal })
      const events = parseCalendar(text, { windowDays, now }).map((e) => ({ ...e, calId: cal.id, calLabel: cal.label, leadMin: cal.leadMin }))
      all.push(...events)
      cal.lastFetchedAt = new Date().toISOString()
      cal.lastError = null
      ok++
    } catch (err) {
      cal.lastError = (err && err.message) || String(err)
    }
  }
  saveCalendars(vaultRoot, calendars)
  all.sort((a, b) => new Date(a.start) - new Date(b.start))
  saveCachedEvents(vaultRoot, all)
  return { calendars: calendars.length, ok, events: all.length }
}

// ---------------------------------------------------------------------------
// reconcile cached events -> reminders.json  (source: "calendar")
// ---------------------------------------------------------------------------

/**
 * Make reminders.json reflect the calendar cache: one pending reminder per
 * upcoming event (source "calendar", eventKey = the occurrence id). Events
 * that disappeared or were cancelled get their still-pending calendar
 * reminders dropped; ones already notified are left alone. Hand-typed
 * reminders (source "peck"/"skill") are never touched.
 *
 * Returns { added, updated, removed }.
 */
function syncCalendarReminders (vaultRoot = DEFAULT_VAULT_ROOT, { now = new Date() } = {}) {
  const reminders = require('./reminders')
  const events = loadCachedEvents(vaultRoot)
  const rows = reminders.loadReminders(vaultRoot)

  const liveById = new Map(events.map((e) => [e.id, e]))
  const nowMs = now.getTime()

  let added = 0
  let updated = 0
  let removed = 0

  // drop calendar reminders whose event is gone and which haven't fired
  const kept = rows.filter((r) => {
    if (r.source !== 'calendar' || r.status !== 'pending') return true
    if (liveById.has(r.eventKey)) return true
    removed++
    return false
  })

  const byKey = new Map(kept.filter((r) => r.source === 'calendar').map((r) => [r.eventKey, r]))
  let maxId = rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0)

  for (const e of events) {
    if (new Date(e.start).getTime() < nowMs) continue // already started/past
    const leadMin = Number.isFinite(+e.leadMin) ? +e.leadMin : DEFAULT_LEAD_MIN
    const notifyAt = new Date(new Date(e.start).getTime() - leadMin * 60_000).toISOString()
    const existing = byKey.get(e.id)
    if (existing) {
      if (existing.status !== 'pending') continue
      if (existing.eventAt !== e.start || existing.title !== e.title || existing.notifyAt !== notifyAt) {
        existing.eventAt = e.start
        existing.title = e.title
        existing.notifyAt = notifyAt
        existing.leadMin = leadMin
        existing.body = calendarBody(e)
        updated++
      }
    } else {
      kept.push({
        id: ++maxId,
        created: new Date().toISOString(),
        title: e.title,
        body: calendarBody(e),
        eventAt: e.start,
        leadMin,
        notifyAt,
        status: 'pending',
        sound: true,
        source: 'calendar',
        eventKey: e.id,
        calLabel: e.calLabel || null
      })
      added++
    }
  }

  reminders.saveReminders(vaultRoot, kept)
  return { added, updated, removed }
}

function calendarBody (e) {
  const parts = []
  if (e.location) parts.push(`Location: ${e.location}`)
  if (e.organizer) parts.push(`Organizer: ${e.organizer}`)
  if (e.attendees && e.attendees.length) parts.push(`Attendees: ${e.attendees.slice(0, 20).join(', ')}`)
  if (e.description) parts.push('', e.description)
  return parts.join('\n')
}

module.exports = {
  DEFAULT_WINDOW_DAYS,
  DEFAULT_REFRESH_MIN,
  DEFAULT_LEAD_MIN,
  normalizeIcsUrl,
  fetchIcs,
  parseCalendar,
  loadCalendars,
  saveCalendars,
  addCalendar,
  removeCalendar,
  setCalendarEnabled,
  loadCachedEvents,
  saveCachedEvents,
  refreshCalendars,
  syncCalendarReminders
}
