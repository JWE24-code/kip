const test = require('node:test')
const assert = require('node:assert/strict')

const kip = require('../lib/kip-connector')
const { validateSpec } = require('../lib/connectors')

const RESOLVED = { apiKey: 'kip_testkey', baseUrl: 'http://lan.test:8080' }

/** A fake fetch that records the last call and returns `body` (200 unless overridden).
 *  `resHeaders` populates the response's Headers (e.g. { 'x-kip-call-id': '…' }). */
function fakeFetch (body, { ok = true, status = 200, resHeaders = {} } = {}) {
  let last = null
  const impl = async (url, init) => {
    last = { url, init, headers: init.headers, body: JSON.parse(init.body) }
    return {
      ok,
      status,
      headers: new Headers(resHeaders),
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    }
  }
  return { impl, last: () => last }
}

const reply = (content, usage) => ({
  id: 'chatcmpl-x',
  model: 'claude-sonnet-4-6',
  choices: [{ message: { content } }],
  ...(usage ? { usage } : {})
})

test('kip-connector is a valid v1 ProviderSpec', () => {
  assert.equal(validateSpec(kip), null)
  assert.equal(kip.id, 'kip')
  assert.equal(kip.isReady({ apiKey: 'kip_x' }), true)
  assert.equal(kip.isReady({}), false)
  assert.equal(kip.isReady(null), false)
})

test('phaseOf: first ":"-segment, or null', () => {
  const { phaseOf } = kip._internals
  assert.equal(phaseOf('hatch:generate:entity'), 'hatch')
  assert.equal(phaseOf('peck:answer'), 'peck')
  assert.equal(phaseOf('skill:docx'), 'skill')
  assert.equal(phaseOf('groom'), 'groom')
  assert.equal(phaseOf(''), null)
  assert.equal(phaseOf(undefined), null)
})

test('complete: sends auth + routing headers + model:"auto"', async () => {
  const { impl, last } = fakeFetch(reply('hi from kip'))
  const res = await kip.complete(RESOLVED,
    { system: 'sys', prompt: 'q', json: false, maxTokens: 4096, label: 'hatch:generate:entity' },
    { fetch: impl })

  assert.equal(res.text, 'hi from kip')
  assert.ok(res.raw)
  assert.equal(res.callId, null, 'no X-Kip-Call-Id header -> null')
  assert.equal(last().url, 'http://lan.test:8080/v1/chat/completions')
  assert.equal(last().headers.Authorization, 'Bearer kip_testkey')
  assert.equal(last().headers['X-Kip-Workload'], 'hatch:generate:entity')
  assert.equal(last().headers['X-Kip-Phase'], 'hatch')
  assert.equal(last().body.model, 'auto')
  assert.equal(last().body.max_tokens, 4096)
  assert.deepEqual(last().body.messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q' }
  ])
})

test('complete: returns the X-Kip-Call-Id header as callId', async () => {
  const { impl } = fakeFetch(reply('hi'), { resHeaders: { 'x-kip-call-id': 'call_abc123' } })
  const res = await kip.complete(RESOLVED, { prompt: 'q', maxTokens: 10 }, { fetch: impl })
  assert.equal(res.callId, 'call_abc123')
})

test('complete json:true: callId survives the prompt-and-strip 400 retry', async () => {
  const impl = async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.response_format) {
      return { ok: false, status: 400, headers: new Headers(), json: async () => ({ error: { message: 'no response_format' } }), text: async () => '' }
    }
    return { ok: true, status: 200, headers: new Headers({ 'x-kip-call-id': 'call_retry' }), json: async () => reply('{"ok":true}'), text: async () => '' }
  }
  const res = await kip.complete(RESOLVED, { system: 's', prompt: 'q', json: true, maxTokens: 50 }, { fetch: impl })
  assert.equal(res.text, '{"ok":true}')
  assert.equal(res.callId, 'call_retry')
})

test('complete: non-arena calls report arenaId: null', async () => {
  const { impl } = fakeFetch(reply('hi'))
  const res = await kip.complete(RESOLVED, { prompt: 'q', maxTokens: 10 }, { fetch: impl })
  assert.equal(res.arenaId, null)
})

