// The BYOK provider client (P7, kip#79) — the native TypeScript port of
// scripts/lib/llm.js + scripts/lib/connectors.js + scripts/lib/kip-connector.js.
//
// One entry point, `callLLM()`, routes a completion to whichever provider the
// coop's `.henhouse/llm.json` (or the PROVIDER env var) selects. The built-in
// providers are all BYOK: Anthropic (its own Messages API) and the
// OpenAI-compatible family (openai / deepseek / local / other), plus the
// managed "kip" backend as a visible, opt-in alternative.
//
// Deliberate non-goals, per kip#79's acceptance criteria:
//   * No usage/cost/billing logic is built for the BYOK path. In fact no cost
//     value is read or returned at all — the managed backend's cost header is
//     intentionally ignored, so no price can leak into the local app.
//   * The result carries token counts (they drive the turn loop) but never a
//     price. Managed-backend call metering goes up to the backend via
//     ./usage.ts only.
//
// Test seams mirror the JS host: `AnthropicClient` replaces the SDK class and
// `fetchImpl` replaces fetch, so the suite runs with no key and no network.

import { createRequire } from 'node:module'
import type { CompleteFn, CompleteResult as TurnCompleteResult } from '../session/turn.ts'
import {
  KIP_BASE_URL_DEFAULT,
  missingRequiredField,
  providerInfo,
  requiredFieldError,
  resolveActive,
  resolveConfig,
  type ActiveProvider,
  type ProviderConfig,
  type ProviderId
} from './config.ts'
import type { CallUsageReport, UsageReporter } from './usage.ts'

const require = createRequire(import.meta.url)

