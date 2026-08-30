// Provider-swappable LLM abstraction. Every caller in scripts/lib/ and the
// CLI scripts goes through callLLM() — no provider-specific code (Anthropic
// SDK, OpenAI-shaped fetch calls) belongs anywhere else; that lives in
// lib/connectors.js, which this module hosts.
//
// Which backend runs, and its credentials/model, come from
// coop/.henhouse/llm.json if present (loadLLMConfig/saveLLMConfig below —
// read/written by a GUI app without touching shell env vars), falling back
// per-field to the PROVIDER / *_API_KEY / *_MODEL env vars. See .env.example.
const fs = require('node:fs')
const path = require('node:path')
const { DEFAULT_VAULT_ROOT, configPath } = require('./paths')
const telemetry = require('./telemetry')
const { loadConnectors, resolveConfig, missingRequiredField } = require('./connectors')

/**
 * Reads coop/.henhouse/llm.json. Returns null if it doesn't exist (callers
 * fall back to env vars entirely in that case). Throws if it exists but
 * isn't valid JSON — a corrupt config file is a real problem, not a
 * silently-ignorable one.
 */
function loadLLMConfig (vaultRoot = DEFAULT_VAULT_ROOT) {
  const file = configPath(vaultRoot)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`coop/.henhouse/llm.json is not valid JSON: ${err.message}`)
  }
}