test('complete arena: routes to /v1/arena/completions with compare_to_call_id', async () => {
  const arenaBody = {
    arena_id: 'arena_9',
    origin: 'regen',
    b: { ...reply('the regenerated answer'), kip_call_id: 'call_B' }
  }
  const { impl, last } = fakeFetch(arenaBody, { resHeaders: { 'x-kip-arena-id': 'arena_9' } })
  const res = await kip.complete(RESOLVED,
    { system: 'sys', prompt: 'q', maxTokens: 4096, label: 'peck:answer', arena: { compareToCallId: 'call_A' } },
    { fetch: impl })

  assert.equal(last().url, 'http://lan.test:8080/v1/arena/completions')
  assert.equal(last().body.compare_to_call_id, 'call_A')
  assert.equal(last().body.model, 'auto')
  assert.equal(last().headers['X-Kip-Workload'], 'peck:answer')
  assert.equal(res.text, 'the regenerated answer')
  assert.equal(res.callId, 'call_B', 'callId is candidate B\'s own kip_call_id')
  assert.equal(res.arenaId, 'arena_9')
})

test('complete arena: arenaId falls back to the X-Kip-Arena-Id header', async () => {
  const arenaBody = { origin: 'regen', b: { ...reply('x'), kip_call_id: 'call_B' } } // no arena_id in body
  const { impl } = fakeFetch(arenaBody, { resHeaders: { 'x-kip-arena-id': 'arena_hdr' } })
  const res = await kip.complete(RESOLVED,
    { prompt: 'q', maxTokens: 10, arena: { compareToCallId: 'call_A' } }, { fetch: impl })
  assert.equal(res.arenaId, 'arena_hdr')
})

test('complete arena: a plan-check failure throws like any other backend error', async () => {
  const { impl } = fakeFetch({ error: { message: 'plan limit reached' } }, { ok: false, status: 402 })
  await assert.rejects(
    kip.complete(RESOLVED, { prompt: 'q', maxTokens: 10, arena: { compareToCallId: 'call_A' } }, { fetch: impl }),
    /402.*plan limit/)
})

test('complete: no label -> no routing headers', async () => {
  const { impl, last } = fakeFetch(reply('ok'))
  await kip.complete(RESOLVED, { prompt: 'q', maxTokens: 10 }, { fetch: impl })
  assert.equal(last().headers['X-Kip-Workload'], undefined)
  assert.equal(last().headers['X-Kip-Phase'], undefined)
})

test('complete: default base URL when the field is blank', async () => {
  const { impl, last } = fakeFetch(reply('ok'))
  await kip.complete({ apiKey: 'kip_x' }, { prompt: 'q', maxTokens: 10 }, { fetch: impl })
  assert.ok(last().url.startsWith(kip._internals.DEFAULT_BASE_URL + '/v1/chat/completions'))
})

test('complete json:true -> response_format, and strips code fences', async () => {
  const { impl, last } = fakeFetch(reply('```json\n{"a":1}\n```'))
  const res = await kip.complete(RESOLVED, { prompt: 'q', json: true, maxTokens: 100 }, { fetch: impl })
  assert.deepEqual(last().body.response_format, { type: 'json_object' })
  assert.equal(res.text, '{"a":1}')
})

test('complete json:true -> retries prompt-and-strip on a 400 only', async () => {
  let n = 0
  const impl = async (_url, init) => {
    n++
    const body = JSON.parse(init.body)
    if (body.response_format) {
      return { ok: false, status: 400, json: async () => ({ error: { message: 'response_format unsupported' } }), text: async () => '' }
    }
    assert.ok(body.messages[0].content.includes('ONLY valid JSON'))
    return { ok: true, status: 200, json: async () => reply('{"ok":true}'), text: async () => '' }
  }
  const res = await kip.complete(RESOLVED, { system: 's', prompt: 'q', json: true, maxTokens: 100 }, { fetch: impl })
  assert.equal(n, 2)
  assert.equal(res.text, '{"ok":true}')
})