const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6'
const JSON_MODE_INSTRUCTION =
  'Respond with ONLY valid JSON and no other text — no markdown code fences, no explanation.'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Token counts only. A price never crosses this boundary (kip#79). */
export interface Usage {
  input: number
  output: number
}

export interface ArenaRequest {
  /** Route this call as candidate B against an existing answer (the regenerate free-rider). */
  compareToCallId?: string
}

export interface CompleteRequest {
  system: string
  prompt: string
  json?: boolean
  maxTokens?: number
  label?: string
  arena?: ArenaRequest | null
  onStream?: ((text: string, first: boolean) => void) | null
}

export interface CompleteResult {
  text: string
  usage: Usage
  /** Which provider produced this call (used by the managed-path usage reporter). */
  provider: ProviderId
  model: string | null
  label: string | null
  /** The managed backend's per-call id; null for BYOK. */
  callId: string | null
  /** Set only when an arena comparison ran; null otherwise. */
  arenaId: string | null
}

export interface CallOptions {
  vaultRoot?: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  AnthropicClient?: AnthropicClientCtor
  env?: NodeJS.ProcessEnv
}

/** One provider's raw completion before normalization. Cost is never present. */
interface RawCompletion {
  text: string
  raw: unknown
  callId?: string | null
  arenaId?: string | null
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

interface AnthropicContentBlock {
  type: string
  text?: string
  thinking?: string
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[]
  usage?: Record<string, number>
  model?: string
  stop_reason?: string | null
}

interface AnthropicMessagesApi {
  create (args: Record<string, unknown>): Promise<AnthropicResponse | AsyncIterable<unknown>>
}

export interface AnthropicClient {
  messages: AnthropicMessagesApi
}

export type AnthropicClientCtor = new (options?: { apiKey?: string }) => AnthropicClient

interface AnthropicStreamEvent {
  type?: string
  delta?: { type?: string; text?: string; stop_reason?: string }
  message?: { usage?: Record<string, number> }
  usage?: Record<string, number>
}

function stripCodeFences (text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/)
  return fenced ? fenced[1].trim() : trimmed
}

function anthropicCtor (ctor?: AnthropicClientCtor): AnthropicClientCtor {
  return ctor ?? (require('@anthropic-ai/sdk') as AnthropicClientCtor)
}

/**
 * Anthropic has no forced-JSON mode: for json:true, ask for it in the system
 * prompt and strip fences after. A streaming sink only applies to prose — a
 * JSON call needs the whole string before its fences can be stripped.
 */
async function callAnthropicOnce (
  active: ActiveProvider,
  request: CompleteRequest,
  ctx: CallContext
): Promise<RawCompletion> {
  const Anthropic = anthropicCtor(ctx.AnthropicClient)
  const apiKey = active.config.apiKey
  const client = apiKey ? new Anthropic({ apiKey }) : new Anthropic()

  const json = request.json === true
  const system = request.system
  const finalSystem = json
    ? (system ? `${system}\n\n${JSON_MODE_INSTRUCTION}` : JSON_MODE_INSTRUCTION)
    : system

  const createArgs: Record<string, unknown> = {
    model: DEFAULT_ANTHROPIC_MODEL,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: finalSystem,
    messages: [{ role: 'user', content: request.prompt }]
  }

  if (!json && ctx.onDelta) {
    const stream = (await client.messages.create({ ...createArgs, stream: true })) as AsyncIterable<unknown>
    let text = ''
    let usage: Record<string, number> | undefined
    let stopReason: string | null = null
    let first = true
    for await (const value of stream) {
      const event = value as AnthropicStreamEvent
      if (!event || typeof event !== 'object') continue
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        text += event.delta.text
        try { ctx.onDelta(event.delta.text, first) } catch { /* best-effort */ }
        first = false
      } else if (event.type === 'message_start' && event.message?.usage) {
        usage = { ...event.message.usage }
      } else if (event.type === 'message_delta') {
        if (event.usage) usage = { ...(usage ?? {}), ...event.usage }
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason
      }
    }
    return {
      text: text.trim(),
      raw: { content: [{ type: 'text', text }], usage: usage ?? undefined, stop_reason: stopReason }
    }
  }

  const response = (await client.messages.create(createArgs)) as AnthropicResponse
  const rawText = (response.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim()
  return { text: json ? stripCodeFences(rawText) : rawText, raw: response }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (openai / deepseek / local / other)
// ---------------------------------------------------------------------------

// Reasoning models (DeepSeek `deepseek-reasoner` / `r1`, OpenAI `o1`/`o3`/
// `o4-mini`, …) reject `response_format`, so a json:true call goes straight to
// prompt-and-strip instead of eating a 400 and a second round-trip. A miss
// costs one wasted round-trip once; any model that actually 400s is remembered
// for the rest of the process.
const REASONING_MODEL_RE = /(?:^|[-/:_])(?:o[1-9](?:-mini|-preview|-pro)?|r1|qwq|magistral|[a-z]*reasoner|[a-z]*reasoning|[a-z]*thinking)(?:$|[-/:_])/i

export function isReasoningModel (model: string | null | undefined): boolean {
  return typeof model === 'string' && REASONING_MODEL_RE.test(model)
}

const learnedNoResponseFormat = new Set<string>()
const jsonModeKey = (baseUrl: string | undefined, model: string | undefined): string => `${baseUrl ?? ''}::${model ?? ''}`

/** Clears the per-process response_format skip cache (tests only). */
export function clearLearnedJsonMode (): void {
  learnedNoResponseFormat.clear()
}

/** node/undici `fetch` buries the real transport reason in err.cause — surface it. */
function networkError (url: string, err: unknown): Error {
  const cause = (err as { cause?: { code?: string } })?.cause
  const code = cause?.code
  const hints: Record<string, string> = {
    ECONNREFUSED: `Nothing is listening at ${url} — check the backend is running and the host/port are right.`,
    ETIMEDOUT: `No response from ${url} — check the address, and that this machine can reach it (firewall / VPN / wrong network / a system proxy).`,
    ENOTFOUND: `Can't resolve the host in ${url}.`,
    EAI_AGAIN: `Can't resolve the host in ${url} (DNS).`,
    ECONNRESET: `The connection to ${url} was reset.`,
    CERT_HAS_EXPIRED: "The backend's TLS certificate has expired.",
    DEPTH_ZERO_SELF_SIGNED_CERT: "The backend's TLS certificate isn't trusted — use http:// for a LAN backend, or install its certificate."
  }
  const error = new Error(hints[code ?? ''] ?? `Couldn't reach ${url}${code ? ` (${code})` : ''}.`)
  if (code) (error as { code?: string }).code = code
  ;(error as { cause?: unknown }).cause = err
  return error
}

interface HttpResponseLike {
  ok: boolean
  status: number
  headers?: { get (name: string): string | null }
  json(): Promise<unknown>
  text(): Promise<string>
  body?: unknown
}

async function postJson (
  url: string,
  body: unknown,
  headers: Record<string, string>,
  doFetch: typeof fetch,
  signal?: AbortSignal
): Promise<HttpResponseLike> {
  let response: HttpResponseLike
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal
    }) as unknown as HttpResponseLike
  } catch (err) {
    throw networkError(url, err)
  }
  if (!response.ok) {
    const detail = await errorDetail(response)
    const error = new Error(`${url} request failed (${response.status})${detail ? `: ${detail}` : ''}`) as Error & { status?: number }
    error.status = response.status
    throw error
  }
  return response
}

