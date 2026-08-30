#!/usr/bin/env node
// Non-interactive JSON sibling of scripts/peck.js — the Kip app's Peck panel
// shells out to this (electron.wiki). Runs one Peck turn WITHOUT any prompt:
// classify the input, then answer it or capture it as a fact. Answers are NOT
// filed back into the nest from here (fileToNest: false); a told fact always
// is. No workflow logic lives here; see scripts/lib/peck.js.
//
// Prints the peckTurn() result as JSON to stdout; the provider banner goes to
// stderr so stdout stays pure JSON for the caller.
//   { intent: "question",  answer, citedSlugs, candidateSlugs, steps }
//   { intent: "statement", learned, note, pages?, candidateSlugs }
//
// `steps` (question only) is what the skills tool loop ran, if anything:
//   [{ skill, input, ok, ms, outputPreview }, ...].
//
// During the turn it writes <coop>/.roost/peck-progress.json (a content-free
// rolling activity feed + running metrics, for the panel to poll) and, on
// completion, <coop>/.roost/peck-metrics.json. With --trace (or
// KIP_PECK_TRACE=1) it also streams every LLM + skill call, full I/O included,
// to <coop>/.roost/peck-trace.jsonl.
//
// Usage: node scripts/chat.js "your question — or a fact to remember" [--trace]
//   (set KIP_COOP_ROOT to point at a graph other than this repo's ./coop)
require('dotenv').config()
const path = require('node:path')

const { describeProvider } = require('./lib/llm')
const { peckTurn } = require('./lib/peck')
const { DEFAULT_VAULT_ROOT } = require('./lib/paths')
const telemetry = require('./lib/telemetry')
const { createRunReporter } = require('./lib/run-progress')
const { installFeedbackPoster } = require('./lib/feedback-poster')

const ROOST_DIR = path.join(DEFAULT_VAULT_ROOT, '.roost')
const traceOn = process.argv.includes('--trace') || process.env.KIP_PECK_TRACE === '1'

async function main () {
  const input = process.argv.slice(2).find((a) => !a.startsWith('--'))
  if (!input || !input.trim()) {
    console.error('Usage: node scripts/chat.js "your question — or a fact to remember" [--trace]')
    process.exitCode = 1
    return
  }

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

  try {
    const result = await peckTurn(input, { fileToNest: false, vaultRoot: DEFAULT_VAULT_ROOT })
    reporter.flush(false)
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
