#!/usr/bin/env node
// Non-interactive JSON sibling of scripts/peck.js — the Kip app's Peck panel
// shells out to this (electron.wiki). Runs one Peck turn WITHOUT any prompt:
// classify the input, then answer it or capture it as a fact. Answers are NOT
// filed back into the nest from here (fileToNest: false); a told fact always
// is. No workflow logic lives here; see scripts/lib/peck.js.
//
// Prints the peckTurn() result as JSON to stdout; the provider banner goes to
// stderr so stdout stays pure JSON for the caller.
//   { intent: "question",  answer, sources, citedSlugs, candidateSlugs, steps, callId, arenaId }
//   { intent: "statement", learned, note, pages?, candidateSlugs }
//
// `answer` is clean prose (no [[wikilinks]]); `sources` is the source list
// it leaned on, as [{ slug, title }] in citation order. `citedSlugs` is the
// same set as bare slugs.
//
// callId / arenaId are the managed backend's ids for the answer call (both
// null on any other provider). arenaId is set only for a --arena-compare-to
// regenerate; a verdict on it goes back via the app's :kipArena IPC.
//
// `steps` (question only) is what the skills tool loop ran, if anything:
//   [{ skill, input, ok, ms, outputPreview }, ...].
//
// During the turn it writes <coop>/.roost/peck-progress.json (a rolling
// activity feed + running metrics + the accumulating answer as `partialAnswer`
// while it streams, for the panel to poll) and, on completion,
// <coop>/.roost/peck-metrics.json. With --trace (or
// KIP_PECK_TRACE=1) it also streams every LLM + skill call, full I/O included,
// to <coop>/.roost/peck-trace.jsonl.
//
// Usage: node scripts/chat.js "your question — or a fact to remember" [--trace]
//        [--arena-compare-to <callId>] [--history '<json>']
//        [--file-answer '<json>'] [--depth quick|full]
//   --history: [{ "role": "user"|"assistant", "text": "…" }] oldest→newest, a
//     short buffer of recent turns so a follow-up can resolve what it refers to.
//   --file-answer (kip-app#112): do NOT run a turn — file an already-settled
//     answer into the nest. Takes
//     '{ "question": "…", "answer": "…", "candidateSlugs": ["…"] }' and calls
//     fileAnswerToNest with log:false, because the turn's `peck` clucks row was
//     already written at ask time. Prints the resolvePage result as JSON
//     ({ action, slug, path, ... }). This is the app's "file into the nest"
//     control; the CLI's interactive y/n prompt remains the other way in.
//   (set KIP_COOP_ROOT to point at a graph other than this repo's ./coop)
require('dotenv').config()
const path = require('node:path')

const { describeProvider } = require('./lib/llm')
const { peckTurn, fileAnswerToNest } = require('./lib/peck')
const { appendLog } = require('./lib/roost')
const { DEFAULT_VAULT_ROOT } = require('./lib/paths')
const telemetry = require('./lib/telemetry')
const { createRunReporter } = require('./lib/run-progress')
const { installFeedbackPoster } = require('./lib/feedback-poster')

const ROOST_DIR = path.join(DEFAULT_VAULT_ROOT, '.roost')
const traceOn = process.argv.includes('--trace') || process.env.KIP_PECK_TRACE === '1'

const VALUE_FLAGS = new Set(['--arena-compare-to', '--history', '--file-answer', '--depth'])

// How often the accumulating answer is written to peck-progress.json while it
// streams. Fast enough to read as live, slow enough not to thrash the file the
// panel polls.
const STREAM_WRITE_MS = 120

/** True while the buffer is still empty or could be the opening of a control
 *  token the answer model emits — a `<use_skill …>` tool call or `NO_ANSWER`
 *  (the "not in the nest" signal peck.js catches to fall back to a web search).
 *  Suppress the partial bubble until the text diverges into real prose. */
function looksLikeControlToken (text) {
  const s = String(text || '').replace(/^\s+/, '').toLowerCase()
  if (!s) return true
  // a <use_skill> tag: '<' is rare at the start of a real answer, so match it
  // as a prefix freely.
  if (s.startsWith('<use_skill') || '<use_skill'.startsWith(s.slice(0, 10))) return true
  // NO_ANSWER: 'no' is a plausible real answer, so only hold back while the
  // buffer is still a whitespace-free prefix of the token.
  return !/\s/.test(s) && 'no_answer'.startsWith(s)
}

