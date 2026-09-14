import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  callLLM,
  clearLearnedJsonMode,
  createLLMCompleter,
  listProviders,
  loadLLMConfig,
  saveLLMConfig,
  testConnection,
  type AnthropicClientCtor
} from '../llm/index.ts'
import { createUsageReporter } from '../llm/usage.ts'
import { payloadSchemas } from '../server/protocol.ts'

function tmpVault (): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-llm-'))
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// Every test that isn't exercising config-file precedence points at an empty,
// file-less coop so it can't pick up the developer's real .henhouse/llm.json.
const EMPTY_VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-llm-empty-'))
test.after(() => fs.rmSync(EMPTY_VAULT, { recursive: true, force: true }))

async function withEnv<T> (vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const original: Record<string, string | undefined> = {}
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

function fakeAnthropicClient (responseText: string, { streamDeltas }: { streamDeltas?: string[] } = {}): {
  FakeAnthropic: AnthropicClientCtor
  getLastCall: () => Record<string, unknown> | null
} {
  let lastCall: Record<string, unknown> | null = null
  class FakeAnthropic {
    messages = {
      create: async (args: Record<string, unknown>) => {
        lastCall = args
        if (args.stream) {
          const deltas = streamDeltas ?? [responseText]
          return (async function * () {
            yield { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } }
            for (const delta of deltas) yield { type: 'content_block_delta', delta: { type: 'text_delta', text: delta } }
            yield { type: 'message_delta', usage: { output_tokens: 5 }, delta: { stop_reason: 'end_turn' } }
          })()
        }
        return {
          content: [{ type: 'text', text: responseText }],
          usage: { input_tokens: 7, output_tokens: 3 },
          model: 'claude-sonnet-4-6'
        }
      }
    }
  }
  return { FakeAnthropic: FakeAnthropic as unknown as AnthropicClientCtor, getLastCall: () => lastCall }
}

interface FakeCall {
  url: string
  init: RequestInit
  headers: Record<string, string>
  body: Record<string, unknown>
}

function fakeFetch (
  body: unknown,
  { ok = true, status = 200, resHeaders = {} as Record<string, string> } = {}
): { impl: typeof fetch, getLastCall: () => FakeCall | null } {
  let last: FakeCall | null = null
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<unknown> => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    last = {
      url: String(url),
      init: init ?? {},
      headers,
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    }
    return {
      ok,
      status,
      headers: new Headers(resHeaders),
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    }
  }
  return { impl: impl as unknown as typeof fetch, getLastCall: () => last }
}

/** A fake fetch whose body streams OpenAI-shaped SSE chunks. */
function fakeStreamFetch (deltas: string[]): { impl: typeof fetch, getLastCall: () => FakeCall | null } {
  let last: FakeCall | null = null
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<unknown> => {
    last = {
      url: String(url),
      init: init ?? {},
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    }
    const lines = deltas.map((delta) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`)
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 5 } })}\n\n`)
    lines.push('data: [DONE]\n\n')
    const body = (async function * () { for (const line of lines) yield Buffer.from(line) })()
    return { ok: true, status: 200, headers: new Headers(), body, json: async () => ({}), text: async () => '' }
  }
  return { impl: impl as unknown as typeof fetch, getLastCall: () => last }
}

const anthropicReply = (text: string, usage?: Record<string, number>) => ({
  content: [{ type: 'text', text }],
  model: 'claude-sonnet-4-6',
  ...(usage ? { usage } : {})
})

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

test('listProviders: every built-in is present, BYOK first, the managed backend visible and not gated', () => {
  const providers = listProviders()
  assert.deepEqual(providers.map((provider) => provider.id), ['anthropic', 'openai', 'deepseek', 'local', 'other', 'kip'])

  assert.equal(providers[0].id, 'anthropic', 'BYOK anthropic is the default, first in the list')
  const kip = providers.find((provider) => provider.id === 'kip')
  assert.ok(kip, 'the managed backend is listed — no invite gate')
  assert.equal(kip.managed, true)
  assert.ok(kip.fields.some((field) => field.key === 'apiKey' && field.required))

  // No provider schema carries a cost/price/billing field.
  for (const provider of providers) {
    for (const field of provider.fields) {
      assert.doesNotMatch([field.key, field.label, field.help ?? ''].join(' '), /cost|price|billing|spend|usd/i)
    }
  }
})

// ---------------------------------------------------------------------------
// BYOK providers
// ---------------------------------------------------------------------------

