// Connector host for the LLM layer.
//
// A "connector" is a ProviderSpec (v1): the object that knows one
// provider's configuration fields and how to turn a call into a completion.
// llm.js is the *host* — it resolves config (file over env over defaults),
// builds the call context, dispatches to spec.complete(), and records
// telemetry. No provider-specific code (the Anthropic SDK, OpenAI-shaped
// fetch calls) lives outside this file.
//
// The built-ins (anthropic / openai / deepseek / local / other, plus the
// managed "kip" backend connector from ./kip-connector.js) are ProviderSpecs
// defined below. External connectors register through
// loadConnectors() too, from two sources:
//
//   * bundled  — an allowlisted package that ships as a dependency of the
//                app (BUNDLED_CONNECTORS). It rides the normal app auto-
//                update, so everyone who has it stays current for free.
//   * graph-local — a package installed into
//                <graph>/.henhouse/connectors/<dir>/ from a .tgz, listed in
//                <graph>/.henhouse/connectors.json. Mirrors .henhouse/skills/.
//                A graph-local connector overrides a bundled one with the
//                same id (the "ship a fix ahead of an app release" path).
//
// Trust: an installable connector is arbitrary JS `require`d into this
// process with `fetch`. The only gate is ALLOWLIST — a constant here, not
// user-editable. Built-in ids can never be shadowed.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { connectorsPath, connectorsConfigPath } = require('./paths')
const { extractNpmTarball } = require('./untar')

const CONNECTOR_API = 1

// Package-name patterns an installable connector must match. `@scope/*`
// matches anything under that scope; a bare name matches exactly.
const ALLOWLIST = ['@kip-ai/connector', '@kip-ai/*']

// Allowlisted packages the app ships as its own dependency. Absent until
// @kip-ai/connector is published + added to scripts/package.json — until
// then loadBundledConnectors() just finds nothing.
const BUNDLED_CONNECTORS = ['@kip-ai/connector']

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6'
const JSON_MODE_INSTRUCTION =
  'Respond with ONLY valid JSON and no other text — no markdown code fences, no explanation.'

// Reasoning models (DeepSeek `deepseek-reasoner` / `r1`, OpenAI `o1`/`o3`/
// `o4-mini`, Qwen `qwq`, Mistral `magistral`, …) reject `response_format`
// and `temperature`. For a json:true call we'd otherwise send
// `response_format`, eat a 400, and retry prompt-and-strip — two round-trips
// every call. Recognise the common ones by name and go straight to
// prompt-and-strip. `gpt-4o` and friends don't match (the `o` isn't on a
// separator). See kip-app#68.
//
// The name list can't be exhaustive, so it's only a fast path: any model
// that actually 400s on `response_format` is remembered for the rest of the
// process (`learnedNoResponseFormat`) and skips the doomed attempt on every
// later call — so a miss here costs one wasted round-trip once, never more.
const REASONING_MODEL_RE = /(?:^|[-/:_])(?:o[1-9](?:-mini|-preview|-pro)?|r1|qwq|magistral|[a-z]*reasoner|[a-z]*reasoning|[a-z]*thinking)(?:$|[-/:_])/i
function isReasoningModel (model) {
  return typeof model === 'string' && REASONING_MODEL_RE.test(model)
}

// `${baseUrl}::${model}` seen to reject response_format with a 400 in this
// process. Module-level so it's shared across every call in a run (Hatch and
// deep-Groom make many). Cleared only by process exit.
const learnedNoResponseFormat = new Set()
const jsonModeKey = (baseUrl, model) => `${baseUrl || ''}::${model || ''}`

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
 * if the provider/model 400s on that parameter, retries once without it
 * (prompt-and-strip, same as the Anthropic path) AND remembers the model so
 * later calls skip straight there. A model recognised as a reasoning model
 * by name (deepseek-reasoner, o1/o3, …) skips the native attempt from the
 * first call. Either way json:true costs one round-trip, not two, on every
 * call after (at most) one.
 */