async function errorDetail (response: HttpResponseLike): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } } | null
    if (body?.error?.message) return body.error.message
  } catch { /* non-JSON error body */ }
  try {
    return await response.text()
  } catch {
    return ''
  }
}

interface ByteStream {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>
    cancel(reason?: unknown): Promise<void>
  }
}

async function * iterateBody (body: unknown): AsyncIterable<Uint8Array | string> {
  if (!body) return
  const iterable = body as AsyncIterable<Uint8Array | string>
  if (typeof iterable[Symbol.asyncIterator] === 'function') {
    yield * iterable
    return
  }
  const stream = body as ByteStream
  if (typeof stream.getReader === 'function') {
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) yield value
    }
  }
}

/** Posts /chat/completions (streaming or not) and returns the parsed body. */
async function postChatCompletion (
  baseUrl: string,
  apiKey: string | undefined,
  body: Record<string, unknown>,
  doFetch: typeof fetch,
  signal?: AbortSignal
): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const response = await postJson(`${baseUrl.replace(/\/$/, '')}/chat/completions`, body, headers, doFetch, signal)
  return response.json()
}

/**
 * POST /chat/completions with stream:true and consume the SSE deltas, calling
 * onDelta(textChunk, isFirst). Returns the same shape as the non-streaming
 * path ({ choices: [{ message: { content }, finish_reason }], usage, model }).
 */
async function streamChatCompletion (
  baseUrl: string,
  apiKey: string | undefined,
  body: Record<string, unknown>,
  doFetch: typeof fetch,
  onDelta: (text: string, first: boolean) => void,
  signal?: AbortSignal
): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const response = await postJson(
    `${baseUrl.replace(/\/$/, '')}/chat/completions`,
    { ...body, stream: true },
    headers,
    doFetch,
    signal
  )

  let text = ''
  let usage: unknown = null
  let model: string | undefined
  let finishReason: string | null = null
  let first = true
  let buffer = ''
  const decoder = new TextDecoder()

  const handleData = (payload: string): void => {
    if (payload === '[DONE]') return
    let parsed: {
      model?: string
      usage?: unknown
      choices?: Array<{ delta?: { content?: string }, finish_reason?: string }>
    }
    try {
      parsed = JSON.parse(payload)
    } catch {
      return
    }
    if (parsed.model) model = parsed.model
    if (parsed.usage) usage = parsed.usage
    const choice = parsed.choices?.[0]
    if (!choice) return
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta?.content
    if (delta) {
      text += delta
      try { onDelta(delta, first) } catch { /* best-effort */ }
      first = false
    }
  }

  for await (const chunk of iterateBody(response.body)) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.startsWith('data:')) handleData(line.slice(5).trim())
    }
  }
  const tail = buffer.trim()
  if (tail.startsWith('data:')) handleData(tail.slice(5).trim())

  return {
    choices: [{ message: { content: text }, finish_reason: finishReason }],
    usage,
    model
  }
}