test('callLLM (anthropic): normalizes text/usage/model and never returns a cost', async () => {
  await withEnv({ PROVIDER: 'anthropic' }, async () => {
    const { FakeAnthropic, getLastCall } = fakeAnthropicClient('hello from anthropic')
    const result = await callLLM(
      { system: 'sys', prompt: 'hi', maxTokens: 100 },
      { AnthropicClient: FakeAnthropic, vaultRoot: EMPTY_VAULT }
    )
    assert.equal(result.text, 'hello from anthropic')
    assert.equal(result.provider, 'anthropic')
    assert.equal(result.model, 'claude-sonnet-4-6')
    assert.deepEqual(result.usage, { input: 7, output: 3 })
    assert.equal(result.callId, null)
    assert.equal(result.arenaId, null)
    assert.equal(getLastCall()?.model, 'claude-sonnet-4-6')
    assert.equal(getLastCall()?.system, 'sys')
    assert.ok(!('costUsd' in result))
    assert.doesNotMatch(JSON.stringify(result), /cost|usd|price/i)
  })
})

test('callLLM (openai): uses its key/model/base URL and sums prompt+completion tokens', async () => {
  await withEnv({ PROVIDER: 'openai', OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'gpt-test', OPENAI_BASE_URL: undefined }, async () => {
    const { impl, getLastCall } = fakeFetch({
      choices: [{ message: { content: 'hello from openai' } }],
      usage: { prompt_tokens: 2, completion_tokens: 4 }
    })
    const result = await callLLM({ system: 'sys', prompt: 'hi' }, { fetchImpl: impl, vaultRoot: EMPTY_VAULT })

    assert.equal(result.text, 'hello from openai')
    assert.equal(result.provider, 'openai')
    assert.deepEqual(result.usage, { input: 2, output: 4 })
    assert.ok(getLastCall()?.url.startsWith('https://api.openai.com/v1'))
    assert.equal(getLastCall()?.headers.Authorization, 'Bearer test-key')
    assert.equal(getLastCall()?.body.model, 'gpt-test')
  })
})

test('callLLM (deepseek): uses its fixed base URL and default model', async () => {
  await withEnv({ PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_MODEL: undefined }, async () => {
    const { impl, getLastCall } = fakeFetch({ choices: [{ message: { content: 'hello from deepseek' } }] })
    const result = await callLLM({ system: 'sys', prompt: 'hi' }, { fetchImpl: impl, vaultRoot: EMPTY_VAULT })
    assert.equal(result.text, 'hello from deepseek')
    assert.ok(getLastCall()?.url.startsWith('https://api.deepseek.com'))
    assert.equal(getLastCall()?.body.model, 'deepseek-chat')
  })
})

test('callLLM (local): defaults its base URL and sends no Authorization header', async () => {
  await withEnv({ PROVIDER: 'local', LOCAL_MODEL: 'llama3.1', LOCAL_BASE_URL: undefined }, async () => {
    const { impl, getLastCall } = fakeFetch({ choices: [{ message: { content: 'hello from local' } }] })
    const result = await callLLM({ system: 'sys', prompt: 'hi' }, { fetchImpl: impl, vaultRoot: EMPTY_VAULT })
    assert.equal(result.text, 'hello from local')
    assert.ok(getLastCall()?.url.startsWith('http://localhost:11434/v1'))
    assert.equal(getLastCall()?.headers.Authorization, undefined)
  })
})

test('callLLM: A user can enter an Anthropic, OpenAI, and DeepSeek key and each gets a working completion', async () => {
  // The acceptance criterion, verbatim: three BYOK providers, three completions.
  await withEnv({ PROVIDER: 'anthropic' }, async () => {
    const { FakeAnthropic } = fakeAnthropicClient('a reply')
    const result = await callLLM({ system: '', prompt: 'x' }, { AnthropicClient: FakeAnthropic, vaultRoot: EMPTY_VAULT })
    assert.equal(result.text, 'a reply')
  })
  await withEnv({ PROVIDER: 'openai', OPENAI_API_KEY: 'sk-openai', OPENAI_MODEL: 'gpt-4o-mini' }, async () => {
    const { impl } = fakeFetch({ choices: [{ message: { content: 'o reply' } }] })
    const result = await callLLM({ system: '', prompt: 'x' }, { fetchImpl: impl, vaultRoot: EMPTY_VAULT })
    assert.equal(result.text, 'o reply')
  })
  await withEnv({ PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'sk-deepseek' }, async () => {
    const { impl } = fakeFetch({ choices: [{ message: { content: 'd reply' } }] })
    const result = await callLLM({ system: '', prompt: 'x' }, { fetchImpl: impl, vaultRoot: EMPTY_VAULT })
    assert.equal(result.text, 'd reply')
  })
})

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

