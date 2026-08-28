const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { callLLM, loadLLMConfig, saveLLMConfig, testConnection } = require('../lib/llm')
const telemetry = require('../lib/telemetry')

function makeTempVault () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coop-llm-test-'))
}

// callLLM()/testConnection() read coop/.henhouse/llm.json if one exists at
// the given vaultRoot — and this project's real coop now has a real one
// (saved for real through the LLM settings panel). Every test below that
// isn't specifically exercising config-file precedence must point at an
// empty, file-less coop instead of the real one, or it'll pick up
// whatever the real project happens to have configured.
const EMPTY_VAULT = makeTempVault()
test.after(() => fs.rmSync(EMPTY_VAULT, { recursive: true, force: true }))

/** Temporarily sets env vars for the duration of an (async) fn, restoring afterward. */
async function withEnv (vars, fn) {
  const original = {}
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key]
    if (vars[key] === undefined) delete process.env[key]
    else process.env[key] = vars[key]
  }
  try {
    return await fn()
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
  }
}

function fakeAnthropicClient (responseText) {
  let lastCall = null
  class FakeAnthropic {
    constructor () {
      this.messages = {
        create: async (args) => {
          lastCall = args
          return { content: [{ type: 'text', text: responseText }] }
        }
      }
    }
  }
  return { FakeAnthropic, getLastCall: () => lastCall }
}

function fakeFetch (responseBody, { ok = true, status = 200 } = {}) {
  let lastCall = null
  const impl = async (url, init) => {
    lastCall = { url, init }
    return { ok, status, json: async () => responseBody, text: async () => JSON.stringify(responseBody) }
  }
  return { impl, getLastCall: () => lastCall }
}

test('callLLM: anthropic provider normalizes to {text, raw}', async () => {
  await withEnv({ PROVIDER: 'anthropic' }, async () => {
    const { FakeAnthropic, getLastCall } = fakeAnthropicClient('hello from anthropic')
    const result = await callLLM({ system: 'sys', prompt: 'hi', maxTokens: 100 }, { AnthropicClient: FakeAnthropic, vaultRoot: EMPTY_VAULT })
    assert.equal(result.text, 'hello from anthropic')
    assert.ok(result.raw)
    assert.equal(getLastCall().model, 'claude-sonnet-4-6')
    assert.equal(getLastCall().system, 'sys')
  })
})

test('callLLM: openai provider normalizes to {text, raw}, uses its own base URL/model', async () => {
  await withEnv({ PROVIDER: 'openai', OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'gpt-test', OPENAI_BASE_URL: undefined }, async () => {
    const { impl, getLastCall } = fakeFetch({ choices: [{ message: { content: 'hello from openai' } }] })
    const result = await callLLM({ system: 'sys', prompt: 'hi' }, { fetchImpl: impl, vaultRoot: EMPTY_VAULT })
    assert.equal(result.text, 'hello from openai')
    assert.ok(result.raw)
    assert.ok(getLastCall().url.startsWith('https://api.openai.com/v1'))
    const body = JSON.parse(getLastCall().init.body)
    assert.equal(body.model, 'gpt-test')
    assert.equal(getLastCall().init.headers.Authorization, 'Bearer test-key')
  })
})

test('callLLM: deepseek provider uses its fixed base URL and default model', async () => {
  await withEnv({ PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_MODEL: undefined }, async () => {
    const { impl, getLastCall } = fakeFetch({ choices: [{ message: { content: 'hello from deepseek' } }] })
    const result = await callLLM({ system: 'sys', prompt: 'hi' }, { fetchImpl: impl, vaultRoot: EMPTY_VAULT })
    assert.equal(result.text, 'hello from deepseek')
    assert.ok(getLastCall().url.startsWith('https://api.deepseek.com'))
    const body = JSON.parse(getLastCall().init.body)
    assert.equal(body.model, 'deepseek-chat')
  })
})

test('callLLM: local provider defaults its base URL and sends no Authorization header', async () => {
  await withEnv({ PROVIDER: 'local', LOCAL_MODEL: 'llama3.1', LOCAL_BASE_URL: undefined }, async () => {
    const { impl, getLastCall } = fakeFetch({ choices: [{ message: { content: 'hello from local' } }] })
    const result = await callLLM({ system: 'sys', prompt: 'hi' }, { fetchImpl: impl, vaultRoot: EMPTY_VAULT })
    assert.equal(result.text, 'hello from local')
    assert.ok(getLastCall().url.startsWith('http://localhost:11434/v1'))
    assert.equal(getLastCall().init.headers.Authorization, undefined)
  })
})

