const test = require('node:test')
const assert = require('node:assert/strict')

const kip = require('../lib/kip-connector')
const { validateSpec } = require('../lib/connectors')

const RESOLVED = { apiKey: 'kip_testkey', baseUrl: 'http://lan.test:8080' }

/** A fake fetch that records the last call and returns `body` (200 unless overridden). */
function fakeFetch (body, { ok = true, status = 200 } = {}) {
  let last = null
  const impl = async (url, init) => {
    last = { url, init, headers: init.headers, body: JSON.parse(init.body) }
    return {
      ok,
      status,
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

test('complete: raw carries the resolved model + usage for telemetry', async () => {
  const { impl } = fakeFetch(reply('x', { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }))
  const { raw } = await kip.complete(RESOLVED, { prompt: 'q', maxTokens: 10 }, { fetch: impl })
  assert.equal(raw.model, 'claude-sonnet-4-6')
  assert.equal(raw.usage.total_tokens, 15)
})

test('testConnection: { success:true, reply } on a good call, never throws on a bad one', async () => {
  const ok = fakeFetch(reply('OK'))
  assert.deepEqual(await kip.testConnection(RESOLVED, { fetch: ok.impl }), { success: true, reply: 'OK' })

  const bad = fakeFetch({ error: { message: 'nope' } }, { ok: false, status: 401 })
  const r = await kip.testConnection(RESOLVED, { fetch: bad.impl })
  assert.equal(r.success, false)
  assert.match(r.error, /401/)
})

test('humanizeError: maps the documented backend errors', () => {
  assert.match(kip.humanizeError('Kip backend request failed (401): bad key').title, /rejected your key/)
  assert.match(kip.humanizeError('Kip backend request failed (402): plan limit reached').title, /plan limit/)
  assert.match(kip.humanizeError('request failed (429): rate limit').title, /rate-limiting/)
  assert.match(kip.humanizeError('(503): no_route for (hatch, hatch:whiteboard)').title, /no route/i)
  assert.equal(kip.humanizeError('something unrelated'), null)
})
