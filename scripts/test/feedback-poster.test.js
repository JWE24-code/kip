const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createFeedbackPoster, postFeedback, postArenaVerdict, sanitizeSignal } = require('../lib/feedback-poster')

const EMPTY_VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-poster-test-'))
test.after(() => fs.rmSync(EMPTY_VAULT, { recursive: true, force: true }))

async function withEnv (vars, fn) {
  const original = {}
  for (const k of Object.keys(vars)) {
    original[k] = process.env[k]
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k]
  }
  try { return await fn() } finally {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const KIP_ENV = { PROVIDER: 'kip', KIP_API_KEY: 'kip_test', KIP_BASE_URL: 'http://lan.test:3000' }

/** Records every POST; returns { impl, calls }. */
function recordingFetch ({ reject = false, ok = true } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    if (reject) throw new Error('network down')
    return { ok, status: ok ? 200 : 500 }
  }
  return { impl, calls }
}

test('sanitizeSignal: keeps the closed field set, drops everything else', () => {
  assert.deepEqual(
    sanitizeSignal({ call_id: 'c1', kind: 'rating', score: 1, scale: 2, note: 'loved it', prompt: 'secret' }),
    { call_id: 'c1', kind: 'rating', score: 1, scale: 2 })
  assert.deepEqual(
    sanitizeSignal({ call_id: 'c2', kind: 'behavior', behavior: 'edited', edit_bucket: 3, editText: 'the diff' }),
    { call_id: 'c2', kind: 'behavior', behavior: 'edited', edit_bucket: 3 })
})

test('sanitizeSignal: rejects malformed signals', () => {
  assert.equal(sanitizeSignal(null), null)
  assert.equal(sanitizeSignal({ kind: 'rating', score: 1 }), null, 'no call_id')
  assert.equal(sanitizeSignal({ call_id: '', kind: 'rating' }), null, 'empty call_id')
  assert.equal(sanitizeSignal({ call_id: 'c', kind: 'freeform' }), null, 'unknown kind')
  assert.equal(sanitizeSignal({ call_id: 'c' }), null, 'no kind')
})

test('poster: enqueue is a no-op when the provider is not kip', async () => {
  await withEnv({ PROVIDER: 'anthropic' }, async () => {
    const { impl, calls } = recordingFetch()
    const poster = createFeedbackPoster({ vaultRoot: EMPTY_VAULT, fetchImpl: impl })
    poster.enqueue({ call_id: 'c1', kind: 'rating', score: 1, scale: 2 })
    assert.equal(poster.pending, 0)
    await poster.flush()
    assert.equal(calls.length, 0)
  })
})

test('poster: batches, then flush POSTs each signal to /v1/feedback with the bearer key', async () => {
  await withEnv(KIP_ENV, async () => {
    const { impl, calls } = recordingFetch()
    const poster = createFeedbackPoster({ vaultRoot: EMPTY_VAULT, fetchImpl: impl })
    poster.enqueue({ call_id: 'c1', kind: 'rating', score: 1, scale: 2 })
    poster.enqueue({ call_id: 'c2', kind: 'behavior', behavior: 'regenerated' })
    assert.equal(poster.pending, 2, 'nothing sent until flush / the timer')

    await poster.flush()
    assert.equal(calls.length, 2)
    assert.equal(calls[0].url, 'http://lan.test:3000/v1/feedback')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer kip_test')
    assert.deepEqual(calls[0].body, { call_id: 'c1', kind: 'rating', score: 1, scale: 2 })
    assert.deepEqual(calls[1].body, { call_id: 'c2', kind: 'behavior', behavior: 'regenerated' })
    assert.equal(poster.pending, 0)
  })
})

test('poster: a malformed signal never reaches the queue', async () => {
  await withEnv(KIP_ENV, async () => {
    const { impl, calls } = recordingFetch()
    const poster = createFeedbackPoster({ vaultRoot: EMPTY_VAULT, fetchImpl: impl })
    poster.enqueue({ kind: 'rating' }) // no call_id
    poster.enqueue('nonsense')
    assert.equal(poster.pending, 0)
    await poster.flush()
    assert.equal(calls.length, 0)
  })
})

test('poster: a network failure is swallowed, queue still clears', async () => {
  await withEnv(KIP_ENV, async () => {
    const { impl } = recordingFetch({ reject: true })
    const poster = createFeedbackPoster({ vaultRoot: EMPTY_VAULT, fetchImpl: impl, logger: { debug () {} } })
    poster.enqueue({ call_id: 'c1', kind: 'rating', score: 0, scale: 2 })
    await poster.flush() // must not throw
    assert.equal(poster.pending, 0)
  })
})