test('complete json:true -> does NOT retry a 402 (plan limit is real)', async () => {
  let n = 0
  const impl = async () => {
    n++
    return { ok: false, status: 402, json: async () => ({ error: { message: 'plan limit reached' } }), text: async () => '' }
  }
  await assert.rejects(
    () => kip.complete(RESOLVED, { prompt: 'q', json: true, maxTokens: 10 }, { fetch: impl }),
    (err) => err.status === 402 && /plan limit reached/.test(err.message)
  )
  assert.equal(n, 1)
})

test('complete: non-2xx throws an Error with .status and the backend message', async () => {
  const { impl } = fakeFetch({ error: { message: 'Invalid API key', type: 'invalid_api_key', code: 'invalid_api_key' } }, { ok: false, status: 401 })
  await assert.rejects(
    () => kip.complete(RESOLVED, { prompt: 'q', maxTokens: 10 }, { fetch: impl }),
    (err) => err.status === 401 && /\(401\)/.test(err.message) && /Invalid API key/.test(err.message)
  )
})

test('complete: a transport failure becomes a specific message, not "fetch failed"', async () => {
  const cases = [
    ['ECONNREFUSED', /nothing is listening/i],
    ['ETIMEDOUT', /no response|reach it/i],
    ['ENOTFOUND', /can't resolve/i]
  ]
  for (const [code, re] of cases) {
    const impl = async () => { const e = new TypeError('fetch failed'); e.cause = { code }; throw e }
    await assert.rejects(
      () => kip.complete(RESOLVED, { prompt: 'q', maxTokens: 10 }, { fetch: impl }),
      (err) => err.code === code && re.test(err.message) && !/^fetch failed$/.test(err.message)
    )
  }
})

test('testConnection: surfaces the transport reason too', async () => {
  const impl = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e }
  const r = await kip.testConnection(RESOLVED, { fetch: impl })
  assert.equal(r.success, false)
  assert.match(r.error, /nothing is listening/i)
  assert.doesNotMatch(r.error, /^fetch failed$/)
})

test('testConnection: hits GET /v1/usage (auth only), reports the plan', async () => {
  let calledUrl, authHeader
  const impl = async (url, init) => {
    calledUrl = url
    authHeader = init && init.headers && init.headers.Authorization
    return { ok: true, status: 200, json: async () => ({ plan: 'pro', limits: { monthly_token_cap: 5000000 } }) }
  }
  const r = await kip.testConnection(RESOLVED, { fetch: impl })
  assert.equal(calledUrl, 'http://lan.test:8080/v1/usage')
  assert.equal(authHeader, 'Bearer kip_testkey')
  assert.equal(r.success, true)
  assert.match(r.reply, /pro plan/)
  assert.match(r.reply, /5000k tokens/)
})

test('complete: raw carries the resolved model + usage for telemetry', async () => {
  const { impl } = fakeFetch(reply('x', { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }))
  const { raw } = await kip.complete(RESOLVED, { prompt: 'q', maxTokens: 10 }, { fetch: impl })
  assert.equal(raw.model, 'claude-sonnet-4-6')
  assert.equal(raw.usage.total_tokens, 15)
})

test('testConnection: a bad key -> { success:false, error }, never throws', async () => {
  const impl = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid api key' } }) })
  const r = await kip.testConnection(RESOLVED, { fetch: impl })
  assert.equal(r.success, false)
  assert.match(r.error, /\(401\)/)
  assert.match(r.error, /invalid api key/)
})

test('humanizeError: maps the documented backend errors', () => {
  assert.match(kip.humanizeError('Kip backend request failed (401): bad key').title, /rejected your key/)
  assert.match(kip.humanizeError('Kip backend request failed (402): plan limit reached').title, /plan limit/)
  assert.match(kip.humanizeError('request failed (429): rate limit').title, /rate-limiting/)
  assert.match(kip.humanizeError('(503): no_route for (hatch, hatch:whiteboard)').title, /route this call/i)
  assert.match(kip.humanizeError('Kip backend request failed (503): provider_not_configured').title, /route this call/i)
  assert.match(kip.humanizeError("Nothing is listening at http://x/v1/chat/completions").title, /reach the Kip backend/i)
  assert.equal(kip.humanizeError('something unrelated'), null)
})
