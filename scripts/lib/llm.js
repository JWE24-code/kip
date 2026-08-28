// Provider-swappable LLM abstraction. Every caller in scripts/lib/ and the
// CLI scripts goes through callLLM() — no provider-specific code (Anthropic
// SDK, OpenAI-shaped fetch calls) belongs anywhere else. Which backend runs,
// and its credentials/model, come from coop/.henhouse/llm.json if present
// (loadLLMConfig/saveLLMConfig below — read/written by a GUI app without
// touching shell env vars), falling back per-field to the PROVIDER/
// *_API_KEY/*_MODEL env vars. See .env.example.
const fs = require('node:fs')
const path = require('node:path')
const { DEFAULT_VAULT_ROOT, configPath } = require('./paths')
const telemetry = require('./telemetry')

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6'

// Env-var defaults for each supported PROVIDER value — the fallback when
// coop/.henhouse/llm.json doesn't exist or doesn't set a given field.
// openai/deepseek/local all speak the same OpenAI-compatible chat
// completions format and share callOpenAICompatible — only their base URL,
// API key, and model differ. Anthropic's own request/response shape is
// handled separately, in callAnthropic.
const PROVIDER_CONFIGS = {
  anthropic: () => ({
    apiKey: process.env.ANTHROPIC_API_KEY, // undefined is fine — the SDK
    model: DEFAULT_ANTHROPIC_MODEL         // falls back to its own credential
  }),                                      // chain (ant CLI profile, etc.)
  openai: () => ({
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY,
    apiKeyEnvVar: 'OPENAI_API_KEY',
    model: process.env.OPENAI_MODEL,
    modelEnvVar: 'OPENAI_MODEL',
    modelHint: 'e.g. gpt-4o-mini'
  }),
  deepseek: () => ({
    baseUrl: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY,
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat'
  }),
  local: () => ({
    baseUrl: process.env.LOCAL_BASE_URL || 'http://localhost:11434/v1',
    apiKey: undefined, // no API key required
    model: process.env.LOCAL_MODEL,
    modelEnvVar: 'LOCAL_MODEL',
    modelHint: 'e.g. llama3.1 — the Ollama model tag you have pulled'
  }),
  // Kip's managed model-routing backend. OpenAI-compatible on the wire.
  // Model selection is *fully delegated*: the client always sends
  // model: "auto" and the backend picks the real model per call, using the
  // workload label forwarded as X-Kip-Workload / X-Kip-Phase headers (see
  // callOpenAICompatible). There is no client-side model/profile knob — the
  // model recorded in telemetry is whatever the backend reports back (see
  // extractResolvedModel).
  kip: () => ({
    baseUrl: process.env.KIP_BASE_URL || 'https://api.kip-ai.be/v1',
    baseUrlEnvVar: 'KIP_BASE_URL',
    apiKey: process.env.KIP_API_KEY,
    apiKeyEnvVar: 'KIP_API_KEY',
    model: 'auto', // fixed — ignores any configured model, the backend routes
    fixedModel: true
  }),
  // Any other OpenAI-compatible endpoint (Kimi/Moonshot, Qwen via DashScope,
  // a custom proxy, ...) — unlike "local" this has no Ollama-flavored
  // default base URL and does support an API key, since a remote
  // "other" endpoint usually needs one.
  other: () => ({
    baseUrl: process.env.OTHER_BASE_URL,
    baseUrlEnvVar: 'OTHER_BASE_URL',
    apiKey: process.env.OTHER_API_KEY,
    model: process.env.OTHER_MODEL,
    modelEnvVar: 'OTHER_MODEL',
    modelHint: 'the model name for your OpenAI-compatible endpoint'
  })
}

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

/**
 * Resolves the active provider's config, merging coop/.henhouse/llm.json
 * (if present) over the PROVIDER_CONFIGS env-var defaults, field by field —
 * a field missing from the file (or the file itself missing) falls back to
 * its env var.
 */
function getProviderConfig (vaultRoot = DEFAULT_VAULT_ROOT) {
  const fileConfig = loadLLMConfig(vaultRoot)
  const provider = (fileConfig && fileConfig.provider) || getProviderName()

  const configFn = PROVIDER_CONFIGS[provider]
  if (!configFn) {
    throw new Error(`Unknown PROVIDER "${provider}". Supported: ${Object.keys(PROVIDER_CONFIGS).join(', ')}.`)
  }

  const envDefaults = configFn()
  const fileProviderConfig = (fileConfig && fileConfig.providers && fileConfig.providers[provider]) || {}

  return {
    provider,
    baseUrl: fileProviderConfig.baseUrl || envDefaults.baseUrl,
    baseUrlEnvVar: envDefaults.baseUrlEnvVar,
    apiKey: fileProviderConfig.apiKey || envDefaults.apiKey,
    apiKeyEnvVar: envDefaults.apiKeyEnvVar,
    // fixedModel providers (kip) ignore any configured model — the backend routes.
    model: envDefaults.fixedModel ? envDefaults.model : (fileProviderConfig.model || envDefaults.model),
    modelEnvVar: envDefaults.modelEnvVar,
    modelHint: envDefaults.modelHint
  }
}