test('callLLM: switching PROVIDER changes which code path gets hit', async () => {
  const { FakeAnthropic, getLastCall: getAnthropicCall } = fakeAnthropicClient('anthropic reply')
  const { impl, getLastCall: getFetchCall } = fakeFetch({ choices: [{ message: { content: 'openai reply' } }] })

  const anthropicResult = await withEnv({ PROVIDER: 'anthropic' }, () =>
    callLLM({ system: 's', prompt: 'p' }, { AnthropicClient: FakeAnthropic, fetchImpl: impl, vaultRoot: EMPTY_VAULT }))
  assert.equal(anthropicResult.text, 'anthropic reply')
  assert.ok(getAnthropicCall(), 'anthropic path should have been hit')
  assert.equal(getFetchCall(), null, 'fetch should not have been called for PROVIDER=anthropic')

  const openaiResult = await withEnv({ PROVIDER: 'openai', OPENAI_API_KEY: 'k', OPENAI_MODEL: 'gpt-test' }, () =>
    callLLM({ system: 's', prompt: 'p' }, { AnthropicClient: FakeAnthropic, fetchImpl: impl, vaultRoot: EMPTY_VAULT }))
  assert.equal(openaiResult.text, 'openai reply')
  assert.ok(getFetchCall(), 'fetch path should have been hit for PROVIDER=openai')
})

test('callLLM: json:true on anthropic appends the JSON instruction and strips code fences', async () => {
  await withEnv({ PROVIDER: 'anthropic' }, async () => {
    const { FakeAnthropic, getLastCall } = fakeAnthropicClient('```json\n{"terms": ["a", "b"]}\n```')
    const result = await callLLM({ system: 'sys', prompt: 'hi', json: true }, { AnthropicClient: FakeAnthropic, vaultRoot: EMPTY_VAULT })
    assert.equal(result.text, '{"terms": ["a", "b"]}')
    assert.ok(getLastCall().system.includes('ONLY valid JSON'))
  })
})

test('callLLM: json:true on an openai-compatible provider uses response_format', async () => {
  await withEnv({ PROVIDER: 'openai', OPENAI_API_KEY: 'k', OPENAI_MODEL: 'gpt-test' }, async () => {
    const { impl, getLastCall } = fakeFetch({ choices: [{ message: { content: '{"terms":["a"]}' } }] })
    const result = await callLLM({ system: 'sys', prompt: 'hi', json: true }, { fetchImpl: impl, vaultRoot: EMPTY_VAULT })
    assert.equal(result.text, '{"terms":["a"]}')
    const body = JSON.parse(getLastCall().init.body)
    assert.deepEqual(body.response_format, { type: 'json_object' })
  })
})

test('callLLM: openai-compatible falls back to prompt-and-strip when response_format errors', async () => {
  await withEnv({ PROVIDER: 'openai', OPENAI_API_KEY: 'k', OPENAI_MODEL: 'gpt-test' }, async () => {
    let callCount = 0
    const impl = async (_url, init) => {
      callCount++
      const body = JSON.parse(init.body)
      if (body.response_format) {
        return { ok: false, status: 400, text: async () => 'response_format not supported', json: async () => ({}) }
      }
      assert.ok(body.messages[0].content.includes('ONLY valid JSON'), 'retry should ask for JSON via the prompt instead')
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '```json\n{"ok":true}\n```' } }] }) }
    }
    const result = await callLLM({ system: 'sys', prompt: 'hi', json: true }, { fetchImpl: impl, vaultRoot: EMPTY_VAULT })
    assert.equal(callCount, 2)
    assert.equal(result.text, '{"ok":true}')
  })
})

test('callLLM: missing a required env var throws a clear error', async () => {
  await withEnv({ PROVIDER: 'openai', OPENAI_API_KEY: undefined, OPENAI_MODEL: undefined }, async () => {
    await assert.rejects(() => callLLM({ system: 's', prompt: 'p' }, { vaultRoot: EMPTY_VAULT }), /OPENAI_API_KEY/)
  })
})

