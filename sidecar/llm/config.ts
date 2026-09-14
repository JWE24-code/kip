// BYOK provider configuration (P7, kip#79) — the native TypeScript port of
// scripts/lib/llm.js's provider resolution.
//
// Which provider runs, and its credentials/model, come from
// `<coop>/.henhouse/llm.json` (the file the app's settings panel writes),
// falling back per field to the PROVIDER / *_API_KEY / *_MODEL env vars — the
// exact precedence the JS host used, so an existing coop keeps working.
//
// BYOK is the default and always-available path. The managed "kip" backend is
// an ordinary entry in this registry: visible, opt-in, and never the default
// (kip#79). No entry here carries any cost/usage/billing concept — a provider
// spec only knows how to configure and reach a completion endpoint.

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const require = createRequire(import.meta.url)
const paths = require('../../scripts/lib/paths.js') as {
  DEFAULT_VAULT_ROOT: string
  configPath: (vaultRoot?: string) => string
}

/** Every provider this client can route to. `kip` is the managed backend. */
export type ProviderId = 'anthropic' | 'openai' | 'deepseek' | 'local' | 'other' | 'kip'

/** One settings-form field, mirroring the shape the JS connectors exposed. */
export interface ProviderField {
  key: string
  label: string
  type: 'text' | 'password'
  required: boolean
  default?: string
  placeholder?: string
  help?: string
}

/**
 * A provider's configuration schema. `fields` drives resolution and the
 * settings UI; `envDefaults` maps a field to the env var it falls back to;
 * `staticModel` is a model the provider fixes and the user can't change.
 * `managed: true` marks the first-party backend — listed, not gated.
 */
export interface ProviderInfo {
  id: ProviderId
  label: string
  managed: boolean
  fields: ProviderField[]
  envDefaults: Record<string, string>
  staticModel?: string
}

/** The on-disk `.henhouse/llm.json` shape (all fields optional). */
export interface LLMFileConfig {
  provider?: string
  providers?: Record<string, Record<string, string | undefined>>
}

/** A provider's resolved config values (file over env over default). */
export type ProviderConfig = Record<string, string | undefined>

/** The active provider after config resolution. */
export interface ActiveProvider {
  id: ProviderId
  info: ProviderInfo
  config: ProviderConfig
  model: string | null
}

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6'
const KIP_DEFAULT_BASE_URL = 'https://api.kip-ai.be'

/**
 * The built-in providers. Anthropic speaks its own Messages API; openai /
 * deepseek / local / other share the OpenAI-compatible chat-completions
 * shape; kip is the managed backend. Every one of these is BYOK.
 */
export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    managed: false,
    staticModel: DEFAULT_ANTHROPIC_MODEL,
    fields: [
      {
        key: 'apiKey',
        label: 'API key',
        type: 'password',
        required: false,
        placeholder: 'sk-ant-…',
        help: 'Optional — without one, the Anthropic SDK falls back to its own credential chain (ant CLI profile, etc.).'
      }
    ],
    envDefaults: { apiKey: 'ANTHROPIC_API_KEY' }
  },
  {
    id: 'openai',
    label: 'OpenAI',
    managed: false,
    fields: [
      { key: 'apiKey', label: 'API key', type: 'password', required: true, placeholder: 'sk-…' },
      { key: 'model', label: 'Model', type: 'text', required: true, placeholder: 'e.g. gpt-4o-mini', help: 'e.g. gpt-4o-mini' },
      { key: 'baseUrl', label: 'Base URL', type: 'text', required: false, default: 'https://api.openai.com/v1' }
    ],
    envDefaults: { apiKey: 'OPENAI_API_KEY', model: 'OPENAI_MODEL', baseUrl: 'OPENAI_BASE_URL' }
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    managed: false,
    fields: [
      { key: 'apiKey', label: 'API key', type: 'password', required: true, placeholder: 'sk-…' },
      { key: 'model', label: 'Model', type: 'text', required: false, default: 'deepseek-chat' },
      { key: 'baseUrl', label: 'Base URL', type: 'text', required: false, default: 'https://api.deepseek.com' }
    ],
    envDefaults: { apiKey: 'DEEPSEEK_API_KEY', model: 'DEEPSEEK_MODEL' }
  },
  {
    id: 'local',
    label: 'Local (Ollama)',
    managed: false,
    fields: [
      { key: 'model', label: 'Model', type: 'text', required: true, placeholder: 'e.g. llama3.1', help: 'e.g. llama3.1 — the Ollama model tag you have pulled' },
      { key: 'baseUrl', label: 'Base URL', type: 'text', required: false, default: 'http://localhost:11434/v1' }
    ],
    envDefaults: { model: 'LOCAL_MODEL', baseUrl: 'LOCAL_BASE_URL' }
  },
  {
    id: 'other',
    label: 'Other (OpenAI-compatible)',
    managed: false,
    fields: [
      { key: 'baseUrl', label: 'Base URL', type: 'text', required: true, placeholder: 'https://…/v1' },
      { key: 'model', label: 'Model', type: 'text', required: true, placeholder: 'the model name for your endpoint', help: 'the model name for your OpenAI-compatible endpoint' },
      { key: 'apiKey', label: 'API key', type: 'password', required: false, placeholder: 'sk-…' }
    ],
    envDefaults: { baseUrl: 'OTHER_BASE_URL', model: 'OTHER_MODEL', apiKey: 'OTHER_API_KEY' }
  },
  {
    // The managed Kip backend: one kip_ key instead of per-provider keys; the
    // backend picks the model per workload and meters usage server-side. It is
    // a visible, opt-in alternative to BYOK — never the default, never gated
    // behind an invite flag (kip#79).
    id: 'kip',
    label: 'Kip (managed)',
    managed: true,
    staticModel: 'auto',
    fields: [
      { key: 'apiKey', label: 'API key', type: 'password', required: true, placeholder: 'kip_…', help: 'From your Kip backend admin → Accounts → Keys.' },
      { key: 'baseUrl', label: 'Base URL', type: 'text', required: false, default: KIP_DEFAULT_BASE_URL, help: 'Leave as-is for the hosted service, or point it at a self-hosted Kip backend.' }
    ],
    envDefaults: { apiKey: 'KIP_API_KEY', baseUrl: 'KIP_BASE_URL' }
  }
]