/** e.g. "Using provider: deepseek (deepseek-chat)" — for CLI scripts to print at startup. */
function describeProvider (vaultRoot = DEFAULT_VAULT_ROOT) {
  const { provider, model } = getProviderConfig(vaultRoot)
  return `Using provider: ${provider}${model ? ` (${model})` : ' (no model configured)'}`
}

function stripCodeFences (text) {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/)
  return fenced ? fenced[1].trim() : trimmed
}

/**
 * The phase bucket for a call label — same rules scripts/lib/telemetry.js
 * uses (kept in sync deliberately; telemetry doesn't export it). Sent as the
 * X-Kip-Phase header so the routing backend can bucket work coarsely.
 * hatch:generate:<type> -> hatch:generate; skill:<name> -> skill; foo:retry -> foo; else the label as-is.
 */
function phaseFromLabel (label) {
  const base = String(label).replace(/:retry$/, '')
  if (base.startsWith('skill:')) return 'skill'
  const m = base.match(/^(hatch:generate):/)
  return m ? m[1] : base
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

/**
 * The actual upstream model a response was produced by. For the `kip`
 * backend this is the real model the router chose (e.g. claude-sonnet-4-6),
 * not the routing profile ("auto") we sent — that's what telemetry should
 * record. OpenAI and Anthropic responses also carry `model`; falling back to
 * it there is harmless (it matches what we requested). null when absent.
 */
function extractResolvedModel (raw) {
  if (!raw) return null
  if (typeof raw.model === 'string' && raw.model.trim()) return raw.model.trim()
  return null
}

const JSON_MODE_INSTRUCTION = 'Respond with ONLY valid JSON and no other text — no markdown code fences, no explanation.'

/** Anthropic has no forced-JSON mode: for json:true, ask for it in the system prompt and strip fences after. */
async function callAnthropic ({ system, prompt, json, maxTokens, apiKey }, AnthropicClient) {
  const Anthropic = AnthropicClient || require('@anthropic-ai/sdk')
  // Only pass an explicit apiKey when we have one (from the config file or
  // ANTHROPIC_API_KEY) — an explicit undefined can short-circuit the SDK's
  // own fallback chain (ant CLI profile, WIF, ...), which must keep working
  // for anyone who hasn't set either.
  const client = apiKey ? new Anthropic({ apiKey }) : new Anthropic()

  const finalSystem = json
    ? (system ? `${system}\n\n${JSON_MODE_INSTRUCTION}` : JSON_MODE_INSTRUCTION)
    : system

  const response = await client.messages.create({
    model: DEFAULT_ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system: finalSystem,
    messages: [{ role: 'user', content: prompt }]
  })

  const rawText = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()

  return { text: json ? stripCodeFences(rawText) : rawText, raw: response }
}

async function postChatCompletion (baseUrl, apiKey, body, doFetch, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const response = await doFetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => response.status)
    const err = new Error(`${baseUrl} request failed (${response.status}): ${errText}`)
    err.status = response.status
    throw err
  }
  return response.json()
}

/**
 * One generic client for every OpenAI-compatible chat completions API
 * (openai, deepseek, local/Ollama, and future providers like kimi/qwen) —
 * only baseUrl/apiKey/model differ between them.
 *
 * For json:true, tries native response_format: {type: "json_object"} first;
 * if the provider/model errors on that parameter, retries once without it,
 * using the same prompt-and-strip approach as the Anthropic path.
 */
async function callOpenAICompatible ({ baseUrl, apiKey, model, system, prompt, json, maxTokens, workloadLabel }, fetchImpl) {
  const doFetch = fetchImpl || fetch

  // Workload routing headers — only when a label is supplied (the `kip`
  // provider path; direct providers get no extra headers, unchanged).
  const extraHeaders = {}
  if (workloadLabel) {
    extraHeaders['X-Kip-Workload'] = workloadLabel
    extraHeaders['X-Kip-Phase'] = phaseFromLabel(workloadLabel)
  }

  const buildMessages = (sys) => {
    const messages = []
    if (sys) messages.push({ role: 'system', content: sys })
    messages.push({ role: 'user', content: prompt })
    return messages
  }

  let data
  if (json) {
    try {
      data = await postChatCompletion(baseUrl, apiKey, {
        model,
        max_tokens: maxTokens,
        messages: buildMessages(system),
        response_format: { type: 'json_object' }
      }, doFetch, extraHeaders)
    } catch {
      const jsonSystem = system ? `${system}\n\n${JSON_MODE_INSTRUCTION}` : JSON_MODE_INSTRUCTION
      data = await postChatCompletion(baseUrl, apiKey, {
        model,
        max_tokens: maxTokens,
        messages: buildMessages(jsonSystem)
      }, doFetch, extraHeaders)
    }
  } else {
    data = await postChatCompletion(baseUrl, apiKey, {
      model,
      max_tokens: maxTokens,
      messages: buildMessages(system)
    }, doFetch, extraHeaders)
  }

  const rawText = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ''
  return { text: json ? stripCodeFences(rawText) : rawText.trim(), raw: data }
}