test('callLLM: unknown PROVIDER throws a clear error', async () => {
  await withEnv({ PROVIDER: 'not-a-real-provider' }, async () => {
    await assert.rejects(() => callLLM({ system: 's', prompt: 'p' }, { vaultRoot: EMPTY_VAULT }), /Unknown PROVIDER/)
  })
})

test('callLLM: records one content-free telemetry entry per successful call', async () => {
  telemetry.reset()
  await withEnv({ PROVIDER: 'anthropic' }, async () => {
    const { FakeAnthropic } = fakeAnthropicClient('hi there')
    await callLLM({ system: 'sys', prompt: 'hello', label: 'test:call' }, { AnthropicClient: FakeAnthropic, vaultRoot: EMPTY_VAULT })
  })
  const entries = telemetry.entries()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].ok, true)
  assert.equal(entries[0].label, 'test:call')
  assert.equal(typeof entries[0].ms, 'number')
  assert.equal(entries[0].promptChars, 5)
  // fake response has no `usage` — the extractor must tolerate that, not throw
  assert.equal(entries[0].inputTokens, 0)
  for (const k of ['prompt', 'responseText', 'system']) assert.ok(!(k in entries[0]))
})

test('callLLM: a failing call is recorded with ok:false and still rethrows', async () => {
  telemetry.reset()
  await withEnv({ PROVIDER: 'openai', OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm' }, async () => {
    const { impl } = fakeFetch({ error: 'nope' }, { ok: false, status: 500 })
    await assert.rejects(() => callLLM({ system: 's', prompt: 'p', label: 'boom' }, { fetchImpl: impl, vaultRoot: EMPTY_VAULT }))
  })
  const entries = telemetry.entries()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].ok, false)
  assert.ok(entries[0].error)
})

test('loadLLMConfig', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  await t.test('returns null when the file does not exist', () => {
    assert.equal(loadLLMConfig(root), null)
  })

  await t.test('saveLLMConfig then loadLLMConfig round-trips, creating coop/.henhouse/', () => {
    const config = { provider: 'openai', providers: { openai: { apiKey: 'sk-test', model: 'gpt-test' } } }
    saveLLMConfig(config, root)
    assert.ok(fs.existsSync(path.join(root, '.henhouse', 'llm.json')))
    assert.deepEqual(loadLLMConfig(root), config)
  })

  await t.test('throws a clear error on invalid JSON rather than silently ignoring it', () => {
    fs.mkdirSync(path.join(root, '.henhouse'), { recursive: true })
    fs.writeFileSync(path.join(root, '.henhouse', 'llm.json'), '{ not valid json')
    assert.throws(() => loadLLMConfig(root), /not valid JSON/)
  })
})

