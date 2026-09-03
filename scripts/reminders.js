#!/usr/bin/env node
// Reminders CLI — Kip's time-aware layer. A reminder is a future event plus a
// lead time; Kip notifies you before it, with prep pulled from the nest.
//
//   node scripts/reminders.js add "meeting with Acme friday at 15h" [--lead 60] [--json]
//   node scripts/reminders.js list [--json]
//   node scripts/reminders.js cancel <id>
//   node scripts/reminders.js --due --json     # the app scheduler's call
//   node scripts/reminders.js --check --json   # count + next notify time, no writes
//
// Store: <coop>/reminders.json (KIP_COOP_ROOT points at the open graph, same
// as every other bundled script — see scripts/lib/paths.js).
//
// --due: for every pending reminder whose notify time has arrived, retrieve
// related nest pages, draft a short prep brief (one LLM call; degrades to
// pages-only with no provider), mark it notified, log it, and print the fired
// reminders as JSON for electron.wiki to notify on.
require('dotenv').config()
const path = require('node:path')

const { describeProvider } = require('./lib/llm')
const { searchPages, appendLog } = require('./lib/roost')
const { generateMeetingPrep } = require('./lib/prompts')
const { DEFAULT_VAULT_ROOT } = require('./lib/paths')
const telemetry = require('./lib/telemetry')
const { createRunReporter } = require('./lib/run-progress')
const { installFeedbackPoster } = require('./lib/feedback-poster')
const {
  addReminder, listReminders, cancelReminder, setReminderSound, dueReminders, markNotified,
  loadReminders, describeReminder, fmtWhen, fmtLead
} = require('./lib/reminders')

const ROOST_DIR = path.join(DEFAULT_VAULT_ROOT, '.roost')
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const flagVal = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
const VALUE_FLAGS = new Set(['--lead', '--title', '--when', '--event-at', '--source'])
const positionals = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]))
const asJson = has('--json')
const RELATED_LIMIT = 6

function out (obj, human) {
  if (asJson) console.log(JSON.stringify(obj))
  else console.log(human)
}

/** Retrieve related nest pages + (optionally) an LLM prep brief for a reminder. */
async function buildPrep (reminder) {
  const query = [reminder.title, reminder.body].filter(Boolean).join(' ')
  const hits = searchPages(query, { limit: RELATED_LIMIT }, DEFAULT_VAULT_ROOT)
  const relatedSlugs = hits.map((h) => h.slug)
  const pages = hits.map((h) => ({ slug: h.slug, type: null, content: h.snippet || h.summary || '' }))
  const brief = await generateMeetingPrep(reminder, pages, DEFAULT_VAULT_ROOT)
  const context = brief ||
    (relatedSlugs.length
      ? 'Related pages:\n' + relatedSlugs.map((s) => `- [[${s}]]`).join('\n')
      : 'No related pages in the nest yet.')
  return { relatedSlugs, context }
}

async function runDue () {
  const due = dueReminders(DEFAULT_VAULT_ROOT, new Date())
  if (!due.length) { out({ fired: [] }, 'Nothing due.'); return }

  telemetry.reset()
  installFeedbackPoster({ vaultRoot: DEFAULT_VAULT_ROOT })
  const reporter = createRunReporter({
    dir: ROOST_DIR,
    progressFile: path.join(ROOST_DIR, 'reminders-progress.json'),
    metricsFile: path.join(ROOST_DIR, 'reminders-metrics.json'),
    traceFile: path.join(ROOST_DIR, 'reminders-trace.jsonl'),
    traceOn: has('--trace') || process.env.KIP_REMINDER_TRACE === '1'
  })
  reporter.setProgress({ phase: 'reminders', total: due.length })
  reporter.flush(true)

  const fired = []
  let done = 0
  for (const r of due) {
    const { relatedSlugs, context } = await buildPrep(r)
    const saved = markNotified(DEFAULT_VAULT_ROOT, r.id, { relatedSlugs, context })
    appendLog('reminder', r.title, relatedSlugs, DEFAULT_VAULT_ROOT)
    fired.push(saved)
    reporter.setProgress({ done: ++done, current: r.title })
    reporter.flush(true)
  }
  reporter.flush(false)
  reporter.writeMetrics()
  reporter.close()
  out({ fired }, fired.map((r) => `⏰ ${r.title} — ${fmtWhen(r.eventAt)}`).join('\n'))
}

async function main () {
  const cmd = has('--due') ? 'due' : has('--check') ? 'check' : (positionals[0] || 'list')

  if (cmd === 'due') { console.error(describeProvider()); return runDue() }

  if (cmd === 'check') {
    const pending = loadReminders(DEFAULT_VAULT_ROOT).filter((r) => r.status === 'pending')
    const next = pending.map((r) => r.notifyAt).sort()[0] || null
    out({ pending: pending.length, nextNotifyAt: next }, `${pending.length} pending${next ? `, next ${fmtWhen(next)}` : ''}`)
    return
  }

  if (cmd === 'add') {
    const text = positionals.slice(1).join(' ').trim()
    const title = flagVal('--title')
    const eventAt = flagVal('--event-at')
    const when = flagVal('--when')
    const source = flagVal('--source') || 'cli'
    if (!text && !title && !eventAt && !when) { console.error('usage: reminders.js add "<what and when>" [--lead 60] [--silent]'); process.exitCode = 1; return }
    const row = addReminder(DEFAULT_VAULT_ROOT, {
      text,
      ...(title ? { title } : {}),
      ...(when ? { when } : {}),
      ...(eventAt ? { eventAt } : {}),
      lead: flagVal('--lead'),
      source,
      ...(has('--silent') ? { sound: false } : {})
    })
    out({ reminder: row }, describeReminder(row))
    return
  }

  if (cmd === 'cancel') {
    const id = positionals[1]
    const row = cancelReminder(DEFAULT_VAULT_ROOT, id)
    out({ canceled: !!row, reminder: row || null }, row ? `Canceled "${row.title}".` : `No reminder #${id}.`)
    if (!row) process.exitCode = 1
    return
  }

  if (cmd === 'mute' || cmd === 'unmute') {
    const id = positionals[1]
    const row = setReminderSound(DEFAULT_VAULT_ROOT, id, cmd === 'unmute')
    out({ reminder: row || null },
      row ? `${cmd === 'mute' ? 'Muted' : 'Unmuted'} "${row.title}".` : `No reminder #${id}.`)
    if (!row) process.exitCode = 1
    return
  }

  // list
  const rows = listReminders(DEFAULT_VAULT_ROOT, { upcomingOnly: !has('--all') })
  out({ reminders: rows },
    rows.length
      ? rows.map((r) => `#${r.id}  ${fmtWhen(r.eventAt)}  ${r.title}  ` +
          `(${r.status}, ${fmtLead(r.leadMin)} before${r.sound === false ? ', silent' : ''})`).join('\n')
      : 'No reminders.')
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err))
  process.exitCode = 1
})