async function callOpenAICompatible (
  active: ActiveProvider,
  request: CompleteRequest,
  ctx: CallContext
): Promise<RawCompletion> {
  const doFetch = ctx.fetch
  const baseUrl = active.config.baseUrl ?? ''
  const apiKey = active.config.apiKey
  const model = active.model ?? ''
  const json = request.json === true
  const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS

  const buildMessages = (system: string): Array<{ role: string, content: string }> => {
    const messages: Array<{ role: string, content: string }> = []
    if (system) messages.push({ role: 'system', content: system })
    messages.push({ role: 'user', content: request.prompt })
    return messages
  }

  const promptStrip = (): Promise<unknown> => {
    const jsonSystem = request.system ? `${request.system}\n\n${JSON_MODE_INSTRUCTION}` : JSON_MODE_INSTRUCTION
    return postChatCompletion(baseUrl, apiKey, {
      model,
      max_tokens: maxTokens,
      messages: buildMessages(jsonSystem)
    }, doFetch, ctx.signal)
  }

  const skipNativeJson = isReasoningModel(model) || learnedNoResponseFormat.has(jsonModeKey(baseUrl, model))

  let data: unknown
  if (!json && ctx.onDelta) {
    data = await streamChatCompletion(baseUrl, apiKey, {
      model,
      max_tokens: maxTokens,
      messages: buildMessages(request.system)
    }, doFetch, ctx.onDelta, ctx.signal)
  } else if (!json) {
    data = await postChatCompletion(baseUrl, apiKey, {
      model,
      max_tokens: maxTokens,
      messages: buildMessages(request.system)
    }, doFetch, ctx.signal)
  } else if (skipNativeJson) {
    data = await promptStrip()
  } else {
    try {
      data = await postChatCompletion(baseUrl, apiKey, {
        model,
        max_tokens: maxTokens,
        messages: buildMessages(request.system),
        response_format: { type: 'json_object' }
      }, doFetch, ctx.signal)
    } catch (err) {
      // Only a 400 means "this model won't take response_format"; a 401/429/5xx
      // or network blip still gets the prompt-strip retry but teaches nothing.
      if ((err as { status?: number }).status === 400) {
        learnedNoResponseFormat.add(jsonModeKey(baseUrl, model))
      }
      data = await promptStrip()
    }
  }

  const rawText = (data as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? ''
  return { text: json ? stripCodeFences(rawText) : rawText.trim(), raw: data }
}

// ---------------------------------------------------------------------------
// The managed Kip backend
// ---------------------------------------------------------------------------

/** "hatch:generate:entity" -> "hatch"; "" / no label -> null (header omitted). */
export function phaseOf (label: string | null | undefined): string | null {
  if (!label || typeof label !== 'string') return null
  const first = label.split(':')[0].trim()
  return first || null
}

function buildMessages (system: string, prompt: string): Array<{ role: string, content: string }> {
  const messages: Array<{ role: string, content: string }> = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt })
  return messages
}

const headerValue = (response: HttpResponseLike, name: string): string | null =>
  response.headers && typeof response.headers.get === 'function' ? response.headers.get(name) : null