async function callOpenAICompatible ({ baseUrl, apiKey, model, system, prompt, json, maxTokens }, fetchImpl) {
  const doFetch = fetchImpl || fetch

  const buildMessages = (sys) => {
    const messages = []
    if (sys) messages.push({ role: 'system', content: sys })
    messages.push({ role: 'user', content: prompt })
    return messages
  }

  const promptStrip = () => {
    const jsonSystem = system ? `${system}\n\n${JSON_MODE_INSTRUCTION}` : JSON_MODE_INSTRUCTION
    return postChatCompletion(baseUrl, apiKey, {
      model,
      max_tokens: maxTokens,
      messages: buildMessages(jsonSystem)
    }, doFetch)
  }

  const skipNativeJson =
    isReasoningModel(model) || learnedNoResponseFormat.has(jsonModeKey(baseUrl, model))

  let data
  if (!json) {
    data = await postChatCompletion(baseUrl, apiKey, {
      model,
      max_tokens: maxTokens,
      messages: buildMessages(system)
    }, doFetch)
  } else if (skipNativeJson) {
    data = await promptStrip()
  } else {
    try {
      data = await postChatCompletion(baseUrl, apiKey, {
        model,
        max_tokens: maxTokens,
        messages: buildMessages(system),
        response_format: { type: 'json_object' }
      }, doFetch)
    } catch (err) {
      // Only a 400 means "this model won't take response_format" — a 401 /
      // 429 / 5xx / network blip shouldn't teach us anything (but still gets
      // one prompt-and-strip retry, as before).
      if (err && err.status === 400) learnedNoResponseFormat.add(jsonModeKey(baseUrl, model))
      data = await promptStrip()
    }
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
    },
    // The managed Kip backend — a first-party connector that ships with the
    // app (AGPL-3.0, ./kip-connector.js). The settings UI keeps it out of
    // the provider dropdown until the user opts in (kip-app#58).
    require('./kip-connector')
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

// ---------------------------------------------------------------------------
// External connector discovery + install
// ---------------------------------------------------------------------------

/** `@kip-ai/connector` -> true; `@kip-ai/anything` -> true; anything else -> false. */
function isAllowlisted (name) {
  if (typeof name !== 'string' || !name) return false
  return ALLOWLIST.some((pat) =>
    pat.endsWith('/*') ? name.startsWith(pat.slice(0, -1)) : name === pat
  )
}

/** A module may export the spec directly or as `default` (esm interop). */
function normalizeExport (mod) {
  return mod && typeof mod === 'object' && mod.default ? mod.default : mod
}

/** Drop a dir (and everything under it) from the require cache. */
function evictFromRequireCache (dir) {
  const resolved = path.resolve(dir)
  for (const key of Object.keys(require.cache)) {
    if (key === resolved || key.startsWith(resolved + path.sep)) delete require.cache[key]
  }
}

/** require() a connector's entry point (package.json main / index.js). */
function requireDir (dir) {
  try {
    return require(require.resolve(dir))
  } catch (err) {
    err.message = `cannot load connector (${err.message})`
    throw err
  }
}

/** `@kip-ai/connector` -> `kip-ai__connector` — a filesystem-safe dir name. */
function connectorDirName (pkgName) {
  return pkgName.replace(/^@/, '').replace(/\//g, '__').replace(/[^\w.-]/g, '_')
}

/** Specs from BUNDLED_CONNECTORS that are actually installed as app deps. */
function loadBundledConnectors ({ logger = console } = {}) {
  const specs = []
  for (const name of BUNDLED_CONNECTORS) {
    try {
      require.resolve(name)
    } catch {
      continue // not shipped in this build — expected
    }
    try {
      specs.push(normalizeExport(require(name)))
    } catch (err) {
      logger.warn(`[connectors] bundled "${name}" failed to load: ${err.message}`)
    }
  }
  return specs
}

/** The raw connectors.json array ([{ id, name, version, dir }]), or []. */
function readConnectorsConfig (vaultRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(connectorsConfigPath(vaultRoot), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeConnectorsConfig (vaultRoot, entries) {
  const file = connectorsConfigPath(vaultRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(entries, null, 2) + '\n')
}

/** Specs for the graph-local connectors listed in connectors.json. */
function loadGraphConnectors (vaultRoot, { logger = console } = {}) {
  if (!vaultRoot) return []
  const base = connectorsPath(vaultRoot)
  const specs = []
  for (const entry of readConnectorsConfig(vaultRoot)) {
    if (!entry || !entry.dir) continue
    const dir = path.join(base, entry.dir)
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      logger.warn(`[connectors] "${entry.id || entry.dir}" is in connectors.json but ${entry.dir}/ is missing`)
      continue
    }
    try {
      specs.push(normalizeExport(requireDir(dir)))
    } catch (err) {
      logger.warn(`[connectors] "${entry.id || entry.dir}" failed to load: ${err.message}`)
    }
  }
  return specs
}

/**
 * Installs a connector from an npm tarball (a local .tgz path or an
 * https URL) into <graph>/.henhouse/connectors/. Pure-JS extraction, no
 * `npm`. Resolves { ok: true, id, name, version } or rejects with a
 * user-facing Error.
 *
 * Refuses: a package whose name isn't on ALLOWLIST; a tarball that isn't a
 * valid ProviderSpec; an id that collides with a built-in or an
 * already-installed connector. (An id that matches a *bundled* connector is
 * allowed — that's how a graph-local build overrides it.)
 */
async function installConnectorFromTarball (tgzPathOrUrl, vaultRoot, opts = {}) {
  const doFetch = opts.fetch || fetch
  if (!vaultRoot) throw new Error('Open a folder first — a connector installs into the current graph.')

  let bytes
  if (/^https?:\/\//i.test(tgzPathOrUrl)) {
    const res = await doFetch(tgzPathOrUrl)
    if (!res.ok) throw new Error(`Couldn't download the connector (${res.status}).`)
    bytes = Buffer.from(await res.arrayBuffer())
  } else {
    try {
      bytes = fs.readFileSync(tgzPathOrUrl)
    } catch {
      throw new Error(`Can't read ${tgzPathOrUrl}.`)
    }
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-connector-'))
  try {
    try {
      extractNpmTarball(bytes, tmp)
    } catch (err) {
      throw new Error(`That doesn't look like a connector package: ${err.message}.`)
    }

    let pkg
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'))
    } catch {
      throw new Error('The tarball has no readable package.json.')
    }
    if (!isAllowlisted(pkg.name)) {
      throw new Error(`"${pkg.name || 'this package'}" is not an allowed connector — Kip only installs @kip-ai/* connectors.`)
    }

    const spec = normalizeExport(requireDir(tmp))
    const problem = validateSpec(spec)
    if (problem) throw new Error(`"${pkg.name}" isn't a valid connector: ${problem}.`)

    if (builtinSpecs().some((s) => s.id === spec.id)) {
      throw new Error(`"${spec.id}" is a built-in provider — this connector can't use that id.`)
    }
    const installed = readConnectorsConfig(vaultRoot)
    if (installed.some((e) => e.id === spec.id)) {
      throw new Error(`A "${spec.id}" connector is already installed — remove it first.`)
    }

    const dir = connectorDirName(pkg.name)
    const dest = path.join(connectorsPath(vaultRoot), dir)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.rmSync(dest, { recursive: true, force: true })
    evictFromRequireCache(dest) // a prior version of this dir may be cached
    fs.cpSync(tmp, dest, { recursive: true })

    const version = typeof pkg.version === 'string' ? pkg.version : null
    writeConnectorsConfig(vaultRoot, [...installed, { id: spec.id, name: pkg.name, version, dir }])
    return { ok: true, id: spec.id, name: pkg.name, version }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/** Removes a graph-local connector: its dir + its connectors.json entry. */
function removeConnector (id, vaultRoot) {
  if (!vaultRoot) throw new Error('No graph open.')
  const installed = readConnectorsConfig(vaultRoot)
  const entry = installed.find((e) => e.id === id)
  if (!entry) return { ok: false, error: `No installed connector "${id}".` }
  const dir = path.join(connectorsPath(vaultRoot), entry.dir)
  fs.rmSync(dir, { recursive: true, force: true })
  evictFromRequireCache(dir)
  writeConnectorsConfig(vaultRoot, installed.filter((e) => e.id !== id))
  return { ok: true, id }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * The registry of every connector available to this graph: the five
 * built-ins, plus any bundled and graph-local connectors. Precedence for a
 * shared id: built-in (locked) > graph-local > bundled.
 *
 * `opts.anthropicClient` / `opts.fetchImpl` are test seams for the
 * built-ins — real callers never pass them.
 */
function loadConnectors (vaultRoot, opts = {}) {
  const logger = opts.logger || console
  const builtins = builtinSpecs(opts)
  const locked = new Set(builtins.map((s) => s.id))

  // bundled first, graph-local second: a later valid spec with the same id
  // wins, so graph-local overrides bundled.
  const externalById = new Map()
  for (const spec of [
    ...loadBundledConnectors({ logger }),
    ...loadGraphConnectors(vaultRoot, { logger })
  ]) {
    const problem = validateSpec(spec)
    if (problem) {
      logger.warn(`[connectors] ignoring a connector: ${problem}`)
      continue
    }
    if (locked.has(spec.id)) {
      logger.warn(`[connectors] ignoring connector "${spec.id}": a built-in owns that id`)
      continue
    }
    externalById.set(spec.id, spec)
  }

  return createRegistry([...builtins, ...externalById.values()], { logger })
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
  ALLOWLIST,
  loadConnectors,
  createRegistry,
  validateSpec,
  resolveConfig,
  missingRequiredField,
  isReasoningModel,
  _clearLearnedJsonMode: () => learnedNoResponseFormat.clear(),
  isAllowlisted,
  readConnectorsConfig,
  installConnectorFromTarball,
  removeConnector
}
