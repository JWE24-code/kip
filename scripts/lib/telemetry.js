// Per-process LLM-call telemetry for the Kip scripts. Every callLLM() in
// scripts/lib/llm.js records one entry here — timing, token counts, ok/fail —
// so a hatch/peck/groom run can report where its time actually went.
//
// Content-free by default: summary() and entries() expose only counts,
// durations, and token numbers — never a prompt or a response. The actual
// text goes ONLY to an opt-in trace sink (onTrace); scripts/hatch-all.js
// wires that to <coop>/.roost/hatch-trace.jsonl when run with --trace. This
// split is deliberate — see coop/schema.md's personal-data rule.

let records = []
let traceSink = null
let feedbackSink = null
let phaseStack = []

/** Clears everything, including the trace and feedback sinks. Call at run start. */
function reset () {
  records = []
  phaseStack = []
  traceSink = null
  feedbackSink = null
}

function currentPhase () {
  return phaseStack.length ? phaseStack[phaseStack.length - 1] : null
}

/** Runs fn with `label` as the active phase for any record() calls it makes. */
async function withPhase (label, fn) {
  phaseStack.push(label)
  try {
    return await fn()
  } finally {
    phaseStack.pop()
  }
}

/** hatch:generate:<type> -> hatch:generate; skill:<name> -> skill; foo:retry -> foo; else the label as-is. */
function phaseFromLabel (label) {
  const base = String(label).replace(/:retry$/, '')
  if (base.startsWith('skill:')) return 'skill'
  const m = base.match(/^(hatch:generate):/)
  return m ? m[1] : base
}

/**
 * Records one LLM call. `rec` may carry system/prompt/responseText/reasoning
 * for the trace sink — those are stripped from what's kept in `records` and
 * never surface in summary()/entries().
 */
function record (rec) {
  const { system, prompt, responseText, reasoning, ...lean } = rec
  const phase = rec.phase ||
    (rec.label ? phaseFromLabel(rec.label) : null) ||
    currentPhase() ||
    'other'
  const entry = { at: Date.now(), ...lean, phase }
  records.push(entry)

  if (traceSink) {
    try {
      traceSink({ ...entry, system, prompt, responseText, reasoning })
    } catch { /* trace is best-effort — never let it break a run */ }
  }
  return entry
}

/** Register (or clear, with null) the full-text trace sink. */
function onTrace (fn) {
  traceSink = fn || null
}

/**
 * Register (or clear, with null) the preference-signal sink (kip-app#73).
 * Separate from onTrace: this one carries ONLY closed enum/int signals —
 * `{ call_id, kind, score?/scale?/behavior?/edit_bucket? }` — never prompt,
 * response, or edit text. Wired by the entrypoints to lib/feedback-poster.
 */
function onFeedback (fn) {
  feedbackSink = fn || null
}

/**
 * Emit one content-free preference signal. Best-effort and fire-and-forget:
 * a missing or throwing sink never disturbs the run. No-op unless a sink is
 * registered (which lib/feedback-poster only does for the kip provider).
 */
function sendFeedback (signal) {
  if (!feedbackSink || !signal) return
  try {
    feedbackSink(signal)
  } catch { /* best-effort — never let a signal break a run */ }
}

function num (x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0
}

/** Round a USD sum to 8 decimals (0.01 micro-cent) — avoids float-noise in JSON. */
function roundUsd (x) {
  return Math.round(x * 1e8) / 1e8
}

/** Content-free aggregate of every recorded call this run. */
function summary () {
  const byPhase = {}
  let wallLlmMs = 0
  let okCalls = 0
  let failedCalls = 0
  let input = 0
  let output = 0
  let costUsd = 0

  for (const e of records) {
    wallLlmMs += num(e.ms)
    input += num(e.inputTokens)
    output += num(e.outputTokens)
    costUsd += num(e.costUsd)
    if (e.ok) okCalls++
    else failedCalls++

    const p = byPhase[e.phase] ||
      (byPhase[e.phase] = { calls: 0, ms: 0, avgMs: 0, inputTokens: 0, outputTokens: 0, failures: 0, costUsd: 0 })
    p.calls++
    p.ms += num(e.ms)
    p.inputTokens += num(e.inputTokens)
    p.outputTokens += num(e.outputTokens)
    p.costUsd += num(e.costUsd)
    if (!e.ok) p.failures++
  }
  for (const p of Object.values(byPhase)) {
    p.avgMs = p.calls ? Math.round(p.ms / p.calls) : 0
    p.costUsd = roundUsd(p.costUsd)
  }

  const slowestCalls = [...records]
    .sort((a, b) => num(b.ms) - num(a.ms))
    .slice(0, 5)
    .map((e) => ({
      label: e.label || e.phase,
      phase: e.phase,
      ms: num(e.ms),
      model: e.model || null,
      outputTokens: num(e.outputTokens)
    }))

  return {
    totalCalls: records.length,
    okCalls,
    failedCalls,
    wallLlmMs,
    tokens: { input, output },
    costUsd: roundUsd(costUsd),
    byPhase,
    slowestCalls
  }
}

/** The raw per-call list, content-free (shallow copies). */
function entries () {
  return records.map((e) => ({ ...e }))
}

module.exports = { reset, withPhase, record, onTrace, onFeedback, sendFeedback, currentPhase, summary, entries }