test('callLLM: coop/.henhouse/llm.json takes precedence over env vars, per field', async () => {
  const root = makeTempVault()
  try {
    saveLLMConfig({
      provider: 'openai',
      providers: { openai: { apiKey: 'file-key', model: 'file-model' } }
    }, root)

    await withEnv({ PROVIDER: 'anthropic', OPENAI_API_KEY: 'env-key', OPENAI_MODEL: 'env-model' }, async () => {
      const { impl, getLastCall } = fakeFetch({ choices: [{ message: { content: 'hi from file config' } }] })
      const result = await callLLM({ system: 's', prompt: 'p' }, { fetchImpl: impl, vaultRoot: root })

      assert.equal(result.text, 'hi from file config', 'file\'s "provider": "openai" should win over env PROVIDER=anthropic')
      const body = JSON.parse(getLastCall().init.body)
      assert.equal(body.model, 'file-model', 'file model should win over OPENAI_MODEL')
      assert.equal(getLastCall().init.headers.Authorization, 'Bearer file-key', 'file apiKey should win over OPENAI_API_KEY')
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('callLLM: falls back to env vars for a field the config file omits', async () => {
  const root = makeTempVault()
  try {
    // File sets the provider and apiKey, but not the model.
    saveLLMConfig({ provider: 'openai', providers: { openai: { apiKey: 'file-key' } } }, root)

    await withEnv({ OPENAI_API_KEY: 'env-key', OPENAI_MODEL: 'env-model' }, async () => {
      const { impl, getLastCall } = fakeFetch({ choices: [{ message: { content: 'ok' } }] })
      await callLLM({ system: 's', prompt: 'p' }, { fetchImpl: impl, vaultRoot: root })

      const body = JSON.parse(getLastCall().init.body)
      assert.equal(body.model, 'env-model', 'missing file field should fall back to the env var')
      assert.equal(getLastCall().init.headers.Authorization, 'Bearer file-key', 'field the file does set should still win')
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('callLLM: with no config file, behaves exactly as env-var-only (backward compatible)', async () => {
  const root = makeTempVault() // coop/.henhouse/llm.json intentionally never created
  try {
    await withEnv({ PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'env-key' }, async () => {
      const { impl, getLastCall } = fakeFetch({ choices: [{ message: { content: 'ok' } }] })
      const result = await callLLM({ system: 's', prompt: 'p' }, { fetchImpl: impl, vaultRoot: root })
      assert.equal(result.text, 'ok')
      const body = JSON.parse(getLastCall().init.body)
      assert.equal(body.model, 'deepseek-chat', 'should still fall back to the built-in default')
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('callLLM: "other" provider requires an explicit base URL', async () => {
  await withEnv({ PROVIDER: 'other', OTHER_API_KEY: 'k', OTHER_MODEL: 'm', OTHER_BASE_URL: undefined }, async () => {
    await assert.rejects(() => callLLM({ system: 's', prompt: 'p' }, { vaultRoot: EMPTY_VAULT }), /OTHER_BASE_URL/)
  })
})

test('callLLM: "other" provider works like any OpenAI-compatible endpoint once configured', async () => {
  await withEnv({ PROVIDER: 'other', OTHER_API_KEY: 'k', OTHER_MODEL: 'm', OTHER_BASE_URL: 'https://example.com/v1' }, async () => {
    const { impl, getLastCall } = fakeFetch({ choices: [{ message: { content: 'hi' } }] })
    const result = await callLLM({ system: 's', prompt: 'p' }, { fetchImpl: impl, vaultRoot: EMPTY_VAULT })
    assert.equal(result.text, 'hi')
    assert.ok(getLastCall().url.startsWith('https://example.com/v1'))
  })
})

test('callLLM: kip provider routes through the managed backend with its default base URL', async () => {
  await withEnv({ PROVIDER: 'kip', KIP_API_KEY: 'kip-key', KIP_MODEL: undefined, KIP_BASE_URL: undefined }, async () => {
    const { impl, getLastCall } = fakeFetch({ choices: [{ message: { content: 'routed reply' } }], model: 'claude-sonnet-4-6' })
    const result = await callLLM({ system: 'sys', prompt: 'hi', label: 'peck:answer' }, { fetchImpl: impl, vaultRoot: EMPTY_VAULT })
    assert.equal(result.text, 'routed reply')
    assert.ok(getLastCall().url.startsWith('https://api.kip-ai.be/v1'))
    const body = JSON.parse(getLastCall().init.body)
    assert.equal(body.model, 'auto', 'always "auto" — model selection is fully delegated to the backend')
    assert.equal(getLastCall().init.headers.Authorization, 'Bearer kip-key')
  })
})

test('callLLM: kip ignores any configured model (env or file) — always sends "auto"', async () => {
  // env var
  await withEnv({ PROVIDER: 'kip', KIP_API_KEY: 'k', KIP_MODEL: 'quality' }, async () => {
    const { impl, getLastCall } = fakeFetch({ choices: [{ message: { content: 'ok' } }] })
    await callLLM({ system: 's', prompt: 'p' }, { fetchImpl: impl, vaultRoot: EMPTY_VAULT })
    assert.equal(JSON.parse(getLastCall().init.body).model, 'auto', 'KIP_MODEL is ignored')
  })
  // stale file config
  const root = makeTempVault()
  try {
    saveLLMConfig({ provider: 'kip', providers: { kip: { apiKey: 'k', model: 'fast' } } }, root)
    const { impl, getLastCall } = fakeFetch({ choices: [{ message: { content: 'ok' } }] })
    await callLLM({ system: 's', prompt: 'p' }, { fetchImpl: impl, vaultRoot: root })
    assert.equal(JSON.parse(getLastCall().init.body).model, 'auto', 'a stale providers.kip.model is ignored')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('callLLM: kip forwards the workload label as X-Kip-Workload / X-Kip-Phase headers', async () => {
  await withEnv({ PROVIDER: 'kip', KIP_API_KEY: 'k' }, async () => {
    const { impl, getLastCall } = fakeFetch({ choices: [{ message: { content: 'ok' } }], model: 'gpt-4o' })

    await callLLM({ system: 's', prompt: 'p', label: 'hatch:generate:entity' }, { fetchImpl: impl, vaultRoot: EMPTY_VAULT })
    let headers = getLastCall().init.headers
    assert.equal(headers['X-Kip-Workload'], 'hatch:generate:entity', 'exact label forwarded')
    assert.equal(headers['X-Kip-Phase'], 'hatch:generate', 'phase bucket derived like telemetry')

    await callLLM({ system: 's', prompt: 'p', label: 'skill:web-search' }, { fetchImpl: impl, vaultRoot: EMPTY_VAULT })
    headers = getLastCall().init.headers
    assert.equal(headers['X-Kip-Workload'], 'skill:web-search')
    assert.equal(headers['X-Kip-Phase'], 'skill')

    await callLLM({ system: 's', prompt: 'p', label: 'peck:answer:retry' }, { fetchImpl: impl, vaultRoot: EMPTY_VAULT })
    headers = getLastCall().init.headers
    assert.equal(headers['X-Kip-Phase'], 'peck:answer', ':retry stripped from the phase')
  })
})

test('callLLM: kip json:true still forwards the workload headers on both the primary and fallback request', async () => {
  await withEnv({ PROVIDER: 'kip', KIP_API_KEY: 'k' }, async () => {
    const seen = []
    const impl = async (_url, init) => {
      const body = JSON.parse(init.body)
      seen.push({ workload: init.headers['X-Kip-Workload'], hadFormat: !!body.response_format })
      if (body.response_format) return { ok: false, status: 400, text: async () => 'no', json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }], model: 'claude-sonnet-4-6' }) }
    }
    const result = await callLLM({ system: 's', prompt: 'p', json: true, label: 'groom:coherence' }, { fetchImpl: impl, vaultRoot: EMPTY_VAULT })
    assert.equal(result.text, '{"ok":true}')
    assert.equal(seen.length, 2)
    assert.ok(seen.every((s) => s.workload === 'groom:coherence'), 'both attempts carry the workload header')
  })
})

test('callLLM: direct providers get no X-Kip-* headers (unchanged behaviour)', async () => {
  await withEnv({ PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k' }, async () => {
    const { impl, getLastCall } = fakeFetch({ choices: [{ message: { content: 'ok' } }] })
    await callLLM({ system: 's', prompt: 'p', label: 'peck:answer' }, { fetchImpl: impl, vaultRoot: EMPTY_VAULT })
    const headers = getLastCall().init.headers
    assert.equal(headers['X-Kip-Workload'], undefined)
    assert.equal(headers['X-Kip-Phase'], undefined)
  })
})

test('callLLM: kip records the backend-resolved model in telemetry, not "auto"', async () => {
  telemetry.reset()
  await withEnv({ PROVIDER: 'kip', KIP_API_KEY: 'k' }, async () => {
    const { impl } = fakeFetch({ choices: [{ message: { content: 'hi' } }], model: 'claude-sonnet-4-6' })
    await callLLM({ system: 's', prompt: 'p', label: 'peck:answer' }, { fetchImpl: impl, vaultRoot: EMPTY_VAULT })
  })
  const entries = telemetry.entries()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].provider, 'kip')
  assert.equal(entries[0].model, 'claude-sonnet-4-6', 'the model the backend reported, not "auto"')
})

test('callLLM: kip records "auto" in telemetry when the response omits model', async () => {
  telemetry.reset()
  await withEnv({ PROVIDER: 'kip', KIP_API_KEY: 'k' }, async () => {
    const { impl } = fakeFetch({ choices: [{ message: { content: 'hi' } }] }) // no `model` field
    await callLLM({ system: 's', prompt: 'p', label: 'peck:answer' }, { fetchImpl: impl, vaultRoot: EMPTY_VAULT })
  })
  assert.equal(telemetry.entries()[0].model, 'auto')
})

test('callLLM: kip requires KIP_API_KEY', async () => {
  await withEnv({ PROVIDER: 'kip', KIP_API_KEY: undefined }, async () => {
    await assert.rejects(() => callLLM({ system: 's', prompt: 'p' }, { vaultRoot: EMPTY_VAULT }), /KIP_API_KEY/)
  })
})

test('callLLM: kip config from coop/.henhouse/llm.json (provider + API key + base URL; model still ignored)', async () => {
  const root = makeTempVault()
  try {
    saveLLMConfig({
      provider: 'kip',
      providers: { kip: { apiKey: 'file-key', model: 'fast', baseUrl: 'https://router.example/v1' } }
    }, root)
    const { impl, getLastCall } = fakeFetch({ choices: [{ message: { content: 'ok' } }], model: 'gpt-4o-mini' })
    await callLLM({ system: 's', prompt: 'p', label: 'hatch:propose' }, { fetchImpl: impl, vaultRoot: root })
    assert.ok(getLastCall().url.startsWith('https://router.example/v1'))
    const body = JSON.parse(getLastCall().init.body)
    assert.equal(body.model, 'auto', 'file model is ignored — always delegates')
    assert.equal(getLastCall().init.headers.Authorization, 'Bearer file-key')
    assert.equal(getLastCall().init.headers['X-Kip-Workload'], 'hatch:propose')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('testConnection', async (t) => {
  await t.test('reports success with the reply text on a good call', async () => {
    const { FakeAnthropic } = fakeAnthropicClient('OK')
    const result = await testConnection({ provider: 'anthropic', apiKey: 'k' }, { AnthropicClient: FakeAnthropic })
    assert.deepEqual(result, { success: true, reply: 'OK' })
  })

  await t.test('reports failure with a message, never throws, for a provider error', async () => {
    const { impl } = fakeFetch({ error: 'bad key' }, { ok: false, status: 401 })
    const result = await testConnection({ provider: 'openai', apiKey: 'bad', model: 'gpt-test', baseUrl: 'https://api.openai.com/v1' }, { fetchImpl: impl })
    assert.equal(result.success, false)
    assert.ok(result.error.includes('401'))
  })

  await t.test('reports failure for a missing required field rather than throwing', async () => {
    const result = await testConnection({ provider: 'openai', apiKey: 'k' }) // no model, no baseUrl
    assert.equal(result.success, false)
    assert.match(result.error, /Model is required/)
  })

  await t.test('reports failure for an unknown provider', async () => {
    const result = await testConnection({ provider: 'not-a-real-provider' })
    assert.deepEqual(result, { success: false, error: 'Unknown provider "not-a-real-provider".' })
  })

  await t.test('kip: works against the managed backend with just an API key (profile + base URL default)', async () => {
    await withEnv({ KIP_API_KEY: undefined, KIP_MODEL: undefined, KIP_BASE_URL: undefined }, async () => {
      const { impl, getLastCall } = fakeFetch({ choices: [{ message: { content: 'OK' } }], model: 'claude-sonnet-4-6' })
      const result = await testConnection({ provider: 'kip', apiKey: 'kip-key' }, { fetchImpl: impl })
      assert.deepEqual(result, { success: true, reply: 'OK' })
      assert.ok(getLastCall().url.startsWith('https://api.kip-ai.be/v1'))
      assert.equal(JSON.parse(getLastCall().init.body).model, 'auto')
    })
  })

  await t.test('kip: reports failure (never throws) when the backend errors', async () => {
    const { impl } = fakeFetch({ error: 'router down' }, { ok: false, status: 502 })
    const result = await testConnection({ provider: 'kip', apiKey: 'k' }, { fetchImpl: impl })
    assert.equal(result.success, false)
    assert.ok(result.error.includes('502'))
  })

  await t.test('tests the given candidate values, not whatever is in the environment', async () => {
    await withEnv({ OPENAI_API_KEY: 'env-key', OPENAI_MODEL: 'env-model' }, async () => {
      const { impl, getLastCall } = fakeFetch({ choices: [{ message: { content: 'OK' } }] })
      await testConnection({ provider: 'openai', apiKey: 'form-key', model: 'form-model', baseUrl: 'https://api.openai.com/v1' }, { fetchImpl: impl })
      const body = JSON.parse(getLastCall().init.body)
      assert.equal(body.model, 'form-model')
      assert.equal(getLastCall().init.headers.Authorization, 'Bearer form-key')
    })
  })
})