test('callLLM: .henhouse/llm.json wins over env, per field', async () => {
  const root = tmpVault()
  saveLLMConfig({ provider: 'openai', providers: { openai: { apiKey: 'file-key', model: 'file-model' } } }, root)

  await withEnv({ PROVIDER: 'anthropic', OPENAI_API_KEY: 'env-key', OPENAI_MODEL: 'env-model' }, async () => {
    const { impl, getLastCall } = fakeFetch({ choices: [{ message: { content: 'from file' } }] })
    const result = await callLLM({ system: 's', prompt: 'p' }, { fetchImpl: impl, vaultRoot: root })
    assert.equal(result.provider, 'openai', 'the file provider wins over env PROVIDER')
    assert.equal(getLastCall()?.body.model, 'file-model')
    assert.equal(getLastCall()?.headers.Authorization, 'Bearer file-key')
  })
})

test('loadLLMConfig/saveLLMConfig: round-trip and a clear error on corrupt JSON', () => {
  const root = tmpVault()
  assert.equal(loadLLMConfig(root), null)
  const config = { provider: 'deepseek', providers: { deepseek: { apiKey: 'sk-x' } } }
  saveLLMConfig(config, root)
  assert.deepEqual(loadLLMConfig(root), config)
  fs.writeFileSync(path.join(root, '.henhouse', 'llm.json'), '{ not json')
  assert.throws(() => loadLLMConfig(root), /not valid JSON/)
})

test('callLLM: missing a required field and an unknown provider both fail clearly', async () => {
  await withEnv({ PROVIDER: 'openai', OPENAI_API_KEY: undefined, OPENAI_MODEL: undefined }, async () => {
    await assert.rejects(
      () => callLLM({ system: 's', prompt: 'p' }, { vaultRoot: EMPTY_VAULT }),
      /OPENAI_API_KEY is required when PROVIDER=openai/
    )
  })
  await withEnv({ PROVIDER: 'not-a-real-provider' }, async () => {
    await assert.rejects(
      () => callLLM({ system: 's', prompt: 'p' }, { vaultRoot: EMPTY_VAULT }),
      /Unknown PROVIDER/
    )
  })
})

// ---------------------------------------------------------------------------
// JSON mode + reasoning models
// ---------------------------------------------------------------------------

test('callLLM: json:true uses response_format, and strips code fences from the reply', async () => {
  await withEnv({ PROVIDER: 'openai', OPENAI_API_KEY: 'k', OPENAI_MODEL: 'gpt-test' }, async () => {
    const { impl, getLastCall } = fakeFetch({ choices: [{ message: { content: '```json\n{"terms":["a"]}\n```' } }] })
    const result = await callLLM({ system: 'sys', prompt: 'hi', json: true }, { fetchImpl: impl, vaultRoot: EMPTY_VAULT })
    assert.equal(result.text, '{"terms":["a"]}')
    assert.deepEqual(getLastCall()?.body.response_format, { type: 'json_object' })
  })
})

test('callLLM: a reasoning model skips response_format and asks for JSON in the prompt', async () => {
  await withEnv({ PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k', DEEPSEEK_MODEL: 'deepseek-reasoner' }, async () => {
    let calls = 0
    const impl = async (_url: string | URL | Request, init?: RequestInit): Promise<unknown> => {
      calls += 1
      const body = JSON.parse(String(init?.body)) as { response_format?: unknown, messages: Array<{ content: string }> }
      assert.equal(body.response_format, undefined)
      assert.match(body.messages[0].content, /ONLY valid JSON/)
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }), text: async () => '' }
    }
    const result = await callLLM({ system: 'sys', prompt: 'hi', json: true }, { fetchImpl: impl as unknown as typeof fetch, vaultRoot: EMPTY_VAULT })
    assert.equal(calls, 1)
    assert.equal(result.text, '{"ok":true}')
  })
})