async function main () {
  const args = process.argv.slice(2)

  // Post-hoc file-back (kip-app#112): no turn, no stream, just the write.
  const faIdx = args.indexOf('--file-answer')
  if (faIdx >= 0) {
    let payload = null
    try {
      payload = JSON.parse(args[faIdx + 1] || 'null')
    } catch { /* falls through to the usage error below */ }
    if (!payload || typeof payload.question !== 'string' || typeof payload.answer !== 'string') {
      console.error('Usage: --file-answer \'{"question": "…", "answer": "…", "candidateSlugs": ["…"]}\'')
      process.exitCode = 1
      return
    }
    const result = await fileAnswerToNest(
      payload.question,
      payload.answer,
      Array.isArray(payload.candidateSlugs) ? payload.candidateSlugs : [],
      DEFAULT_VAULT_ROOT,
      { log: false } // the turn's `peck` row was written at ask time
    )
    console.log(JSON.stringify({ filed: true, ...result }))
    return
  }

  const input = args.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1]))
  if (!input || !input.trim()) {
    console.error('Usage: node scripts/chat.js "your question — or a fact to remember" [--trace] [--arena-compare-to <callId>] [--history <json>]')
    process.exitCode = 1
    return
  }
  // A regenerate on the managed backend (kip-app#73): re-answer this question
  // as arena candidate B against the first answer's callId.
  const acIdx = args.indexOf('--arena-compare-to')
  const arenaCompareToCallId = acIdx >= 0 ? args[acIdx + 1] : null

  // A short buffer of recent Peck turns for follow-up context (kip-app#82) —
  // [{ role: "user"|"assistant", text }], oldest→newest, clipped by the app.
  const hIdx = args.indexOf('--history')
  let history = []
  if (hIdx >= 0 && args[hIdx + 1]) {
    try {
      const parsed = JSON.parse(args[hIdx + 1])
      if (Array.isArray(parsed)) history = parsed
    } catch { /* malformed history — answer without it */ }
  }

  // Answer-depth control (epic #38 track #36): 'quick' = nest-only (no skills,
  // no web); anything else (or absent) = the full multi-source path.
  const dIdx = args.indexOf('--depth')
  const depth = dIdx >= 0 && args[dIdx + 1] === 'quick' ? 'quick' : null

  console.error(describeProvider())

  // No mutex here (unlike hatch-all.js): a Peck turn only reads the nest and,
  // for a filed answer, does one resolvePage() — turns don't race on page
  // creation or the DB the way a bulk hatch does.
  telemetry.reset()
  installFeedbackPoster({ vaultRoot: DEFAULT_VAULT_ROOT })
  const reporter = createRunReporter({
    dir: ROOST_DIR,
    progressFile: path.join(ROOST_DIR, 'peck-progress.json'),
    metricsFile: path.join(ROOST_DIR, 'peck-metrics.json'),
    traceFile: path.join(ROOST_DIR, 'peck-trace.jsonl'),
    traceOn
  })
  reporter.setProgress({ phase: 'peck' })
  reporter.flush(true)

  // Stream the answer into peck-progress.json as `partialAnswer` so the panel
  // can render it live. `first` resets the buffer at the start of every LLM
  // turn (the skills loop streams each turn); partial `<use_skill>` tags are
  // held back until the text proves to be prose.
  let streamBuf = ''
  let lastStreamWrite = 0
  const onStream = (chunk, first) => {
    if (first) streamBuf = ''
    streamBuf += chunk
    if (looksLikeControlToken(streamBuf)) return
    const now = Date.now()
    if (now - lastStreamWrite < STREAM_WRITE_MS) return
    lastStreamWrite = now
    reporter.setProgress({ partialAnswer: streamBuf.replace(/^\s+/, '') })
    reporter.flush(true)
  }

  try {
    const result = await peckTurn(input, { fileToNest: false, vaultRoot: DEFAULT_VAULT_ROOT, arenaCompareToCallId, history, onStream, depth })
    reporter.setProgress({ partialAnswer: null })
    reporter.flush(false)
    // The audit row the CLI writes but the app path never did (kip-app#112):
    // a question turn leaves one `peck` entry with its candidate slugs, so
    // asked-but-never-kept questions are visible in the coop's activity.
    // Statements log their own `told` row; reminders file nothing; a
    // regenerate is the same question again, not a new one. The later
    // --file-answer write uses log:false — no second row.
    if (result && result.intent === 'question' && !arenaCompareToCallId) {
      appendLog('peck', input, result.candidateSlugs || [], DEFAULT_VAULT_ROOT)
    }
    reporter.writeMetrics()
    reporter.close()
    console.log(JSON.stringify(result))
  } catch (err) {
    reporter.fail((err && err.message) || String(err))
    throw err
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err))
  process.exitCode = 1
})
