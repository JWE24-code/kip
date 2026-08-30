const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const cal = require('../lib/calendar')
const reminders = require('../lib/reminders')

function tmpVault () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-cal-test-'))
  fs.mkdirSync(path.join(root, '.henhouse'), { recursive: true })
  fs.mkdirSync(path.join(root, '.roost'), { recursive: true })
  return root
}

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:single-1
SUMMARY:Coffee with Sam
DTSTART:20260901T090000Z
DTEND:20260901T093000Z
LOCATION:Blue Bottle
ORGANIZER;CN=Sam Lee:mailto:sam@example.com
ATTENDEE;CN=Jo:mailto:jo@example.com
ATTENDEE:mailto:pat@example.com
DESCRIPTION:Catch up on Q3
END:VEVENT
BEGIN:VEVENT
UID:weekly-1
SUMMARY:Team standup
DTSTART:20260902T140000Z
DTEND:20260902T141500Z
RRULE:FREQ=WEEKLY;COUNT=8
EXDATE:20260909T140000Z
END:VEVENT
BEGIN:VEVENT
UID:allday-1
SUMMARY:Conference
DTSTART;VALUE=DATE:20260903
DTEND;VALUE=DATE:20260905
END:VEVENT
BEGIN:VEVENT
UID:cancelled-1
SUMMARY:Dead meeting
DTSTART:20260903T100000Z
STATUS:CANCELLED
END:VEVENT
BEGIN:VEVENT
UID:past-1
SUMMARY:Last week
DTSTART:20260820T090000Z
DTEND:20260820T093000Z
END:VEVENT
END:VCALENDAR`

const NOW = new Date('2026-08-30T00:00:00Z')

test('normalizeIcsUrl: webcal(s):// -> https://', () => {
  assert.equal(cal.normalizeIcsUrl('webcal://p.example.com/a.ics'), 'https://p.example.com/a.ics')
  assert.equal(cal.normalizeIcsUrl('WEBCALS://x/y'), 'https://x/y')
  assert.equal(cal.normalizeIcsUrl('  https://x/y  '), 'https://x/y')
})

test('parseCalendar: single event — all fields normalized', () => {
  const events = cal.parseCalendar(ICS, { now: NOW, windowDays: 14 })
  const coffee = events.find((e) => e.uid === 'single-1')
  assert.ok(coffee)
  assert.equal(coffee.title, 'Coffee with Sam')
  assert.equal(coffee.start, '2026-09-01T09:00:00.000Z')
  assert.equal(coffee.location, 'Blue Bottle')
  assert.equal(coffee.organizer, 'Sam Lee')
  assert.deepEqual(coffee.attendees, ['Jo', 'pat@example.com'])
  assert.equal(coffee.allDay, false)
})

test('parseCalendar: recurrence expanded + windowed, EXDATE skipped', () => {
  const events = cal.parseCalendar(ICS, { now: NOW, windowDays: 14 }).filter((e) => e.uid === 'weekly-1')
  const starts = events.map((e) => e.start)
  assert.deepEqual(starts, ['2026-09-02T14:00:00.000Z', '2026-09-13T14:00:00.000Z'].slice(0, starts.length))
  assert.ok(starts.includes('2026-09-02T14:00:00.000Z'))
  assert.ok(!starts.includes('2026-09-09T14:00:00.000Z'), 'the EXDATE occurrence is gone')
  assert.ok(starts.every((s) => new Date(s) <= new Date('2026-09-13T00:00:00Z')), 'nothing past the 14-day window')
})

test('parseCalendar: all-day flag, cancelled + past events dropped', () => {
  const events = cal.parseCalendar(ICS, { now: NOW, windowDays: 14 })
  assert.ok(events.find((e) => e.uid === 'allday-1').allDay)
  assert.ok(!events.some((e) => e.uid === 'cancelled-1'), 'STATUS:CANCELLED dropped')
  assert.ok(!events.some((e) => e.uid === 'past-1'), 'a fully-past event is outside the window')
})

test('parseCalendar: events come back sorted by start', () => {
  const events = cal.parseCalendar(ICS, { now: NOW, windowDays: 30 })
  const starts = events.map((e) => +new Date(e.start))
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b))
})

// --- fetch --------------------------------------------------------------------

function fetchStub (body, { ok = true, status = 200 } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return { ok, status, statusText: ok ? 'OK' : 'Not Found', text: async () => body }
  }
  return { impl, calls }
}

test('fetchIcs: normalizes webcal, sends Accept, returns the body', async () => {
  const { impl, calls } = fetchStub(ICS)
  const text = await cal.fetchIcs('webcal://cal.example.com/feed.ics', { fetchImpl: impl })
  assert.match(text, /BEGIN:VCALENDAR/)
  assert.equal(calls[0].url, 'https://cal.example.com/feed.ics')
  assert.match(calls[0].init.headers.Accept, /text\/calendar/)
})

test('fetchIcs: a non-2xx and a non-ICS body both throw readably', async () => {
  await assert.rejects(cal.fetchIcs('https://x/y', { fetchImpl: fetchStub('', { ok: false, status: 404 }).impl }), /404/)
  await assert.rejects(cal.fetchIcs('https://x/y', { fetchImpl: fetchStub('<html>nope</html>').impl }), /did not return an iCalendar/)
})

// --- subscription store ------------------------------------------------------

test('addCalendar / removeCalendar / dedup / bad URL', () => {
  const root = tmpVault()
  const row = cal.addCalendar(root, { url: 'webcal://cal.example.com/a.ics', leadMin: 20 })
  assert.equal(row.id, 1)
  assert.equal(row.leadMin, 20)
  assert.equal(row.label, 'cal.example.com')
  assert.equal(cal.loadCalendars(root).length, 1)

  assert.throws(() => cal.addCalendar(root, { url: 'webcal://cal.example.com/a.ics' }), /already subscribed/)
  assert.throws(() => cal.addCalendar(root, { url: 'not-a-url' }), /http\(s\)/)

  assert.ok(cal.removeCalendar(root, 1))
  assert.equal(cal.loadCalendars(root).length, 0)
  assert.equal(cal.removeCalendar(root, 99), null)
})

test('setCalendarEnabled toggles the flag', () => {
  const root = tmpVault()
  cal.addCalendar(root, { url: 'https://x/a.ics' })
  assert.equal(cal.setCalendarEnabled(root, 1, false).enabled, false)
  assert.equal(cal.loadCalendars(root)[0].enabled, false)
})

// --- refresh ----------------------------------------------------------------

test('refreshCalendars: writes the cache, records per-calendar lastError', async () => {
  const root = tmpVault()
  cal.addCalendar(root, { url: 'https://good/a.ics', label: 'Good' })
  cal.addCalendar(root, { url: 'https://bad/b.ics', label: 'Bad' })

  const impl = async (url) => url.includes('good')
    ? { ok: true, status: 200, text: async () => ICS }
    : { ok: false, status: 500, statusText: 'Server Error', text: async () => '' }

  const res = await cal.refreshCalendars(root, { fetchImpl: impl, now: NOW })
  assert.equal(res.calendars, 2)
  assert.equal(res.ok, 1)
  assert.ok(res.events > 0)

  const cals = cal.loadCalendars(root)
  assert.ok(cals.find((c) => c.label === 'Good').lastFetchedAt)
  assert.equal(cals.find((c) => c.label === 'Good').lastError, null)
  assert.match(cals.find((c) => c.label === 'Bad').lastError, /500/)

  const cached = cal.loadCachedEvents(root)
  assert.ok(cached.length > 0)
  assert.ok(cached.every((e) => e.calLabel === 'Good'))
})

// --- reconcile into reminders.json -----------------------------------------

test('syncCalendarReminders: adds one reminder per upcoming event, updates on change, prunes vanished', () => {
  const root = tmpVault()

  // a hand-typed reminder must survive every sync untouched
  reminders.saveReminders(root, [{
    id: 1, created: 'x', title: 'Call mum', body: '', eventAt: '2026-09-01T18:00:00.000Z',
    leadMin: 60, notifyAt: '2026-09-01T17:00:00.000Z', status: 'pending', sound: true, source: 'peck'
  }])

  cal.saveCachedEvents(root, [
    { id: 'evt-a', title: 'Design review', start: '2026-09-02T14:00:00.000Z', end: '2026-09-02T15:00:00.000Z', leadMin: 15, calLabel: 'Work', location: 'Room 2', attendees: ['Ana'] },
    { id: 'evt-b', title: 'Lunch', start: '2026-09-03T12:00:00.000Z', end: '2026-09-03T13:00:00.000Z', leadMin: 30, calLabel: 'Personal' }
  ])

  let res = cal.syncCalendarReminders(root, { now: NOW })
  assert.deepEqual(res, { added: 2, updated: 0, removed: 0 })

  let rows = reminders.loadReminders(root)
  assert.equal(rows.length, 3)
  assert.ok(rows.find((r) => r.source === 'peck' && r.title === 'Call mum'), 'hand-typed reminder untouched')
  const a = rows.find((r) => r.eventKey === 'evt-a')
  assert.equal(a.source, 'calendar')
  assert.equal(a.notifyAt, '2026-09-02T13:45:00.000Z') // 15 min before
  assert.match(a.body, /Room 2/)

  // idempotent
  res = cal.syncCalendarReminders(root, { now: NOW })
  assert.deepEqual(res, { added: 0, updated: 0, removed: 0 })
  assert.equal(reminders.loadReminders(root).length, 3)

  // event B moved 1h later -> the reminder is updated in place
  cal.saveCachedEvents(root, [
    { id: 'evt-a', title: 'Design review', start: '2026-09-02T14:00:00.000Z', end: '2026-09-02T15:00:00.000Z', leadMin: 15, calLabel: 'Work' },
    { id: 'evt-b', title: 'Lunch', start: '2026-09-03T13:00:00.000Z', end: '2026-09-03T14:00:00.000Z', leadMin: 30, calLabel: 'Personal' }
  ])
  res = cal.syncCalendarReminders(root, { now: NOW })
  assert.deepEqual(res, { added: 0, updated: 1, removed: 0 })
  assert.equal(reminders.loadReminders(root).find((r) => r.eventKey === 'evt-b').eventAt, '2026-09-03T13:00:00.000Z')

  // event A disappears from the feed -> its still-pending reminder is pruned
  cal.saveCachedEvents(root, [
    { id: 'evt-b', title: 'Lunch', start: '2026-09-03T13:00:00.000Z', end: '2026-09-03T14:00:00.000Z', leadMin: 30, calLabel: 'Personal' }
  ])
  res = cal.syncCalendarReminders(root, { now: NOW })
  assert.deepEqual(res, { added: 0, updated: 0, removed: 1 })
  rows = reminders.loadReminders(root)
  assert.ok(!rows.some((r) => r.eventKey === 'evt-a'))
  assert.equal(rows.length, 2)
})

test('syncCalendarReminders: a notified calendar reminder is kept even if the event vanishes', () => {
  const root = tmpVault()
  reminders.saveReminders(root, [{
    id: 5, created: 'x', title: 'Old standup', body: '', eventAt: '2026-09-01T09:00:00.000Z',
    leadMin: 15, notifyAt: '2026-09-01T08:45:00.000Z', status: 'notified', source: 'calendar', eventKey: 'gone'
  }])
  cal.saveCachedEvents(root, [])
  const res = cal.syncCalendarReminders(root, { now: NOW })
  assert.deepEqual(res, { added: 0, updated: 0, removed: 0 })
  assert.equal(reminders.loadReminders(root).length, 1)
})
