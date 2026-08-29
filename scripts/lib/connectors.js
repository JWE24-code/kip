// Connector host for the LLM layer.
//
// A "connector" is a ProviderSpec (v1): the object that knows one
// provider's configuration fields and how to turn a call into a completion.
// llm.js is the *host* — it resolves config (file over env over defaults),
// builds the call context, dispatches to spec.complete(), and records
// telemetry. No provider-specific code (the Anthropic SDK, OpenAI-shaped
// fetch calls) lives outside this file.
//
// The five built-ins (anthropic / openai / deepseek / local / other) are
// ProviderSpecs defined below. External connectors — starting with the
// managed Kip backend (@kip-ai/connector) — register through
// loadConnectors() too; graph-local discovery and the install/allowlist
// flow land in a follow-up (see kip-app#56). For now loadConnectors()
// returns the built-ins only, and `vaultRoot` is accepted but unused.

const CONNECTOR_API = 1

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6'
const JSON_MODE_INSTRUCTION =
  'Respond with ONLY valid JSON and no other text — no markdown code fences, no explanation.'

// ---------------------------------------------------------------------------
// Low-level provider calls — each built-in spec's complete() is a thin
// wrapper over one of these. Moved verbatim from llm.js.
// ---------------------------------------------------------------------------

function stripCodeFences (text) {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/)
  return fenced ? fenced[1].trim() : trimmed
}

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

async function postChatCompletion (baseUrl, apiKey, body, doFetch) {
  const headers = { 'Content-Type': 'application/json' }
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
 * (openai, deepseek, local/Ollama, "other", and future connectors) — only
 * baseUrl/apiKey/model differ between them.
 *
 * For json:true, tries native response_format: {type: "json_object"} first;
 * if the provider/model errors on that parameter, retries once without it,
 * using the same prompt-and-strip approach as the Anthropic path.
 */
async function callOpenAICompatible ({ baseUrl, apiKey, model, system, prompt, json, maxTokens }, fetchImpl) {
  const doFetch = fetchImpl || fetch

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
      }, doFetch)
    } catch {
      const jsonSystem = system ? `${system}\n\n${JSON_MODE_INSTRUCTION}` : JSON_MODE_INSTRUCTION
      data = await postChatCompletion(baseUrl, apiKey, {
        model,
        max_tokens: maxTokens,
        messages: buildMessages(jsonSystem)
      }, doFetch)
    }
  } else {
    data = await postChatCompletion(baseUrl, apiKey, {
      model,
      max_tokens: maxTokens,
      messages: buildMessages(system)
    }, doFetch)
  }

  const rawText = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ''
  return { text: json ? stripCodeFences(rawText) : rawText.trim(), raw: data }
}

// ---------------------------------------------------------------------------
// Built-in ProviderSpecs
//
// `fields` drives config resolution and the (data-driven, kip-app#58)
// settings form: { key, label, type, required, default, placeholder, help }.
// `envDefaults` maps a field key to the env var it falls back to.
// `staticModel` is a model the connector always uses and the user can't
// change (Anthropic) — surfaced only for `describeProvider` / telemetry.
// openai/deepseek/local/"other" all speak the OpenAI-compatible format and
// share callOpenAICompatible; Anthropic's own shape is callAnthropic.
// ---------------------------------------------------------------------------

