#!/usr/bin/env node
// CLI for the "Peck" workflow (coop/schema.md) — a thin wrapper around
// scripts/lib/peck.js's peckTurn(): argv parsing, printing, and (for a
// question) the interactive confirm-before-filing prompt. No workflow logic
// lives here.
//
// Usage: node scripts/peck.js "a question — or a fact to remember" [--trace]
//   A question is answered (and you're asked whether to file the answer).
//   A statement is filed straight into the nest and reported.
//   --trace (or KIP_PECK_TRACE=1) streams every LLM + skill call to
//   <coop>/.roost/peck-trace.jsonl; .roost/peck-metrics.json is always written.
require('dotenv').config()
const path = require('node:path')
const readline = require('node:readline/promises')

const { appendLog } = require('./lib/roost')
const { peckTurn, fileAnswerToNest } = require('./lib/peck')
const { describeProvider } = require('./lib/llm')
const { DEFAULT_VAULT_ROOT } = require('./lib/paths')
const telemetry = require('./lib/telemetry')
const { createRunReporter } = require('./lib/run-progress')

const ROOST_DIR = path.join(DEFAULT_VAULT_ROOT, '.roost')
const traceOn = process.argv.includes('--trace') || process.env.KIP_PECK_TRACE === '1'

async function main () {
  const input = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ').trim()
  if (!input) {
    console.error('Usage: node scripts/peck.js "a question — or a fact to remember" [--trace]')
    process.exitCode = 1
    return
  }

  const vaultRoot = DEFAULT_VAULT_ROOT
  console.error(describeProvider())

  telemetry.reset()
  const reporter = createRunReporter({
    dir: ROOST_DIR,
    progressFile: path.join(ROOST_DIR, 'peck-progress.json'),
    metricsFile: path.join(ROOST_DIR, 'peck-metrics.json'),
    traceFile: path.join(ROOST_DIR, 'peck-trace.jsonl'),
    traceOn
  })
  reporter.flush(true)

  let result
  try {
    result = await peckTurn(input, { fileToNest: false, vaultRoot })
    reporter.flush(false)
    reporter.writeMetrics()
    reporter.close()
  } catch (err) {
    reporter.fail((err && err.message) || String(err))
    throw err
  }

  if (result.intent === 'statement') {
    console.log(result.note || (result.learned ? 'Recorded.' : 'Nothing new to record.'))
    for (const p of result.pages || []) {
      console.log(`  ${p.action === 'create' ? 'Created' : 'Updated'} nest page: ${p.path}`)
    }
    return
  }

  if (!result.answer) {
    console.log('No matching pages found in the nest for this question.')
    return
  }

  for (const s of result.steps || []) {
    console.error(`  · ${s.ok ? 'ran' : 'failed'} ${s.skill} (${(s.ms / 1000).toFixed(1)}s)`)
  }
  console.log(`\n${result.answer}\n`)

  if (result.candidateSlugs.length === 0) {
    // nothing to file an answer against, and nothing to log
    return
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  let reply
  try {
    reply = (await rl.question('File this answer into the nest as a new page? (y/n) ')).trim().toLowerCase()
  } finally {
    rl.close()
  }

  if (reply !== 'y' && reply !== 'yes') {
    appendLog('peck', input, result.candidateSlugs, vaultRoot)
    return
  }

  const filed = await fileAnswerToNest(input, result.answer, result.candidateSlugs, vaultRoot)
  console.log(`${filed.action === 'create' ? 'Created' : 'Updated'} nest page: ${filed.path}`)
}

main().catch((err) => {
  // Provider-agnostic on purpose: which LLM backend is active is a runtime
  // choice (see scripts/lib/llm.js), so there's no single SDK's typed error
  // hierarchy to catch against. Each provider's own errors are already
  // descriptive.
  console.error(err.message || err)
  process.exitCode = 1
})
