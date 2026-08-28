// The reminders store. A reminder = a future event ("meeting with Acme, Fri
// 15:00") plus a lead time; Kip notifies you `leadMin` minutes before, with
// prep pulled from the nest (see scripts/reminders.js --due).
//
// Persisted as a single visible JSON file at the coop root
// (<coop>/reminders.json) — user data Kip owns, NOT under .roost/ so a
// rebuild-roost never touches it. Pure JS (no better-sqlite3) so the reminders
// skill and the CLI share this one module.
const fs = require('node:fs')
const chrono = require('chrono-node')

const { DEFAULT_VAULT_ROOT, remindersPath } = require('./paths')

const DEFAULT_LEAD_MIN = 60
const EVENT_NOUNS = 'meeting|call|appointment|sync|standup|stand-up|review|1:1|one-on-one|interview|catch-up|catchup|demo|presentation|deadline|due|lunch|dinner|coffee|session|workshop|checkin|check-in'

// ---------------------------------------------------------------------------
// file I/O
// ---------------------------------------------------------------------------

/** The reminders array from <coop>/reminders.json; [] on any problem. */
function loadReminders (vaultRoot = DEFAULT_VAULT_ROOT) {
  try {
    const parsed = JSON.parse(fs.readFileSync(remindersPath(vaultRoot), 'utf8'))
    return Array.isArray(parsed && parsed.reminders) ? parsed.reminders : []
  } catch {
    return []
  }
}

/** Writes the whole reminders array back. */
function saveReminders (vaultRoot, reminders) {
  fs.writeFileSync(remindersPath(vaultRoot), JSON.stringify({ reminders }, null, 2) + '\n')
}

function nextId (reminders) {
  return reminders.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1
}

// ---------------------------------------------------------------------------
// natural-language interpretation
// ---------------------------------------------------------------------------

// "15h" / "15h30" / "9h" -> "15:00" / "15:30" / "9:00" so chrono's English
// parser (which doesn't know the 24h "h" notation) picks up the time.
function normalizeClock (text) {
  return String(text).replace(/\b(\d{1,2})h(\d{2})?\b/gi, (_, h, m) => `${h}:${m || '00'}`)
}