export const KIP_BASE_URL_DEFAULT = KIP_DEFAULT_BASE_URL

/** The provider schema for `id`, or null when it isn't a built-in. */
export function providerInfo (id: string): ProviderInfo | null {
  return PROVIDERS.find((provider) => provider.id === id) ?? null
}

/** Every selectable provider, for the settings surface. The managed backend is included. */
export function listProviders (): ProviderInfo[] {
  return PROVIDERS.map((provider) => ({ ...provider, fields: provider.fields.map((field) => ({ ...field })) }))
}

/**
 * Reads `<coop>/.henhouse/llm.json`. Returns null if it doesn't exist (callers
 * fall back to env vars entirely in that case). Throws if it exists but isn't
 * valid JSON — a corrupt config file is a real problem, not a
 * silently-ignorable one.
 */
export function loadLLMConfig (vaultRoot = paths.DEFAULT_VAULT_ROOT): LLMFileConfig | null {
  const file = paths.configPath(vaultRoot)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as LLMFileConfig
  } catch (err) {
    throw new Error(`.henhouse/llm.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Writes `<coop>/.henhouse/llm.json`, creating `.henhouse/` if needed. */
export function saveLLMConfig (config: LLMFileConfig, vaultRoot = paths.DEFAULT_VAULT_ROOT): void {
  const file = paths.configPath(vaultRoot)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
}

/**
 * Resolves one provider's config values: for each field, the config file wins,
 * then the field's env var, then the field's declared default. `env` is
 * injectable for tests.
 */
export function resolveConfig (
  info: ProviderInfo,
  fileConfig: Record<string, string | undefined> = {},
  env: NodeJS.ProcessEnv = process.env
): ProviderConfig {
  const keys = new Set([
    ...info.fields.map((field) => field.key),
    ...Object.keys(info.envDefaults)
  ])
  const resolved: ProviderConfig = {}
  for (const key of keys) {
    const field = info.fields.find((candidate) => candidate.key === key)
    const envVar = info.envDefaults[key]
    resolved[key] =
      (fileConfig && fileConfig[key]) ||
      (envVar ? env[envVar] : undefined) ||
      (field ? field.default : undefined) ||
      undefined
  }
  return resolved
}

/** The first required field left blank after resolution, or null. */
export function missingRequiredField (info: ProviderInfo, config: ProviderConfig): ProviderField | null {
  return info.fields.find((field) => field.required && !config[field.key]) ?? null
}

/**
 * Reads `.henhouse/llm.json` once and works out the active provider: its id
 * (file's `provider`, else $PROVIDER, else "anthropic"), its schema, and its
 * resolved config. Throws for an unknown provider id — the same clear error
 * the JS host raised.
 */
export function resolveActive (
  vaultRoot = paths.DEFAULT_VAULT_ROOT,
  env: NodeJS.ProcessEnv = process.env
): ActiveProvider {
  const fileConfig = loadLLMConfig(vaultRoot)
  const id = (fileConfig?.provider || env.PROVIDER || 'anthropic').toLowerCase()
  const info = providerInfo(id)
  if (!info) {
    throw new Error(`Unknown PROVIDER "${id}". Supported: ${PROVIDERS.map((provider) => provider.id).join(', ')}.`)
  }
  const block = fileConfig?.providers?.[id] ?? {}
  const config = resolveConfig(info, block, env)
  const model = config.model || info.staticModel || null
  return { id: info.id, info, config, model }
}

/** The clear "<ENV_VAR> is required when PROVIDER=…" message the JS host threw. */
export function requiredFieldError (info: ProviderInfo, field: ProviderField): Error {
  const envVar = info.envDefaults[field.key] || field.label
  const hint = field.help ? ` (${field.help})` : ''
  return new Error(
    `${envVar} is required when PROVIDER=${info.id}${hint} ` +
    '(set it in .henhouse/llm.json or the environment).'
  )
}
