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

const debugWith = (logger) => (msg) => {
  if (logger && typeof logger.debug === 'function') logger.debug(`[feedback] ${msg}`)
}

/** POST one sanitized body to {baseUrl}/v1/feedback. Never throws; resolves
 *  true on a 2xx, false otherwise. */
async function postBody (target, body, doFetch, debug) {
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
    return !!(res && res.ok)
  } catch (err) {
    debug((err && err.message) || String(err))
    return false
  }
}

/**
 * One-shot: sanitize + POST a single signal. For the electron main process's
 * kipFeedback IPC — a rating click or a debounced behaviour event doesn't
 * need batching. Never throws; resolves { ok: boolean }. A malformed signal
 * or a non-kip provider resolves { ok: false } without a request.
 */
async function postFeedback (signal, { vaultRoot, fetchImpl, logger = console } = {}) {
  const clean = sanitizeSignal(signal)
  if (!clean) return { ok: false }
  const target = preferenceSignalsTarget(vaultRoot)
  if (!target) return { ok: false }
  const doFetch = fetchImpl || ((...a) => fetch(...a))
  return { ok: await postBody(target, clean, doFetch, debugWith(logger)) }
}

function createFeedbackPoster ({
  vaultRoot,
  fetchImpl,
  flushMs = DEFAULT_FLUSH_MS,
  flushBudgetMs = DEFAULT_FLUSH_BUDGET_MS,
  logger = console
} = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a))
  const debug = debugWith(logger)
  let queue = []
  let timer = null

  async function drain () {
    if (timer) { clearTimeout(timer); timer = null }
    if (!queue.length) return
    const batch = queue
    queue = []
    const target = preferenceSignalsTarget(vaultRoot)
    if (!target) return // provider changed away from kip / no key — drop
    await Promise.all(batch.map((body) => postBody(target, body, doFetch, debug)))
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

module.exports = { createFeedbackPoster, installFeedbackPoster, postFeedback, sanitizeSignal }