function builtinSpecs ({ anthropicClient, fetchImpl } = {}) {
  const openAICompatibleComplete = (resolved, call, ctx) =>
    callOpenAICompatible({
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      model: resolved.model,
      system: call.system,
      prompt: call.prompt,
      json: call.json,
      maxTokens: call.maxTokens
    }, fetchImpl || (ctx && ctx.fetch))

  return [
    {
      kipConnectorApi: CONNECTOR_API,
      id: 'anthropic',
      label: 'Anthropic (Claude)',
      staticModel: DEFAULT_ANTHROPIC_MODEL,
      fields: [
        { key: 'apiKey', label: 'API key', type: 'password', required: false, placeholder: 'sk-ant-…', help: 'Optional — without one, the Anthropic SDK falls back to its own credential chain (ant CLI profile, etc.).' }
      ],
      envDefaults: { apiKey: 'ANTHROPIC_API_KEY' },
      isReady: () => true,
      async complete (resolved, call) {
        return callAnthropic(
          { system: call.system, prompt: call.prompt, json: call.json, maxTokens: call.maxTokens, apiKey: resolved.apiKey },
          anthropicClient
        )
      }
    },
    {
      kipConnectorApi: CONNECTOR_API,
      id: 'openai',
      label: 'OpenAI',
      fields: [
        { key: 'apiKey', label: 'API key', type: 'password', required: true, placeholder: 'sk-…' },
        { key: 'model', label: 'Model', type: 'text', required: true, placeholder: 'e.g. gpt-4o-mini', help: 'e.g. gpt-4o-mini' },
        { key: 'baseUrl', label: 'Base URL', type: 'text', required: false, default: 'https://api.openai.com/v1' }
      ],
      envDefaults: { apiKey: 'OPENAI_API_KEY', model: 'OPENAI_MODEL', baseUrl: 'OPENAI_BASE_URL' },
      isReady: (cfg) => !!cfg.apiKey && !!cfg.model,
      complete: openAICompatibleComplete
    },
    {
      kipConnectorApi: CONNECTOR_API,
      id: 'deepseek',
      label: 'DeepSeek',
      fields: [
        { key: 'apiKey', label: 'API key', type: 'password', required: true, placeholder: 'sk-…' },
        { key: 'model', label: 'Model', type: 'text', required: false, default: 'deepseek-chat' },
        { key: 'baseUrl', label: 'Base URL', type: 'text', required: false, default: 'https://api.deepseek.com' }
      ],
      envDefaults: { apiKey: 'DEEPSEEK_API_KEY', model: 'DEEPSEEK_MODEL' },
      isReady: (cfg) => !!cfg.apiKey,
      complete: openAICompatibleComplete
    },
    {
      kipConnectorApi: CONNECTOR_API,
      id: 'local',
      label: 'Local (Ollama)',
      fields: [
        { key: 'model', label: 'Model', type: 'text', required: true, placeholder: 'e.g. llama3.1', help: 'e.g. llama3.1 — the Ollama model tag you have pulled' },
        { key: 'baseUrl', label: 'Base URL', type: 'text', required: false, default: 'http://localhost:11434/v1' }
      ],
      envDefaults: { model: 'LOCAL_MODEL', baseUrl: 'LOCAL_BASE_URL' },
      isReady: (cfg) => !!cfg.model && !!cfg.baseUrl,
      complete: openAICompatibleComplete
    },
    {
      // Any other OpenAI-compatible endpoint (Kimi/Moonshot, Qwen via
      // DashScope, a custom proxy, ...) — unlike "local" it has no
      // Ollama-flavored default base URL and usually needs an API key.
      kipConnectorApi: CONNECTOR_API,
      id: 'other',
      label: 'Other (OpenAI-compatible)',
      fields: [
        { key: 'baseUrl', label: 'Base URL', type: 'text', required: true, placeholder: 'https://…/v1' },
        { key: 'model', label: 'Model', type: 'text', required: true, placeholder: 'the model name for your endpoint', help: 'the model name for your OpenAI-compatible endpoint' },
        { key: 'apiKey', label: 'API key', type: 'password', required: false, placeholder: 'sk-…' }
      ],
      envDefaults: { baseUrl: 'OTHER_BASE_URL', model: 'OTHER_MODEL', apiKey: 'OTHER_API_KEY' },
      isReady: (cfg) => !!cfg.baseUrl && !!cfg.model,
      complete: openAICompatibleComplete
    }
  ]
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Structural check of a ProviderSpec. Returns a reason string when the spec
 * is unusable (so the registry can skip it with a warning instead of
 * throwing into callLLM), or null when it's fine.
 */
function validateSpec (spec) {
  if (!spec || typeof spec !== 'object') return 'not an object'
  if (spec.kipConnectorApi !== CONNECTOR_API) {
    return `unsupported kipConnectorApi ${JSON.stringify(spec.kipConnectorApi)} (host speaks ${CONNECTOR_API})`
  }
  if (!spec.id || typeof spec.id !== 'string') return 'missing id'
  if (!spec.label || typeof spec.label !== 'string') return 'missing label'
  if (typeof spec.complete !== 'function') return 'missing complete()'
  if (!Array.isArray(spec.fields)) return 'missing fields[]'
  return null
}

/**
 * Builds a registry from a list of specs. A spec that fails validation, or
 * whose id collides with one already registered, is skipped with a logged
 * warning — a broken connector must never break `callLLM()` for the others.
 */
function createRegistry (specs, { logger = console } = {}) {
  const byId = new Map()
  for (const spec of specs || []) {
    const problem = validateSpec(spec)
    if (problem) {
      logger.warn(`[connectors] skipping a connector: ${problem}`)
      continue
    }
    if (byId.has(spec.id)) {
      logger.warn(`[connectors] skipping connector "${spec.id}": id already registered`)
      continue
    }
    byId.set(spec.id, spec)
  }
  return {
    get: (id) => byId.get(id) || null,
    has: (id) => byId.has(id),
    list: () => [...byId.values()],
    ids: () => [...byId.keys()]
  }
}

/**
 * The registry of every connector available to this graph: the five
 * built-ins today. `opts.anthropicClient` / `opts.fetchImpl` are test seams
 * for the built-ins — real callers never pass them. `vaultRoot` is reserved
 * for graph-local connector discovery (kip-app#56).
 */
function loadConnectors (vaultRoot, opts = {}) {
  return createRegistry(builtinSpecs(opts), { logger: opts.logger })
}

/**
 * Resolves a spec's config values: for each field, the config file wins,
 * then the field's env var, then the field's declared default. `env` is
 * injectable for tests.
 */
function resolveConfig (spec, fileProviderConfig = {}, env = process.env) {
  const keys = new Set([
    ...(spec.fields || []).map((f) => f.key),
    ...Object.keys(spec.envDefaults || {})
  ])
  const resolved = {}
  for (const key of keys) {
    const field = (spec.fields || []).find((f) => f.key === key)
    const envVar = spec.envDefaults && spec.envDefaults[key]
    resolved[key] =
      (fileProviderConfig && fileProviderConfig[key]) ||
      (envVar ? env[envVar] : undefined) ||
      (field ? field.default : undefined) ||
      undefined
  }
  return resolved
}

/** The first required field left blank after resolution, or null. */
function missingRequiredField (spec, resolved) {
  return (spec.fields || []).find((f) => f.required && !resolved[f.key]) || null
}

module.exports = {
  CONNECTOR_API,
  loadConnectors,
  createRegistry,
  validateSpec,
  resolveConfig,
  missingRequiredField
}