const completionText = (value: unknown): string =>
  (value as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? ''

interface ManagedCompletion {
  data: unknown
  callId: string | null
  arenaId: string | null
}

async function postManaged (
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  doFetch: typeof fetch,
  signal?: AbortSignal
): Promise<ManagedCompletion> {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`
  const response = await postJson(url, body, { Authorization: `Bearer ${apiKey}`, ...headers }, doFetch, signal)
  return {
    data: await response.json(),
    callId: headerValue(response, 'x-kip-call-id'),
    // The backend's cost header (X-Kip-Cost-Usd) is deliberately NOT read — no
    // price may enter the local app (kip#79).
    arenaId: headerValue(response, 'x-kip-arena-id')
  }
}

async function postArena (
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  doFetch: typeof fetch,
  signal?: AbortSignal
): Promise<{ data: unknown, arenaId: string | null }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/arena/completions`
  const response = await postJson(url, body, { Authorization: `Bearer ${apiKey}`, ...headers }, doFetch, signal)
  const data = await response.json()
  const arenaId = (data as { arena_id?: string }).arena_id ?? headerValue(response, 'x-kip-arena-id')
  return { data, arenaId }
}

async function callManaged (
  active: ActiveProvider,
  request: CompleteRequest,
  ctx: CallContext
): Promise<RawCompletion> {
  const apiKey = active.config.apiKey ?? ''
  const baseUrl = active.config.baseUrl || KIP_BASE_URL_DEFAULT
  const doFetch = ctx.fetch

  const routingHeaders: Record<string, string> = {}
  if (request.label) {
    routingHeaders['X-Kip-Workload'] = request.label
    const phase = phaseOf(request.label)
    if (phase) routingHeaders['X-Kip-Phase'] = phase
  }

  const base: Record<string, unknown> = {
    model: 'auto',
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: buildMessages(request.system, request.prompt)
  }

  // Arena: candidate B against an existing answer (the regenerate free-rider).
  if (request.arena) {
    const arenaBody: Record<string, unknown> = { ...base }
    if (request.arena.compareToCallId) arenaBody.compare_to_call_id = request.arena.compareToCallId
    const { data, arenaId } = await postArena(baseUrl, apiKey, arenaBody, routingHeaders, doFetch, ctx.signal)
    const candidate = (data as { b?: unknown }).b ?? {}
    return {
      text: String(completionText(candidate)).trim(),
      raw: candidate,
      callId: (candidate as { kip_call_id?: string }).kip_call_id ?? null,
      arenaId: arenaId ?? null
    }
  }

  let result: ManagedCompletion
  if (request.json) {
    try {
      result = await postManaged(baseUrl, apiKey, { ...base, response_format: { type: 'json_object' } }, routingHeaders, doFetch, ctx.signal)
    } catch (err) {
      // A routing/plan/auth error is real — only retry a plain 400 (upstream
      // rejected response_format), matching the OpenAI-compatible path.
      if ((err as { status?: number }).status !== 400) throw err
      const system = request.system ? `${request.system}\n\n${JSON_MODE_INSTRUCTION}` : JSON_MODE_INSTRUCTION
      result = await postManaged(baseUrl, apiKey, { ...base, messages: buildMessages(system, request.prompt) }, routingHeaders, doFetch, ctx.signal)
    }
  } else {
    result = await postManaged(baseUrl, apiKey, base, routingHeaders, doFetch, ctx.signal)
  }

  const raw = completionText(result.data)
  return {
    text: request.json ? stripCodeFences(raw) : String(raw).trim(),
    raw: result.data,
    callId: result.callId,
    arenaId: null
  }
}

/** GET {baseUrl}/v1/usage — auth-only. The cheapest "key + connectivity" probe. */
async function getManagedUsage (active: ActiveProvider, ctx: CallContext): Promise<void> {
  const apiKey = active.config.apiKey ?? ''
  const baseUrl = (active.config.baseUrl || KIP_BASE_URL_DEFAULT).replace(/\/+$/, '')
  const url = `${baseUrl}/v1/usage`
  let response: HttpResponseLike
  try {
    response = await ctx.fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctx.signal
    }) as unknown as HttpResponseLike
  } catch (err) {
    throw networkError(url, err)
  }
  if (!response.ok) {
    const detail = await errorDetail(response)
    const error = new Error(`Kip backend request failed (${response.status})${detail ? `: ${detail}` : ''}`) as Error & { status?: number }
    error.status = response.status
    throw error
  }
}

// ---------------------------------------------------------------------------
// Normalization + the one entry point
// ---------------------------------------------------------------------------

interface CallContext {
  fetch: typeof fetch
  signal?: AbortSignal
  onDelta: ((text: string, first: boolean) => void) | null
  AnthropicClient?: AnthropicClientCtor
}

function usageFromRaw (raw: unknown): Usage {
  const usage = (raw && typeof raw === 'object' ? (raw as { usage?: Record<string, number> }).usage : undefined) ?? {}
  return {
    input: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    output: usage.output_tokens ?? usage.completion_tokens ?? 0
  }
}

function modelFromRaw (raw: unknown): string | null {
  const model = raw && typeof raw === 'object' ? (raw as { model?: unknown }).model : undefined
  return typeof model === 'string' && model ? model : null
}

async function completeWith (
  active: ActiveProvider,
  request: CompleteRequest,
  ctx: CallContext
): Promise<RawCompletion> {
  if (active.id === 'kip') return callManaged(active, request, ctx)
  if (active.id === 'anthropic') return callAnthropicOnce(active, request, ctx)
  return callOpenAICompatible(active, request, ctx)
}

/**
 * The one entry point every caller uses. Routes to the connector named by
 * `.henhouse/llm.json` / the PROVIDER env var (default "anthropic"); always
 * resolves to the same shape. `callId` is the managed backend's per-call id
 * (null for every BYOK provider); `arenaId` is set only for a managed arena
 * comparison. No `costUsd` exists on the result — that is the point.
 */