/**
 * The one entry point every caller uses. Routes to the provider named by
 * coop/.henhouse/llm.json / the PROVIDER env var (default "anthropic");
 * always resolves to the same shape: { text, raw }.
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
  const config = getProviderConfig(vaultRoot)

  if (config.apiKeyEnvVar && !config.apiKey) {
    throw new Error(`${config.apiKeyEnvVar} is required when PROVIDER=${config.provider} ` +
      '(set it in coop/.henhouse/llm.json or the environment).')
  }
  if (config.modelEnvVar && !config.model) {
    throw new Error(`${config.modelEnvVar} is required when PROVIDER=${config.provider}` +
      `${config.modelHint ? ` (${config.modelHint})` : ''} (set it in coop/.henhouse/llm.json or the environment).`)
  }
  if (config.baseUrlEnvVar && !config.baseUrl) {
    throw new Error(`${config.baseUrlEnvVar} is required when PROVIDER=${config.provider} ` +
      '(set it in coop/.henhouse/llm.json or the environment).')
  }

  const started = Date.now()
  const common = { label: label || null, provider: config.provider }
  try {
    const result = config.provider === 'anthropic'
      ? await callAnthropic({ system, prompt, json, maxTokens, apiKey: config.apiKey }, overrides.AnthropicClient)
      : await callOpenAICompatible({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        system,
        prompt,
        json,
        maxTokens,
        // Only the managed `kip` backend needs the workload routing headers;
        // direct providers are called exactly as before.
        workloadLabel: config.provider === 'kip' ? (label || null) : null
      }, overrides.fetchImpl)

    const usage = extractUsage(result.raw)
    const reasoning = extractReasoning(result.raw)
    // For `kip`, config.model is just the routing profile ("auto"); record
    // the model the backend actually used. For everyone else this resolves
    // to the same value as config.model.
    const resolvedModel = extractResolvedModel(result.raw) || config.model || null
    telemetry.record({
      ...common,
      model: resolvedModel,
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
    return result
  } catch (err) {
    telemetry.record({
      ...common,
      model: config.model || null, // no response to resolve a real model from
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
 * coop/.henhouse/llm.json. Bypasses getProviderConfig()'s file/env
 * resolution for provider/apiKey/model/baseUrl, but still falls back to the
 * env-var defaults for any of those the candidate leaves blank (so testing
 * with an empty API key field still picks up an env var if one is set,
 * matching what a real call would actually do).
 *
 * Never throws — returns { success: true, reply } or { success: false, error }.
 *
 * `overrides` (optional, second arg) is for tests only, same as callLLM's.
 */
async function testConnection ({ provider, apiKey, model, baseUrl } = {}, overrides = {}) {
  const configFn = PROVIDER_CONFIGS[provider]
  if (!configFn) return { success: false, error: `Unknown provider "${provider}".` }

  const envDefaults = configFn()
  const resolved = {
    apiKey: apiKey || envDefaults.apiKey,
    // fixedModel providers (kip) ignore any candidate model — the backend routes.
    model: envDefaults.fixedModel ? envDefaults.model : (model || envDefaults.model),
    baseUrl: baseUrl || envDefaults.baseUrl
  }

  try {
    let result
    if (provider === 'anthropic') {
      result = await callAnthropic(
        { system: '', prompt: 'Reply with exactly: OK', maxTokens: 10, apiKey: resolved.apiKey },
        overrides.AnthropicClient
      )
    } else {
      if (!resolved.model) throw new Error('Model is required.')
      if (!resolved.baseUrl) throw new Error('Base URL is required.')
      result = await callOpenAICompatible({
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        model: resolved.model,
        system: '',
        prompt: 'Reply with exactly: OK',
        maxTokens: 10
      }, overrides.fetchImpl)
    }
    return { success: true, reply: result.text }
  } catch (err) {
    return { success: false, error: err.message || String(err) }
  }
}

module.exports = { callLLM, describeProvider, getProviderConfig, loadLLMConfig, saveLLMConfig, testConnection }