// chrono doesn't resolve a bare "the 20th" / "on the 20th" (ordinal day, no
// month) — rewrite it to an explicit YYYY-MM-DD (this month, or next if the
// day already passed) so it does.
function normalizeOrdinalDay (text, ref = new Date()) {
  return String(text).replace(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/gi, (m, dStr) => {
    const d = Number(dStr)
    if (d < 1 || d > 31) return m
    const base = new Date(ref)
    let y = base.getFullYear()
    let mo = base.getMonth()
    if (d < base.getDate()) { mo++; if (mo > 11) { mo = 0; y++ } }
    return `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  })
}

const DATE_PHRASE_RE = /\b(?:on\s+|by\s+|this\s+|next\s+|coming\s+)?(?:today|tonight|tomorrow|tmr|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{4}-\d{2}-\d{2})\b(?:\s+the\s+\d{1,2}(?:st|nd|rd|th)?)?(?:,?\s*(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?|\b(?:at\s+)?\d{1,2}:\d{2}\b|\bat\s+\d{1,2}\s*(?:am|pm)?\b|\bin\s+\d+\s+(?:min(?:ute)?s?|hours?|days?|weeks?)\b|\bon\s+the\s+\d{1,2}(?:st|nd|rd|th)?\b/gi

const LEAD_RE = new RegExp(
  '\\b(?:(\\d+)\\s*(minutes?|mins?|hours?|hrs?|h|days?|d|weeks?|w)|an?\\s+(hour|day|week)|the\\s+(day|week)|half\\s+an\\s+hour)' +
  '\\s*(?:before|beforehand|prior|ahead|in\\s+advance|upfront|early)\\b', 'i')

const UNIT_MIN = { m: 1, min: 1, minute: 1, h: 60, hr: 60, hour: 60, d: 1440, day: 1440, w: 10080, week: 10080 }

// "silent" / "no sound" / "mute" / "quietly" in the request -> no ding.
const SILENT_RE = /\b(silent(?:ly)?|no\s+(?:sound|ding|chime|alert|noise)|without\s+(?:a\s+)?(?:sound|ding|chime)|muted?|quietly|don'?t\s+ding)\b/i

/** false when the text asks for a silent reminder, else null (default = ding). */
function parseSound (text) {
  return SILENT_RE.test(String(text || '')) ? false : null
}

/** Minutes of lead time from a phrase like "a day before" / "30 min before", or null. */
function parseLead (text) {
  const m = normalizeClock(text).match(LEAD_RE)
  if (!m) return null
  if (/half\s+an\s+hour/i.test(m[0])) return 30
  const word = (m[3] || m[4] || '').toLowerCase()
  if (word) return UNIT_MIN[word] || null
  const n = Number(m[1])
  const unit = (m[2] || '').toLowerCase().replace(/s$/, '').replace('mins', 'min').replace('hrs', 'hr')
  const per = UNIT_MIN[unit] || UNIT_MIN[unit.slice(0, 1)]
  return Number.isFinite(n) && per ? n * per : null
}

/**
 * Pulls an event time out of free text.
 *   { eventAt: ISO|null, hadTime: bool, matchedText: string }
 * forwardDate so "Friday" / "at 3" resolve to the next occurrence.
 */
function parseWhen (text, ref = new Date()) {
  const prepped = normalizeOrdinalDay(normalizeClock(text), ref)
  const results = chrono.parse(prepped, ref, { forwardDate: true })
  const r = results[0]
  if (!r) return { eventAt: null, hadTime: false, matchedText: '' }
  const date = r.start.date()
  const hadTime = r.start.isCertain('hour')
  if (!hadTime) date.setHours(9, 0, 0, 0) // a dateless "on Friday" -> 09:00
  return { eventAt: date.toISOString(), hadTime, matchedText: r.text }
}

/** Best-effort event title: strip the date phrase, lead phrase, and framing verbs. */
function deriveTitle (text, matchedText) {
  let t = normalizeClock(String(text))
  if (matchedText) t = t.split(matchedText).join(' ')
  t = t.replace(LEAD_RE, ' ')
  t = t.replace(SILENT_RE, ' ')
  t = t.replace(DATE_PHRASE_RE, ' ') // scrub any date phrase the matchedText strip missed
  // framing, anywhere (a trailing ", remind me a day before" leaves "remind me")
  t = t.replace(/\b(?:please\s+)?remind me(?:\s+(?:to|about|that))?\b/ig, ' ')
  t = t.replace(/\bdon'?t\s+(?:let me\s+)?forget\s+(?:about|to)?\b/ig, ' ')
  t = t.replace(/^\s*(?:i\s+have\s+(?:a|an|my)?|there'?s\s+(?:a|an)?|note:?|fyi:?)\s*/i, '')
  // dangling connectives left where a phrase was cut out
  t = t.replace(/[,;]?\s*\b(?:on|at|by|this|next|the|around|from)\s*(?=[,;]|$)/ig, ' ')
  t = t.replace(/\s{2,}/g, ' ').replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '').trim()
  return t || 'reminder'
}

/** Heuristic — is this Peck input about an event to be reminded of? */
function looksLikeReminder (text) {
  const t = String(text || '')
  if (/\bremind me\b/i.test(t)) return true
  if (/\bdon'?t (?:let me )?forget\b/i.test(t)) return true
  const hasEvent = new RegExp(`\\b(${EVENT_NOUNS})\\b`, 'i').test(t)
  const hasWhen = /\b(today|tonight|tomorrow|tmr|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|next (?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in \d+ (?:min|minute|hour|day|week)|on the \d{1,2}(?:st|nd|rd|th)?)\b/i.test(t) ||
                  /\b\d{1,2}\s*(?:h\b|:\d{2}|am|pm|o'clock)/i.test(t) ||
                  /\bat \d{1,2}\b/i.test(t)
  return hasEvent && hasWhen
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function shapeLead (lead) {
  if (lead == null || lead === '') return null
  if (typeof lead === 'number' && Number.isFinite(lead)) return Math.max(0, Math.round(lead))
  const m = String(lead).trim().match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)?$/i)
  if (!m) return parseLead(String(lead))
  const n = Number(m[1])
  const unit = (m[2] || 'm').toLowerCase().replace(/s$/, '')
  return n * (UNIT_MIN[unit] || UNIT_MIN[unit.slice(0, 1)] || 1)
}

/**
 * Adds a reminder. Give `text` (free-form: "meeting with Acme friday at 15h,
 * remind me a day before") and/or explicit `title` / `when` / `eventAt` /
 * `leadMin`. Returns the stored row. Throws if no time can be resolved.
 */
function addReminder (vaultRoot = DEFAULT_VAULT_ROOT, opts = {}) {
  const { text = '', title, when, eventAt, body = '', source = 'peck', defaultLeadMin = DEFAULT_LEAD_MIN, ref } = opts
  const sound = typeof opts.sound === 'boolean' ? opts.sound : (parseSound(text) ?? true)

  let iso = eventAt || null
  let matchedText = ''
  if (!iso) {
    const parsed = parseWhen(when || text, ref ? new Date(ref) : new Date())
    iso = parsed.eventAt
    matchedText = parsed.matchedText
  }
  if (!iso) throw new Error('could not work out a date/time from the request — try "on Friday at 15:00" or an explicit date')

  const lead = shapeLead(opts.leadMin ?? opts.lead) ?? parseLead(text) ?? defaultLeadMin
  const finalTitle = (title && String(title).trim()) || deriveTitle(text || when || '', matchedText)

  const reminders = loadReminders(vaultRoot)
  const now = new Date().toISOString()
  const row = {
    id: nextId(reminders),
    created: now,
    title: finalTitle,
    body: String(body || ''),
    eventAt: iso,
    leadMin: lead,
    notifyAt: new Date(new Date(iso).getTime() - lead * 60_000).toISOString(),
    status: 'pending',
    sound,
    source
  }
  reminders.push(row)
  saveReminders(vaultRoot, reminders)
  return row
}

function listReminders (vaultRoot = DEFAULT_VAULT_ROOT, { status, upcomingOnly = false } = {}) {
  let out = loadReminders(vaultRoot)
  if (status) out = out.filter((r) => r.status === status)
  if (upcomingOnly) {
    const now = Date.now()
    out = out.filter((r) => r.status === 'pending' || new Date(r.eventAt).getTime() >= now)
  }
  return out.slice().sort((a, b) => new Date(a.eventAt) - new Date(b.eventAt))
}

function cancelReminder (vaultRoot = DEFAULT_VAULT_ROOT, id) {
  const reminders = loadReminders(vaultRoot)
  const row = reminders.find((r) => String(r.id) === String(id))
  if (!row) return null
  row.status = 'canceled'
  saveReminders(vaultRoot, reminders)
  return row
}

/** Turn the ding on/off for one reminder. */
function setReminderSound (vaultRoot = DEFAULT_VAULT_ROOT, id, on) {
  const reminders = loadReminders(vaultRoot)
  const row = reminders.find((r) => String(r.id) === String(id))
  if (!row) return null
  row.sound = !!on
  saveReminders(vaultRoot, reminders)
  return row
}

/** pending reminders whose notify time has arrived. */
function dueReminders (vaultRoot = DEFAULT_VAULT_ROOT, now = new Date()) {
  const cutoff = now instanceof Date ? now.getTime() : new Date(now).getTime()
  return loadReminders(vaultRoot)
    .filter((r) => r.status === 'pending' && new Date(r.notifyAt).getTime() <= cutoff)
    .sort((a, b) => new Date(a.notifyAt) - new Date(b.notifyAt))
}

/** Flags a reminder as notified and stores the prep that went with it. */
function markNotified (vaultRoot = DEFAULT_VAULT_ROOT, id, { relatedSlugs, context } = {}) {
  const reminders = loadReminders(vaultRoot)
  const row = reminders.find((r) => String(r.id) === String(id))
  if (!row) return null
  row.status = 'notified'
  row.notifiedAt = new Date().toISOString()
  if (Array.isArray(relatedSlugs)) row.relatedSlugs = relatedSlugs
  if (context != null) row.context = String(context)
  saveReminders(vaultRoot, reminders)
  return row
}

// ---------------------------------------------------------------------------
// display
// ---------------------------------------------------------------------------

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function fmtWhen (iso) {
  const d = new Date(iso)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${hh}:${mm}`
}

function fmtLead (min) {
  if (min % 1440 === 0 && min >= 1440) return `${min / 1440}d`
  if (min % 60 === 0 && min >= 60) return `${min / 60}h`
  return `${min}m`
}

/** The one-line confirmation the skill / CLI prints for a new reminder. */
function describeReminder (r) {
  return `⏰ Reminder set: ${fmtWhen(r.notifyAt)} — ${fmtLead(r.leadMin)} before "${r.title}" (${fmtWhen(r.eventAt)})` +
    `${r.sound === false ? ' — silent' : ''}.`
}

module.exports = {
  DEFAULT_LEAD_MIN,
  loadReminders,
  saveReminders,
  addReminder,
  listReminders,
  cancelReminder,
  setReminderSound,
  dueReminders,
  markNotified,
  parseWhen,
  parseLead,
  parseSound,
  deriveTitle,
  looksLikeReminder,
  describeReminder,
  fmtWhen,
  fmtLead
}
