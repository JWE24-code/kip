// Batches preference signals (kip-app#73) and POSTs them to the managed
// backend's /v1/feedback. An entrypoint wires it via
//   const feedback = createFeedbackPoster({ vaultRoot })
//   telemetry.onFeedback(feedback.enqueue)
//   // ... and `await feedback.flush()` once before it exits
// or the electron main process drives `enqueue` straight from its
// kipFeedback IPC.
//
// Rules (from the epic):
//   - kip provider only — enqueue() and flush() no-op otherwise (checked
//     live each time, so switching provider mid-run stops it)
//   - best-effort — never throws into a run; every network error is swallowed
//   - never blocks exit more than ~1s — flush() caps its own wait, the
//     internal timer is unref()'d
//   - closed field set only — no free text can ride along, even if a caller
//     attaches extra keys

const telemetry = require('./telemetry')
const { preferenceSignalsTarget } = require('./preference-signals')

const DEFAULT_FLUSH_MS = 5000
const DEFAULT_FLUSH_BUDGET_MS = 1000

// the ONLY keys that may cross the wire, per signal kind.
const FIELDS_BY_KIND = {
  rating: ['call_id', 'kind', 'score', 'scale'],
  behavior: ['call_id', 'kind', 'behavior', 'edit_bucket']
}

/**
 * Reduce a signal to its closed field set, or null if it isn't a well-formed
 * rating / behavior signal. Anything not in the whitelist (a stray `text`,
 * `prompt`, `note`, …) is dropped here.
 */
function sanitizeSignal (signal) {
  if (!signal || typeof signal !== 'object') return null
  if (typeof signal.call_id !== 'string' || !signal.call_id) return null
  const fields = FIELDS_BY_KIND[signal.kind]
  if (!fields) return null
  const out = {}
  for (const k of fields) if (signal[k] !== undefined) out[k] = signal[k]
  return out
}

function createFeedbackPoster ({
  vaultRoot,
  fetchImpl,
  flushMs = DEFAULT_FLUSH_MS,
  flushBudgetMs = DEFAULT_FLUSH_BUDGET_MS,
  logger = console
} = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a))
  let queue = []
  let timer = null

  const debug = (msg) => { if (logger && typeof logger.debug === 'function') logger.debug(`[feedback] ${msg}`) }

  async function postOne (target, body) {
    try {
      const res = await doFetch(`${target.baseUrl}/v1/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${target.apiKey}`
        },
        body: JSON.stringify(body)
      })
      if (res && !res.ok) debug(`${res.status} for ${body.kind}`)
    } catch (err) {
      debug((err && err.message) || String(err))
    }
  }

  async function drain () {
    if (timer) { clearTimeout(timer); timer = null }
    if (!queue.length) return
    const batch = queue
    queue = []
    const target = preferenceSignalsTarget(vaultRoot)
    if (!target) return // provider changed away from kip / no key — drop
    await Promise.all(batch.map((body) => postOne(target, body)))
  }

  return {
    /** Queue one signal. Silent no-op if malformed or the kip provider isn't active. */
    enqueue (signal) {
      const clean = sanitizeSignal(signal)
      if (!clean) return
      if (!preferenceSignalsTarget(vaultRoot)) return
      queue.push(clean)
      if (!timer) {
        timer = setTimeout(() => { drain().catch(() => {}) }, flushMs)
        if (timer.unref) timer.unref() // must never keep a CLI process alive
      }
    },

    /** Flush now, capped at flushBudgetMs so a slow backend can't delay exit. */
    async flush () {
      await Promise.race([
        drain().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, flushBudgetMs))
      ])
    },

    /** Drop everything pending and cancel the timer. */
    stop () {
      if (timer) { clearTimeout(timer); timer = null }
      queue = []
    },

    get pending () { return queue.length }
  }
}

/**
 * The one line a CLI entrypoint needs: create a poster, register it as
 * telemetry's feedback sink, and flush it (capped) on `beforeExit`. Call it
 * right after telemetry.reset() — reset() clears the sink. Returns the poster
 * (mostly for tests; entrypoints can ignore it).
 *
 * `beforeExit` doesn't fire on process.exit() or an uncaught throw — that's
 * acceptable for a best-effort signal.
 */
function installFeedbackPoster (opts = {}) {
  const poster = createFeedbackPoster(opts)
  telemetry.onFeedback(poster.enqueue)
  let flushed = false
  process.once('beforeExit', () => {
    if (flushed) return
    flushed = true
    poster.flush().catch(() => {})
  })
  return poster
}

module.exports = { createFeedbackPoster, installFeedbackPoster, sanitizeSignal }