test('callLLM: a 400 on response_format retries via prompt-and-strip and is remembered', async () => {
  clearLearnedJsonMode()
  await withEnv({ PROVIDER: 'other', OTHER_BASE_URL: 'https://example.test/v1', OTHER_API_KEY: 'k', OTHER_MODEL: 'mystery-thinker-9000' }, async () => {
    let withResponseFormat = 0
    let withoutResponseFormat = 0
    const impl = async (_url: string | URL | Request, init?: RequestInit): Promise<unknown> => {
      const body = JSON.parse(String(init?.body)) as { response_format?: unknown }
      if (body.response_format) {
        withResponseFormat += 1
        return { ok: false, status: 400, headers: new Headers(), text: async () => 'no response_format', json: async () => ({}) }
      }
      withoutResponseFormat += 1
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }), text: async () => '' }
    }
    const options = { fetchImpl: impl as unknown as typeof fetch, vaultRoot: EMPTY_VAULT }
    await callLLM({ system: 's', prompt: 'p', json: true }, options)
    await callLLM({ system: 's', prompt: 'p', json: true }, options)
    assert.equal(withResponseFormat, 1, 'response_format attempted exactly once')
    assert.equal(withoutResponseFormat, 2)
  })
  clearLearnedJsonMode()
})

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

test('callLLM: streams OpenAI-compatible deltas and still returns the full text', async () => {
  await withEnv({ PROVIDER: 'openai', OPENAI_API_KEY: 'k', OPENAI_MODEL: 'gpt-test' }, async () => {
    const { impl, getLastCall } = fakeStreamFetch(['Hel', 'lo ', 'world'])
    const seen: Array<[string, boolean]> = []
    const result = await callLLM(
      { system: 's', prompt: 'p', onStream: (text, first) => seen.push([text, first]) },
      { fetchImpl: impl, vaultRoot: EMPTY_VAULT }
    )
    assert.equal(result.text, 'Hello world')
    assert.deepEqual(seen, [['Hel', true], ['lo ', false], ['world', false]])
    assert.equal(getLastCall()?.body.stream, true)
  })
})

test('callLLM: streams Anthropic text deltas and returns the joined text', async () => {
  await withEnv({ PROVIDER: 'anthropic' }, async () => {
    const { FakeAnthropic, getLastCall } = fakeAnthropicClient('', { streamDeltas: ['Hel', 'lo'] })
    const seen: string[] = []
    const result = await callLLM(
      { system: 's', prompt: 'p', onStream: (text) => seen.push(text) },
      { AnthropicClient: FakeAnthropic, vaultRoot: EMPTY_VAULT }
    )
    assert.equal(result.text, 'Hello')
    assert.deepEqual(seen, ['Hel', 'lo'])
    assert.equal(getLastCall()?.stream, true)
  })
})

test('callLLM: streaming is ignored for json:true', async () => {
  await withEnv({ PROVIDER: 'openai', OPENAI_API_KEY: 'k', OPENAI_MODEL: 'gpt-test' }, async () => {
    const { impl, getLastCall } = fakeFetch({ choices: [{ message: { content: '{"a":1}' } }] })
    const seen: string[] = []
    const result = await callLLM(
      { system: 's', prompt: 'p', json: true, onStream: (text) => seen.push(text) },
      { fetchImpl: impl, vaultRoot: EMPTY_VAULT }
    )
    assert.equal(result.text, '{"a":1}')
    assert.equal(seen.length, 0)
    assert.equal(getLastCall()?.body.stream, undefined)
  })
})

// ---------------------------------------------------------------------------
// The managed backend
// ---------------------------------------------------------------------------

test('callLLM (kip): routes to the managed backend, returns the call id, and drops any cost', async () => {
  await withEnv({ PROVIDER: 'kip', KIP_API_KEY: 'kip_testkey', KIP_BASE_URL: 'http://lan.test:8080' }, async () => {
    const { impl, getLastCall } = fakeFetch(
      { id: 'x', model: 'claude-sonnet-4-6', choices: [{ message: { content: 'hi from kip' } }], usage: { prompt_tokens: 5, completion_tokens: 6 }, cost_usd: 0.00042 },
      { resHeaders: { 'x-kip-call-id': 'call_abc', 'x-kip-cost-usd': '0.00042' } }
    )
    const result = await callLLM(
      { system: 'sys', prompt: 'q', label: 'hatch:generate:entity' },
      { fetchImpl: impl, vaultRoot: EMPTY_VAULT }
    )

    assert.equal(result.text, 'hi from kip')
    assert.equal(result.provider, 'kip')
    assert.equal(result.callId, 'call_abc')
    assert.equal(result.arenaId, null)
    assert.deepEqual(result.usage, { input: 5, output: 6 })
    assert.equal(getLastCall()?.url, 'http://lan.test:8080/v1/chat/completions')
    assert.equal(getLastCall()?.headers.Authorization, 'Bearer kip_testkey')
    assert.equal(getLastCall()?.headers['X-Kip-Workload'], 'hatch:generate:entity')
    assert.equal(getLastCall()?.headers['X-Kip-Phase'], 'hatch')
    assert.equal(getLastCall()?.body.model, 'auto')

    // The backend's own cost numbers must not survive into the result.
    assert.ok(!('costUsd' in result))
    assert.doesNotMatch(JSON.stringify(result), /cost|usd|price|0\.00042/i)
  })
})

