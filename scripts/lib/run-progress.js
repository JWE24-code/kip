// Live progress + telemetry plumbing shared by the long-running CLI passes
// (scripts/hatch-all.js, scripts/groom.js --deep). Wires scripts/lib/telemetry
// into a `<name>-progress.json` file the Kip app polls: a content-free rolling
// activity feed plus the running metrics summary. With traceOn it also
// attaches short response/reasoning previews to the feed and streams full
// records (prompts + responses included) to `<name>-trace.jsonl`. On finish
// the caller writes `<name>-metrics.json` via writeMetrics().
//
// Call telemetry.reset() BEFORE createRunReporter() — reset() clears the
// trace sink this installs.
const fs = require('node:fs')
const telemetry = require('./telemetry')

const ACTIVITY_KEEP = 50
const THROTTLE_MS = 400

function trim (s, n) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n)
}

function createRunReporter ({ dir, progressFile, metricsFile, traceFile, traceOn = false }) {
  let activity = []
  let base = {}
  let lastWrite = 0
  let traceStream = null

  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* best-effort */ }
  if (traceOn && traceFile) {
    try { traceStream = fs.createWriteStream(traceFile, { flags: 'w' }) } catch { /* best-effort */ }
  }

  function write (extra) {
    try {
      fs.writeFileSync(progressFile, JSON.stringify({
        ...base, ...extra, activity, metrics: telemetry.summary(), at: Date.now()
      }))
    } catch { /* progress is best-effort */ }
  }

  function flush (running) {
    lastWrite = Date.now()
    write({ running })
  }

  telemetry.onTrace((rec) => {
    // A non-call event (e.g. the peck router decision, kip#34) — content-free
    // by construction. Push it to the feed as-is (no call-shaped row) and, with
    // traceOn, the trace file.
    if (rec.type) {
      const row = { at: rec.at, label: rec.label || rec.type, ms: 0, ok: true, inTok: 0, outTok: 0 }
      if (rec.reason) row.preview = trim(rec.reason, 200)
      if (traceOn && traceStream) { try { traceStream.write(JSON.stringify(rec) + '\n') } catch { /* best-effort */ } }
      activity.push(row)
      if (activity.length > ACTIVITY_KEEP) activity = activity.slice(-ACTIVITY_KEEP)
      if (Date.now() - lastWrite >= THROTTLE_MS) flush(true)
      return
    }
    const row = {
      at: rec.at,
      phase: rec.phase,
      label: rec.label,
      ms: rec.ms,
      ok: rec.ok,
      inTok: rec.inputTokens || 0,
      outTok: rec.outputTokens || 0
    }
    if (rec.error) row.error = trim(rec.error, 200)
    if (traceOn) {
      if (rec.responseText) row.preview = trim(rec.responseText, 400)
      if (rec.reasoning) row.reasoning = trim(rec.reasoning, 600)
      if (traceStream) { try { traceStream.write(JSON.stringify(rec) + '\n') } catch { /* best-effort */ } }
    }
    activity.push(row)
    if (activity.length > ACTIVITY_KEEP) activity = activity.slice(-ACTIVITY_KEEP)
    if (Date.now() - lastWrite >= THROTTLE_MS) flush(true)
  })

  return {
    /** Merge {done,total,current} (any subset) into the base of every write. */
    setProgress (partial) { base = { ...base, ...partial } },
    /** Write progress now; `running` is stamped in. */
    flush,
    /** Write a terminal error progress record (running:false + error). */
    fail (message) { write({ current: null, running: false, error: String(message) }) },
    /** Write the end-of-run metrics artifact; `extra` is merged in (e.g. {perFile}). */
    writeMetrics (extra = {}) {
      try {
        fs.writeFileSync(metricsFile, JSON.stringify({
          at: Date.now(), summary: telemetry.summary(), entries: telemetry.entries(), ...extra
        }, null, 2))
      } catch { /* best-effort */ }
    },
    /** Close the trace stream, if any. */
    close () { if (traceStream) { try { traceStream.end() } catch { /* best-effort */ } } },
    get activity () { return activity }
  }
}

module.exports = { createRunReporter }