test('poster: the auto-flush timer fires and is unref-safe', async () => {
  await withEnv(KIP_ENV, async () => {
    const { impl, calls } = recordingFetch()
    const poster = createFeedbackPoster({ vaultRoot: EMPTY_VAULT, fetchImpl: impl, flushMs: 20 })
    poster.enqueue({ call_id: 'c1', kind: 'rating', score: 1, scale: 2 })
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(calls.length, 1, 'timer flushed without an explicit flush()')
  })
})

test('postFeedback: one-shot POST for the kip provider, sanitized', async () => {
  await withEnv(KIP_ENV, async () => {
    const { impl, calls } = recordingFetch()
    const r = await postFeedback(
      { call_id: 'c9', kind: 'rating', score: 1, scale: 2, note: 'drop me' },
      { vaultRoot: EMPTY_VAULT, fetchImpl: impl })
    assert.deepEqual(r, { ok: true })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'http://lan.test:3000/v1/feedback')
    assert.deepEqual(calls[0].body, { call_id: 'c9', kind: 'rating', score: 1, scale: 2 })
  })
})

test('postFeedback: { ok: false } and no request when not kip / malformed / network down', async () => {
  const { impl, calls } = recordingFetch()
  await withEnv({ PROVIDER: 'anthropic' }, async () => {
    assert.deepEqual(await postFeedback({ call_id: 'c', kind: 'rating', score: 1, scale: 2 }, { vaultRoot: EMPTY_VAULT, fetchImpl: impl }), { ok: false })
  })
  await withEnv(KIP_ENV, async () => {
    assert.deepEqual(await postFeedback({ kind: 'rating' }, { vaultRoot: EMPTY_VAULT, fetchImpl: impl }), { ok: false })
  })
  assert.equal(calls.length, 0)
  await withEnv(KIP_ENV, async () => {
    const bad = recordingFetch({ reject: true })
    assert.deepEqual(await postFeedback({ call_id: 'c', kind: 'behavior', behavior: 'accepted' }, { vaultRoot: EMPTY_VAULT, fetchImpl: bad.impl, logger: { debug () {} } }), { ok: false })
  })
})

test('postArenaVerdict: POSTs { winner } to /v1/arena/<id>/verdict for the kip provider', async () => {
  await withEnv(KIP_ENV, async () => {
    const { impl, calls } = recordingFetch()
    const r = await postArenaVerdict('arena_7', 'b', { vaultRoot: EMPTY_VAULT, fetchImpl: impl })
    assert.deepEqual(r, { ok: true })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'http://lan.test:3000/v1/arena/arena_7/verdict')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer kip_test')
    assert.deepEqual(calls[0].body, { winner: 'b' })
  })
})

test('postArenaVerdict: { ok: false } and no request for a bad winner / blank id / non-kip', async () => {
  const { impl, calls } = recordingFetch()
  await withEnv(KIP_ENV, async () => {
    assert.deepEqual(await postArenaVerdict('arena_7', 'best', { vaultRoot: EMPTY_VAULT, fetchImpl: impl }), { ok: false })
    assert.deepEqual(await postArenaVerdict('', 'a', { vaultRoot: EMPTY_VAULT, fetchImpl: impl }), { ok: false })
  })
  await withEnv({ PROVIDER: 'anthropic' }, async () => {
    assert.deepEqual(await postArenaVerdict('arena_7', 'a', { vaultRoot: EMPTY_VAULT, fetchImpl: impl }), { ok: false })
  })
  assert.equal(calls.length, 0)
})

test('postArenaVerdict: a network failure is swallowed', async () => {
  await withEnv(KIP_ENV, async () => {
    const bad = recordingFetch({ reject: true })
    assert.deepEqual(
      await postArenaVerdict('arena_7', 'tie', { vaultRoot: EMPTY_VAULT, fetchImpl: bad.impl, logger: { debug () {} } }),
      { ok: false })
  })
})

test('poster: flush drops the batch if the provider changed away from kip mid-run', async () => {
  const { impl, calls } = recordingFetch()
  const poster = createFeedbackPoster({ vaultRoot: EMPTY_VAULT, fetchImpl: impl })
  await withEnv(KIP_ENV, async () => {
    poster.enqueue({ call_id: 'c1', kind: 'rating', score: 1, scale: 2 })
    assert.equal(poster.pending, 1)
  })
  await withEnv({ PROVIDER: 'anthropic' }, async () => {
    await poster.flush()
  })
  assert.equal(calls.length, 0, 'no POST once kip is no longer active')
})
