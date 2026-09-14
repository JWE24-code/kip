// Parent-side hostcalls (P6, kip#77) — the only path by which a skill can
// reach the network or the LLM.
//
// The skill process itself runs with every network permission denied
// (executor.ts spawns it under Node's permission model with no `--allow-net`),
// so `fetch`, `http`, sockets, and DNS all fail inside it. When a skill needs
// the outside world it asks the parent, which has network access, over an IPC
// hostcall. The parent then checks the request against the manifest's declared
// capabilities before doing anything:
//
//   * the hostcall must be declared in `hostcalls:`
//   * `fetch_url` must also pass the manifest's `network:` policy
//   * the LLM key is never sent to the skill; `llm.complete` runs in the parent
//
// This is the FR-25/FR-27 boundary: credentials stay in the parent, and
// outbound access is opt-in per skill, not ambient.

import type { NetworkPolicy } from './manifest.ts'

export const HOSTCALL_NAMES = {
  FETCH_URL: 'fetch_url',
  LLM_COMPLETE: 'llm.complete'
} as const

export type HostcallName = (typeof HOSTCALL_NAMES)[keyof typeof HOSTCALL_NAMES]

export const HOSTCALL_ERRORS = {
  UNKNOWN: 'HOSTCALL_UNKNOWN',
  DENIED: 'HOSTCALL_DENIED',
  BAD_ARGS: 'HOSTCALL_BAD_ARGS',
  NETWORK_DENIED: 'NETWORK_DENIED',
  FETCH_FAILED: 'FETCH_FAILED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED'
} as const

export type HostcallErrorCode = (typeof HOSTCALL_ERRORS)[keyof typeof HOSTCALL_ERRORS]

export class CapabilityError extends Error {
  code: HostcallErrorCode

  constructor (code: HostcallErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'CapabilityError'
    this.code = code
  }
}

const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024

export interface LlmCompleteRequest {
  prompt: string
  system?: string
}

export interface LlmCompleteResult {
  text: string
}

export type LlmCompleteFn = (request: LlmCompleteRequest) => Promise<LlmCompleteResult>

export interface HostcallContext {
  /** Manifest policy: which hosts `fetch_url` may reach. */
  network: NetworkPolicy
  /** Manifest's declared `hostcalls:`; anything else is refused. */
  hostcalls: string[]
  fetchImpl: typeof fetch
  /** Injected by the sidecar; absent means `llm.complete` is unavailable. */
  llm?: LlmCompleteFn
  signal: AbortSignal
  maxResponseBytes?: number
}

/**
 * Host allowlist check. `all` allows everything; `none` nothing; `hosts`
 * matches exactly (case-insensitive) or via a `*.example.com` wildcard, which
 * also matches `example.com` itself.
 */
export function hostAllowed (network: NetworkPolicy, hostname: string): boolean {
  if (network.mode === 'all') return true
  if (network.mode === 'none') return false
  const host = hostname.trim().toLowerCase()
  if (!host) return false
  for (const raw of network.hosts) {
    const pattern = raw.trim().toLowerCase()
    if (!pattern) continue
    if (pattern === host) return true
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1) // ".example.com"
      if (host.endsWith(suffix) || host === pattern.slice(2)) return true
    }
  }
  return false
}

function requireDeclared (name: HostcallName, ctx: HostcallContext): void {
  if (!ctx.hostcalls.includes(name)) {
    throw new CapabilityError(HOSTCALL_ERRORS.DENIED, `skill did not declare the "${name}" hostcall`)
  }
}

function asObject (args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new CapabilityError(HOSTCALL_ERRORS.BAD_ARGS, 'hostcall arguments must be an object')
  }
  return args as Record<string, unknown>
}

/** Streams a fetch response body, stopping at `maxBytes`. */
async function readCapped (
  response: Response,
  maxBytes: number
): Promise<{ body: string, truncated: boolean }> {
  if (!response.body) return { body: '', truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    if (total + value.byteLength > maxBytes) {
      const remaining = Math.max(0, maxBytes - total)
      if (remaining > 0) chunks.push(value.subarray(0, remaining))
      total += remaining
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
    total += value.byteLength
  }
  return { body: Buffer.concat(chunks).toString('utf8'), truncated }
}

async function fetchUrl (args: unknown, ctx: HostcallContext): Promise<Record<string, unknown>> {
  const request = asObject(args)
  const url = typeof request.url === 'string' ? request.url.trim() : ''
  if (!url) throw new CapabilityError(HOSTCALL_ERRORS.BAD_ARGS, 'fetch_url requires a "url" string')

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new CapabilityError(HOSTCALL_ERRORS.BAD_ARGS, `not a valid URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CapabilityError(HOSTCALL_ERRORS.BAD_ARGS, `unsupported scheme "${parsed.protocol}"`)
  }
  if (!hostAllowed(ctx.network, parsed.hostname)) {
    throw new CapabilityError(HOSTCALL_ERRORS.NETWORK_DENIED, `network policy does not allow "${parsed.hostname}"`)
  }

  const method = typeof request.method === 'string' ? request.method.toUpperCase() : 'GET'
  const headers: Record<string, string> = {}
  if (request.headers && typeof request.headers === 'object' && !Array.isArray(request.headers)) {
    for (const [key, value] of Object.entries(request.headers as Record<string, unknown>)) {
      if (typeof value === 'string') headers[key] = value
    }
  }
  const body = typeof request.body === 'string' ? request.body : undefined

  let response: Response
  try {
    response = await ctx.fetchImpl(url, { method, headers, ...(body !== undefined ? { body } : {}), signal: ctx.signal })
  } catch (err) {
    throw new CapabilityError(HOSTCALL_ERRORS.FETCH_FAILED, `fetch failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  const maxBytes = ctx.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const { body: text, truncated } = await readCapped(response, maxBytes)
  return {
    url: response.url || url,
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get('content-type') ?? '',
    body: text,
    truncated
  }
}

async function llmComplete (args: unknown, ctx: HostcallContext): Promise<Record<string, unknown>> {
  const request = asObject(args)
  const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : ''
  if (!prompt) throw new CapabilityError(HOSTCALL_ERRORS.BAD_ARGS, 'llm.complete requires a "prompt" string')
  if (!ctx.llm) throw new CapabilityError(HOSTCALL_ERRORS.NOT_IMPLEMENTED, 'no LLM backend is configured')
  const system = typeof request.system === 'string' ? request.system : undefined
  const result = await ctx.llm({ prompt, ...(system ? { system } : {}) })
  return { text: result.text }
}

/**
 * Runs one declared hostcall. Throws `CapabilityError` for anything the
 * manifest did not ask for, so a compromised skill can only do what it
 * declared.
 */
export async function invokeHostcall (
  name: string,
  args: unknown,
  ctx: HostcallContext
): Promise<unknown> {
  if ((Object.values(HOSTCALL_NAMES) as string[]).includes(name)) {
    requireDeclared(name as HostcallName, ctx)
  } else {
    throw new CapabilityError(HOSTCALL_ERRORS.UNKNOWN, `unknown hostcall "${name}"`)
  }
  switch (name as HostcallName) {
    case HOSTCALL_NAMES.FETCH_URL:
      return fetchUrl(args, ctx)
    case HOSTCALL_NAMES.LLM_COMPLETE:
      return llmComplete(args, ctx)
  }
}
