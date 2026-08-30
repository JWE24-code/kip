#!/usr/bin/env node
// CLI for the "Hatch sources" workflow: turns every new-or-changed file
// in eggs/, journals/ and pages/ into nest pages, with NO per-file review.
// The Kip app's Hatch modal shells out to this (electron.wiki). No workflow
// logic lives here; see scripts/lib/hatch.js.
//
//   node scripts/hatch-all.js --preview        -> JSON of what a run would touch (no LLM calls)
//   node scripts/hatch-all.js [--limit N]      -> hatch up to N pending files (default 10), print JSON summary
//   node scripts/hatch-all.js --limit N --trace   -> also record full prompts/responses to .roost/hatch-trace.jsonl
//   node scripts/hatch-all.js --limit N --classic -> old path: one propose call + one generate call per page
//                                                    (default is combined: one LLM call per file). Also KIP_HATCH_CLASSIC=1.
//
// During a run it writes <coop>/.roost/hatch-progress.json continuously
// ({done, total, current, activity, metrics}) for the app to poll, and on
// completion writes <coop>/.roost/hatch-metrics.json (per-phase / per-call /
// per-file timing + token counts — content-free). With --trace (or
// KIP_HATCH_TRACE=1) it additionally streams every LLM call, prompt and
// response included, to <coop>/.roost/hatch-trace.jsonl. The provider banner
// and per-file progress go to stderr; stdout stays pure JSON for the caller.
// Exits non-zero only on a total failure (e.g. no provider configured), not
// when individual sources fail — those show up in the `failed` array.
//
// Set KIP_COOP_ROOT to point at a graph other than this repo's ./coop.
require('dotenv').config()

const fs = require('node:fs')
const path = require('node:path')
const { describeProvider } = require('./lib/llm')
const { pendingSourcesSummary, hatchAllSources, proposeNextPending, commitReviewedPlan } = require('./lib/hatch')
const { DEFAULT_VAULT_ROOT } = require('./lib/paths')
const telemetry = require('./lib/telemetry')
const { createRunReporter } = require('./lib/run-progress')
const { installFeedbackPoster } = require('./lib/feedback-poster')

const ROOST_DIR = path.join(DEFAULT_VAULT_ROOT, '.roost')
const PROGRESS_FILE = path.join(ROOST_DIR, 'hatch-progress.json')
const METRICS_FILE = path.join(ROOST_DIR, 'hatch-metrics.json')
const TRACE_FILE = path.join(ROOST_DIR, 'hatch-trace.jsonl')
const LOCK_FILE = path.join(ROOST_DIR, 'hatch.lock')
// A run whose lock hasn't been touched in this long is assumed dead (crashed
// without releasing) and can be taken over. onProgress refreshes it per file,
// so this is "time since the last file finished", not "since the run started".
const LOCK_STALE_MS = 15 * 60 * 1000

const traceOn = process.argv.includes('--trace') || process.env.KIP_HATCH_TRACE === '1'
const combined = !(process.argv.includes('--classic') || process.env.KIP_HATCH_CLASSIC === '1')

let reporter = null

/** Whole-coop mutex: only one hatch run at a time (they'd race on page creation + the DB). */
function acquireLock () {
  try {
    const { at } = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))
    if (at && Date.now() - at < LOCK_STALE_MS) return false
  } catch { /* missing or unreadable — take it */ }
  fs.mkdirSync(ROOST_DIR, { recursive: true })
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }))
  return true
}
function touchLock () {
  try { fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() })) } catch {}
}
function releaseLock () {
  try { fs.rmSync(LOCK_FILE, { force: true }) } catch {}
}

function parseLimit () {
  const i = process.argv.indexOf('--limit')
  if (i === -1) return undefined
  const n = Number(process.argv[i + 1])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

function parseKeep () {
  const i = process.argv.indexOf('--keep')
  if (i === -1) return null
  try { const v = JSON.parse(process.argv[i + 1]); return Array.isArray(v) ? v : null } catch { return null }
}
function parseSkip () {
  const i = process.argv.indexOf('--skip')
  const n = i === -1 ? 0 : Number(process.argv[i + 1])
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

async function main () {
  if (process.argv.includes('--preview')) {
    console.log(JSON.stringify(pendingSourcesSummary(DEFAULT_VAULT_ROOT)))
    return
  }

  if (!acquireLock()) {
    console.error('Another hatch run is already in progress for this coop.')
    process.exitCode = 1
    return
  }

  // "Review before writing" — one file at a time. Each call does a single
  // step (propose OR commit) and exits; the app drives the loop.
  if (process.argv.includes('--propose-next')) {
    try {
      console.error(describeProvider())
      const out = await proposeNextPending(DEFAULT_VAULT_ROOT, {
        ...(parseLimit() ? { limit: parseLimit() } : {}),
        skip: parseSkip(),
        combined
      })
      console.log(JSON.stringify(out))
    } finally { releaseLock() }
    return
  }
  if (process.argv.includes('--commit-next')) {
    try {
      const out = await commitReviewedPlan(DEFAULT_VAULT_ROOT, { keepSlugs: parseKeep() })
      console.log(JSON.stringify(out))
    } finally { releaseLock() }
    return
  }

  telemetry.reset()
  installFeedbackPoster({ vaultRoot: DEFAULT_VAULT_ROOT })
  reporter = createRunReporter({
    dir: ROOST_DIR, progressFile: PROGRESS_FILE, metricsFile: METRICS_FILE, traceFile: TRACE_FILE, traceOn
  })

  try {
    console.error(describeProvider())
    console.error(`  mode: ${combined ? 'combined (1 call/file)' : 'classic (1 + N calls/file)'}`)

    const limit = parseLimit()
    reporter.setProgress({ done: 0, total: null, current: null })
    reporter.flush(true)

    const summary = await hatchAllSources(DEFAULT_VAULT_ROOT, {
      combined,
      ...(limit ? { limit } : {}),
      onProgress: (p) => {
        touchLock()
        reporter.setProgress({ done: p.done, total: p.total, current: p.current })
        reporter.flush(true)
        if (p.current) console.error(`  [${p.done + 1}/${p.total}] ${p.current}`)
      }
    })

    const finished = summary.hatched.length + summary.failed.length
    reporter.setProgress({ done: finished, total: finished, current: null })
    reporter.flush(false)

    const perFile = [
      ...summary.hatched.map((h) => ({ source: h.source, kind: h.kind, ms: h.ms || 0, ok: true })),
      ...summary.failed.map((f) => ({ source: f.source, ms: f.ms || 0, ok: false, error: f.error }))
    ].sort((a, b) => b.ms - a.ms)
    reporter.writeMetrics({ perFile })
    reporter.close()

    const metrics = telemetry.summary()
    for (const { source, kind, results } of summary.hatched) {
      console.error(`  ok   [${kind}] ${source} — ${results.map((r) => `${r.action} ${r.slug}`).join(', ')}`)
    }
    for (const { source, error } of summary.failed) {
      console.error(`  FAIL ${source} — ${error}`)
    }
    if (summary.remaining) console.error(`  ${summary.remaining} file(s) still pending — run again for the next batch`)
    console.error(`  ${metrics.totalCalls} LLM call(s), ${Math.round(metrics.wallLlmMs / 1000)}s total` +
      (metrics.failedCalls ? `, ${metrics.failedCalls} failed` : ''))

    console.log(JSON.stringify({ ...summary, metrics }))
  } finally {
    releaseLock()
  }
}

main().catch((err) => {
  if (reporter) reporter.fail(err && err.message || err)
  console.error(err.stack || err.message || String(err))
  process.exitCode = 1
})