export async function callLLM (request: CompleteRequest, options: CallOptions = {}): Promise<CompleteResult> {
  const active = resolveActive(options.vaultRoot, options.env)
  const missing = missingRequiredField(active.info, active.config)
  if (missing) throw requiredFieldError(active.info, missing)

  const json = request.json === true
  const ctx: CallContext = {
    fetch: options.fetchImpl ?? fetch,
    signal: options.signal,
    // Streaming is prose-only: a json:true call has no partial value.
    onDelta: (!json && typeof request.onStream === 'function') ? request.onStream : null,
    AnthropicClient: options.AnthropicClient
  }

  const raw = await completeWith(active, { ...request, json }, ctx)
  return {
    text: raw.text,
    usage: usageFromRaw(raw.raw),
    provider: active.id,
    model: modelFromRaw(raw.raw) ?? active.model,
    label: request.label ?? null,
    callId: raw.callId ?? null,
    arenaId: raw.arenaId ?? null
  }
}

export interface CompleterOptions {
  /** When set, a managed (kip) call's token counts are reported up to the backend. */
  usageReporter?: UsageReporter
  fetchImpl?: typeof fetch
  AnthropicClient?: AnthropicClientCtor
  env?: NodeJS.ProcessEnv
}

/**
 * The sidecar's `CompleteFn`: one tiny completion interface the turn loop and
 * skills consume. Managed-backend metering rides along as an optional
 * side-channel (./usage.ts) — nothing is surfaced to the client.
 */
export function createLLMCompleter (
  vaultRoot?: string,
  options: CompleterOptions = {}
): CompleteFn {
  return async ({ system, prompt, onDelta, signal, label }) => {
    const result = await callLLM(
      { system, prompt, maxTokens: DEFAULT_MAX_TOKENS, label: label ?? 'sidecar:turn', onStream: onDelta ?? null },
      { vaultRoot, signal, fetchImpl: options.fetchImpl, AnthropicClient: options.AnthropicClient, env: options.env }
    )
    options.usageReporter?.report(toUsageReport(result))
    return { text: result.text, usage: { input: result.usage.input, output: result.usage.output } } satisfies TurnCompleteResult
  }
}

function toUsageReport (result: CompleteResult): CallUsageReport {
  return {
    provider: result.provider,
    model: result.model,
    label: result.label,
    callId: result.callId,
    inputTokens: result.usage.input,
    outputTokens: result.usage.output
  }
}

export interface TestConnectionCandidate {
  provider?: string
  apiKey?: string
  model?: string
  baseUrl?: string
}

/**
 * Fires a trivial completion (or, for the managed backend, an auth-only usage
 * probe) against an explicit, possibly-unsaved provider config — the settings
 * UI's "test connection". Bypasses the file/env provider choice for the
 * candidate's own fields but still falls back per field. Never throws.
 */
export async function testConnection (
  candidate: TestConnectionCandidate = {},
  options: CallOptions = {}
): Promise<{ success: boolean, reply?: string, error?: string }> {
  const info = candidate.provider ? providerInfo(candidate.provider) : null
  if (!info) return { success: false, error: `Unknown provider "${candidate.provider ?? ''}".` }

  const candidateConfig: Record<string, string | undefined> = {}
  for (const key of ['apiKey', 'model', 'baseUrl'] as const) {
    if (candidate[key] !== undefined) candidateConfig[key] = candidate[key]
  }
  const config: ProviderConfig = resolveConfig(info, candidateConfig, options.env ?? process.env)
  const missing = missingRequiredField(info, config)
  if (missing) return { success: false, error: `${missing.label} is required.` }

  const active: ActiveProvider = { id: info.id, info, config, model: config.model || info.staticModel || null }
  const ctx: CallContext = {
    fetch: options.fetchImpl ?? fetch,
    signal: options.signal,
    onDelta: null,
    AnthropicClient: options.AnthropicClient
  }

  try {
    if (info.managed) {
      await getManagedUsage(active, ctx)
      return { success: true, reply: 'connected' }
    }
    const result = await completeWith(active, {
      system: '',
      prompt: 'Reply with exactly: OK',
      json: false,
      maxTokens: 10,
      label: 'test:connection'
    }, ctx)
    return { success: true, reply: result.text }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export { DEFAULT_ANTHROPIC_MODEL }