test('callLLM (kip): arena routes to /v1/arena/completions and returns callId + arenaId', async () => {
  await withEnv({ PROVIDER: 'kip', KIP_API_KEY: 'kip_testkey', KIP_BASE_URL: 'http://lan.test:8080' }, async () => {
    const arenaBody = {
      arena_id: 'arena_9',
      origin: 'regen',
      b: {
        model: 'claude-sonnet-4-6',
        choices: [{ message: { content: 'the regenerated answer' } }],
        kip_call_id: 'call_B',
        cost_usd: 0.0007
      }
    }
    const { impl, getLastCall } = fakeFetch(arenaBody, { resHeaders: { 'x-kip-arena-id': 'arena_9' } })
    const result = await callLLM(
      { system: 'sys', prompt: 'q', label: 'peck:answer', arena: { compareToCallId: 'call_A' } },
      { fetchImpl: impl, vaultRoot: EMPTY_VAULT }
    )

    assert.equal(result.text, 'the regenerated answer')
    assert.equal(result.callId, 'call_B')
    assert.equal(result.arenaId, 'arena_9')
    assert.equal(getLastCall()?.url, 'http://lan.test:8080/v1/arena/completions')
    assert.equal(getLastCall()?.body.compare_to_call_id, 'call_A')
    assert.equal(getLastCall()?.body.model, 'auto')
    assert.doesNotMatch(JSON.stringify(result), /cost|usd|price|0\.0007/i)
  })
})

test('testConnection (kip): probes auth-only /v1/usage and surfaces no plan/cost numbers', async () => {
  const { impl, getLastCall } = fakeFetch(
    { plan: 'pro', limits: { monthly_token_cap: 5_000_000 } },
    { resHeaders: { 'x-kip-cost-usd': '0.10' } }
  )
  const result = await testConnection(
    { provider: 'kip', apiKey: 'kip_testkey', baseUrl: 'http://lan.test:8080' },
    { fetchImpl: impl, vaultRoot: EMPTY_VAULT }
  )
  assert.equal(result.success, true)
  assert.equal(result.reply, 'connected')
  assert.equal(getLastCall()?.url, 'http://lan.test:8080/v1/usage')
  assert.equal(getLastCall()?.headers.Authorization, 'Bearer kip_testkey')
  assert.doesNotMatch(JSON.stringify(result), /pro|5,?000,?000|0\.10|cost|cap|plan/i)
})

test('testConnection: unknown provider and missing required field fail without a request', async () => {
  const unknown = await testConnection({ provider: 'nope' }, { vaultRoot: EMPTY_VAULT })
  assert.equal(unknown.success, false)
  assert.match(unknown.error ?? '', /Unknown provider/)

  const missing = await testConnection({ provider: 'openai' }, { vaultRoot: EMPTY_VAULT })
  assert.equal(missing.success, false)
  assert.match(missing.error ?? '', /required/)
})

// ---------------------------------------------------------------------------
// createLLMCompleter — the sidecar's CompleteFn, incl. managed usage reporting
// ---------------------------------------------------------------------------

test('createLLMCompleter: maps a BYOK call to CompleteFn and reports nothing', async () => {
  const reports: unknown[] = []
  const complete = createLLMCompleter(EMPTY_VAULT, {
    usageReporter: {
      report: (report) => reports.push(report),
      flush: async () => {},
      stop: () => {},
      get pending () { return 0 }
    },
    AnthropicClient: fakeAnthropicClient('sidecar answer').FakeAnthropic
  })
  await withEnv({ PROVIDER: 'anthropic' }, async () => {
    const result = await complete({ system: 's', prompt: 'p' })
    assert.equal(result.text, 'sidecar answer')
    assert.deepEqual(result.usage, { input: 7, output: 3 })
  })
  // The reporter is consulted (it decides); the BYOK no-op is enforced inside
  // the real reporter, which the usage tests below cover directly.
  assert.equal(reports.length, 1)
  assert.deepEqual(reports[0], {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    label: 'sidecar:turn',
    callId: null,
    inputTokens: 7,
    outputTokens: 3
  })
})