/** Writes coop/.henhouse/llm.json (creating coop/.henhouse/ if needed). Same shape loadLLMConfig() reads. */
function saveLLMConfig (config, vaultRoot = DEFAULT_VAULT_ROOT) {
  const file = configPath(vaultRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
}

function getProviderName () {
  return (process.env.PROVIDER || 'anthropic').toLowerCase()
}

function requireSpec (registry, providerId) {
  const spec = registry.get(providerId)
  if (!spec) {
    throw new Error(`Unknown PROVIDER "${providerId}". Supported: ${registry.ids().join(', ')}.`)
  }
  return spec
}

/**
 * Reads coop/.henhouse/llm.json once and works out the active provider: its
 * id (file's `provider`, else $PROVIDER, else "anthropic"), its spec from
 * the connector registry, and its config resolved file-over-env-over-default.
 */
function resolveActive (vaultRoot, registryOpts = {}) {
  const fileConfig = loadLLMConfig(vaultRoot)
  const provider = (fileConfig && fileConfig.provider) || getProviderName()
  const registry = loadConnectors(vaultRoot, registryOpts)
  const spec = requireSpec(registry, provider)
  const block = (fileConfig && fileConfig.providers && fileConfig.providers[provider]) || {}
  return { provider, spec, resolved: resolveConfig(spec, block), registry }
}

/**
 * Resolves the active provider's config, merging coop/.henhouse/llm.json
 * (if present) over the connector's env-var / default fallbacks, field by
 * field. Kept for the CLI scripts' startup line (describeProvider); the
 * settings UI goes through the electron IPC layer instead.
 */
function getProviderConfig (vaultRoot = DEFAULT_VAULT_ROOT) {
  const { provider, spec, resolved } = resolveActive(vaultRoot)
  return {
    provider,
    label: spec.label,
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    model: resolved.model || spec.staticModel
  }
}

/** e.g. "Using provider: deepseek (deepseek-chat)" — for CLI scripts to print at startup. */
function describeProvider (vaultRoot = DEFAULT_VAULT_ROOT) {
  const { provider, model } = getProviderConfig(vaultRoot)
  return `Using provider: ${provider}${model ? ` (${model})` : ' (no model configured)'}`
}

/** Token counts from a raw provider response — Anthropic or OpenAI-compatible shapes; 0 when absent. */
function extractUsage (raw) {
  const u = raw && raw.usage
  if (!u) return { input: 0, output: 0 }
  return {
    input: u.input_tokens || u.prompt_tokens || 0,
    output: u.output_tokens || u.completion_tokens || 0
  }
}

/** The model's own reasoning/thinking text, when the provider exposes it (DeepSeek reasoner, Anthropic extended thinking). "" otherwise. */
function extractReasoning (raw) {
  if (!raw) return ''
  const msg = raw.choices && raw.choices[0] && raw.choices[0].message
  if (msg && typeof msg.reasoning_content === 'string') return msg.reasoning_content
  if (Array.isArray(raw.content)) {
    const thinking = raw.content
      .filter((b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking'))
      .map((b) => b.thinking || '')
      .join('\n')
      .trim()
    if (thinking) return thinking
  }
  return ''
}

/** Throws the same "<ENV_VAR> is required when PROVIDER=..." error the old code did. */
function assertConfigured (spec, resolved) {
  const missing = missingRequiredField(spec, resolved)
  if (!missing) return
  const envVar = (spec.envDefaults && spec.envDefaults[missing.key]) || missing.label
  const hint = missing.help ? ` (${missing.help})` : ''
  throw new Error(
    `${envVar} is required when PROVIDER=${spec.id}${hint} ` +
    '(set it in coop/.henhouse/llm.json or the environment).'
  )
}

/**
 * The one entry point every caller uses. Routes to the connector named by
 * coop/.henhouse/llm.json / the PROVIDER env var (default "anthropic");
 * always resolves to the same shape: { text, raw, callId }. `callId` is the
 * managed backend's per-call id — set only by the kip connector, null for
 * every other provider — and is what preference signals reference (kip-app#73).
 *
 * `overrides` (optional, second arg) is for tests only — real callers never
 * pass it: { AnthropicClient } to replace the Anthropic SDK class,
 * { fetchImpl } to replace the fetch used for OpenAI-compatible providers,
 * or { vaultRoot } to point config resolution at a temp coop.
 *
 * `label` (optional) tags the call in scripts/lib/telemetry.js — e.g.
 * "hatch:propose", "hatch:generate:entity", "peck:answer".
 */
async function callLLM ({ system, prompt, json = false, maxTokens = 4096, label }, overrides = {}) {
  const vaultRoot = overrides.vaultRoot || DEFAULT_VAULT_ROOT
  const { spec, resolved } = resolveActive(vaultRoot, {
    anthropicClient: overrides.AnthropicClient,
    fetchImpl: overrides.fetchImpl
  })
  assertConfigured(spec, resolved)

  const call = { system, prompt, json, maxTokens, label: label || null }
  const ctx = {
    fetch: overrides.fetchImpl || fetch,
    signal: overrides.signal,
    logger: overrides.logger || console
  }

  const started = Date.now()
  const common = {
    label: label || null,
    provider: spec.id,
    model: resolved.model || spec.staticModel || null
  }
  try {
    const result = await spec.complete(resolved, call, ctx)
    const callId = (result && result.callId) || null

    const usage = extractUsage(result.raw)
    const reasoning = extractReasoning(result.raw)
    // the connector may resolve the real model itself (the Kip backend routes
    // "auto" to an upstream and returns which one) — prefer that for telemetry.
    const realModel = (result.raw && typeof result.raw.model === 'string' && result.raw.model) || common.model
    telemetry.record({
      ...common,
      model: realModel,
      callId,
      ms: Date.now() - started,
      ok: true,
      systemChars: (system || '').length,
      promptChars: (prompt || '').length,
      responseChars: (result.text || '').length,
      inputTokens: usage.input,
      outputTokens: usage.output,
      reasoningChars: reasoning.length,
      system,
      prompt,
      responseText: result.text,
      reasoning
    })
    return { ...result, callId }
  } catch (err) {
    telemetry.record({
      ...common,
      ms: Date.now() - started,
      ok: false,
      error: (err && err.message) || String(err),
      systemChars: (system || '').length,
      promptChars: (prompt || '').length
    })
    throw err
  }
}

/**
 * Fires a trivial LLM call against an explicit provider config — for the
 * settings UI's "test connection" button, which needs to test the form's
 * *current, possibly unsaved* values, not whatever's in
 * coop/.henhouse/llm.json. Bypasses the file/env resolution for the
 * candidate's own fields, but still falls back to the env-var / default for
 * any the candidate leaves blank (so testing with an empty API-key field
 * still picks up an env var if one is set, matching a real call).
 *
 * Never throws — returns { success: true, reply } or { success: false, error }.
 *
 * `overrides` (optional, second arg) is for tests only, same as callLLM's.
 */
async function testConnection ({ provider, apiKey, model, baseUrl } = {}, overrides = {}) {
  const registry = loadConnectors(overrides.vaultRoot, {
    anthropicClient: overrides.AnthropicClient,
    fetchImpl: overrides.fetchImpl
  })
  const spec = registry.get(provider)
  if (!spec) return { success: false, error: `Unknown provider "${provider}".` }

  // Only the fields the connector actually declares; undefined candidate
  // values fall through resolveConfig to the env var / default.
  const candidate = {}
  for (const [k, v] of Object.entries({ apiKey, model, baseUrl })) {
    if (v !== undefined) candidate[k] = v
  }
  const resolved = resolveConfig(spec, candidate)

  const missing = missingRequiredField(spec, resolved)
  if (missing) return { success: false, error: `${missing.label} is required.` }

  const ctx = {
    fetch: overrides.fetchImpl || fetch,
    signal: overrides.signal,
    logger: overrides.logger || console
  }

  try {
    if (typeof spec.testConnection === 'function') {
      return await spec.testConnection(resolved, ctx)
    }
    const result = await spec.complete(
      resolved,
      { system: '', prompt: 'Reply with exactly: OK', json: false, maxTokens: 10, label: 'test:connection' },
      ctx
    )
    return { success: true, reply: result.text }
  } catch (err) {
    return { success: false, error: err.message || String(err) }
  }
}

module.exports = { callLLM, describeProvider, getProviderConfig, loadLLMConfig, saveLLMConfig, testConnection }
