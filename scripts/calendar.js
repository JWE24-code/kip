#!/usr/bin/env node
// Calendar CLI (kip-app#70) — the ingestion side of calendar integration.
// Subscribe to a live ICS feed; Kip expands upcoming events into the same
// reminders pipeline that a hand-typed reminder uses (prep brief from the
// nest + a lead-time notification).
//
//   node scripts/calendar.js add <ics-url> [--label "Work"] [--lead 15] [--refresh 30] [--json]
//   node scripts/calendar.js list [--json]
//   node scripts/calendar.js remove <id>
//   node scripts/calendar.js enable <id> | disable <id>
//   node scripts/calendar.js refresh [--json]   # fetch every feed, rebuild the cache
//   node scripts/calendar.js sync [--json]      # refresh, then reconcile into reminders.json
//
// Storage: <coop>/.henhouse/calendars.json (the subscription list — ICS URLs
// are bearer secrets), <coop>/.roost/calendar-events.json (the event cache).
// KIP_COOP_ROOT points at the open graph, as with every bundled script.
require('dotenv').config()

const { DEFAULT_VAULT_ROOT } = require('./lib/paths')
const {
  addCalendar, removeCalendar, setCalendarEnabled, loadCalendars,
  loadCachedEvents, refreshCalendars, syncCalendarReminders
} = require('./lib/calendar')

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const flagVal = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
const FLAGS_WITH_VALUES = new Set(['--label', '--lead', '--refresh'])
const positionals = argv.filter((a, i) => !a.startsWith('--') && !FLAGS_WITH_VALUES.has(argv[i - 1]))
const asJson = has('--json')

function out (obj, human) {
  if (asJson) console.log(JSON.stringify(obj))
  else console.log(human)
}

const fmtEventLine = (e) =>
  `${new Date(e.start).toLocaleString()}  ${e.title}${e.calLabel ? `  · ${e.calLabel}` : ''}`

async function main () {
  const root = DEFAULT_VAULT_ROOT
  const cmd = positionals[0] || 'list'

  if (cmd === 'add') {
    const url = positionals[1]
    if (!url) { console.error('usage: calendar.js add <ics-url> [--label ..] [--lead 15] [--refresh 30]'); process.exitCode = 1; return }
    const row = addCalendar(root, {
      url, label: flagVal('--label'), leadMin: flagVal('--lead'), refreshMin: flagVal('--refresh')
    })
    out({ calendar: row }, `Subscribed to "${row.label}" (#${row.id}) — ${row.leadMin} min lead, refresh every ${row.refreshMin} min.`)
    return
  }

  if (cmd === 'remove') {
    const id = positionals[1]
    const gone = removeCalendar(root, id)
    out({ removed: !!gone }, gone ? `Removed calendar #${id}.` : `No calendar #${id}.`)
    if (!gone) process.exitCode = 1
    return
  }

  if (cmd === 'enable' || cmd === 'disable') {
    const id = positionals[1]
    const row = setCalendarEnabled(root, id, cmd === 'enable')
    out({ calendar: row || null }, row ? `${cmd === 'enable' ? 'Enabled' : 'Disabled'} "${row.label}".` : `No calendar #${id}.`)
    if (!row) process.exitCode = 1
    return
  }

  if (cmd === 'refresh' || cmd === 'sync') {
    const res = await refreshCalendars(root)
    let reconciled = null
    if (cmd === 'sync') reconciled = syncCalendarReminders(root)
    const cals = loadCalendars(root)
    const errors = cals.filter((c) => c.lastError).map((c) => `${c.label}: ${c.lastError}`)
    out(
      { ...res, reconciled, errors },
      [`Refreshed ${res.ok}/${res.calendars} calendars — ${res.events} events in the window.`,
        reconciled && `Reminders: +${reconciled.added} ~${reconciled.updated} -${reconciled.removed}.`,
        ...errors.map((e) => `  ⚠ ${e}`)].filter(Boolean).join('\n'))
    return
  }

  // list
  const cals = loadCalendars(root)
  const events = loadCachedEvents(root)
  out(
    { calendars: cals, events },
    (cals.length
      ? cals.map((c) => `#${c.id}  ${c.label}  (${c.enabled === false ? 'disabled' : 'on'}, ${c.leadMin}m lead)` +
          `${c.lastError ? `  ⚠ ${c.lastError}` : c.lastFetchedAt ? `  · last ${new Date(c.lastFetchedAt).toLocaleString()}` : ''}`).join('\n')
      : 'No calendar subscriptions.') +
    (events.length ? `\n\nUpcoming:\n${events.slice(0, 20).map(fmtEventLine).join('\n')}` : ''))
}

main().catch((err) => {
  const msg = (err && err.message) || String(err)
  if (asJson) {
    // stay exit 0 so the caller (electron.wiki run-node-script!) gets the
    // structured error instead of a bare "exited with code 1"
    console.log(JSON.stringify({ error: msg }))
  } else {
    console.error(err.stack || msg)
    process.exitCode = 1
  }
})