test('createLLMCompleter: a managed call is reported with its call id', async () => {
  const reports: Array<{ provider: string, callId: string | null }> = []
  const { impl } = fakeFetch(
    { model: 'claude-sonnet-4-6', choices: [{ message: { content: 'managed' } }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
    { resHeaders: { 'x-kip-call-id': 'call_9' } }
  )
  const complete = createLLMCompleter(EMPTY_VAULT, {
    usageReporter: {
      report: (report) => reports.push({ provider: report.provider, callId: report.callId }),
      flush: async () => {},
      stop: () => {},
      get pending () { return 0 }
    },
    fetchImpl: impl
  })
  await withEnv({ PROVIDER: 'kip', KIP_API_KEY: 'kip_x', KIP_BASE_URL: 'http://lan.test:8080' }, async () => {
    await complete({ system: 's', prompt: 'p01' })
  })
  assert.deepEqual(reports, [{ provider: 'kip', callId: 'call_9' }])
})

// ---------------------------------------------------------------------------
// usage.ts — managed-path token reporting, and only that
// ---------------------------------------------------------------------------

test('createUsageReporter: a BYOK report is a hard no-op (no queue, no network)', async () => {
  const { impl, getLastCall } = fakeFetch({})
  const reporter = createUsageReporter({ vaultRoot: EMPTY_VAULT, fetchImpl: impl, flushMs: 0 })
  reporter.report({ provider: 'openai', model: 'gpt-4o', label: 'peck:answer', callId: null, inputTokens: 10, outputTokens: 20 })
  assert.equal(reporter.pending, 0)
  await reporter.flush()
  assert.equal(getLastCall(), null, 'BYOK never reports usage anywhere')
})

test('createUsageReporter: a managed report flushes call_id/model/workload/tokens upstream — never a price', async () => {
  const { impl, getLastCall } = fakeFetch({})
  const reporter = createUsageReporter({
    vaultRoot: EMPTY_VAULT,
    fetchImpl: impl,
    env: { PROVIDER: 'kip', KIP_API_KEY: 'kip_x', KIP_BASE_URL: 'http://lan.test:8080' } as NodeJS.ProcessEnv,
    flushMs: 0
  })
  reporter.report({ provider: 'kip', model: 'claude-sonnet-4-6', label: 'hatch:generate:entity', callId: 'call_1', inputTokens: 11, outputTokens: 22 })
  assert.equal(reporter.pending, 1)
  await reporter.flush()

  assert.equal(reporter.pending, 0)
  assert.equal(getLastCall()?.url, 'http://lan.test:8080/v1/usage')
  assert.equal(getLastCall()?.headers.Authorization, 'Bearer kip_x')
  const body = getLastCall()?.body as { calls: Array<Record<string, unknown>> }
  assert.deepEqual(body.calls, [{
    call_id: 'call_1',
    model: 'claude-sonnet-4-6',
    workload: 'hatch:generate:entity',
    input_tokens: 11,
    output_tokens: 22
  }])
  assert.doesNotMatch(JSON.stringify(body), /cost|price|usd|spend|billing/i)
})

test('createUsageReporter: a managed report with no key is dropped, not queued forever', async () => {
  const { impl, getLastCall } = fakeFetch({})
  const reporter = createUsageReporter({
    vaultRoot: EMPTY_VAULT,
    fetchImpl: impl,
    env: { PROVIDER: 'kip', KIP_API_KEY: undefined } as NodeJS.ProcessEnv,
    flushMs: 0
  })
  reporter.report({ provider: 'kip', model: null, label: null, callId: null, inputTokens: 1, outputTokens: 2 })
  await reporter.flush()
  assert.equal(reporter.pending, 0)
  assert.equal(getLastCall(), null)
})

// ---------------------------------------------------------------------------
// The user-facing wire surface stays cost-free
// ---------------------------------------------------------------------------

test('the sidecar protocol carries no cost/billing/price field', () => {
  const offenders = Object.keys(payloadSchemas).filter((event) => /cost|price|billing|spend|usd/i.test(event))
  assert.deepEqual(offenders, [], 'no protocol event may mention money')
})
