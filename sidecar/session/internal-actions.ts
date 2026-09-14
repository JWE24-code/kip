// Parent-side hostcall implementations for the migrated built-in skills
// (kip#78).
//
// Two capabilities live here, both performed by the parent — which owns the
// vault, the search backend, and its API keys — never by a sandboxed skill:
//
//   * `web_search`       — run the configured search backend (settings,
//                          including its key) and return parsed results. The
//                          web-search skill only wraps and relays them.
//   * `internal_action`  — run a sidecar-internal operation a skill cannot
//                          express as a mount: reminders, and kip-control's
//                          Hatch / Groom / rebuild-roost / settings ops.
//
// The operation logic lives in the trusted `scripts/lib/*` modules so the
// legacy CLI path and the parent path share one implementation.

import { createRequire } from 'node:module'
import type { InternalActionFn, WebSearchFn } from '../henhouse/hostcalls.ts'

const require = createRequire(import.meta.url)
const paths = require('../../scripts/lib/paths.js') as { DEFAULT_VAULT_ROOT: string }

interface SearchSettings {
  backend: string
  braveApiKey: string
  tavilyApiKey: string
}

interface SearchModule {
  search: (
    backend: string,
    query: string,
    count: number,
    opts: { braveApiKey?: string, tavilyApiKey?: string }
  ) => Promise<Array<{ title: string, url: string, snippet: string }>>
}

interface SkillsModule {
  loadSearchSettings: (vaultRoot: string) => SearchSettings
}

interface ReminderActionsModule {
  runReminderOperation: (input: Record<string, unknown>, options: { vaultRoot: string }) => string
}

interface KipControlModule {
  runKipControlOperation: (
    input: Record<string, unknown>,
    options: { vaultRoot: string }
  ) => Promise<string>
}

function asParams (params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {}
}

const needsKey = (label: string, envVar: string): string =>
  `web-search is set to the ${label} backend but no API key is configured. ` +
  `Add one in Settings -> Skills (or set ${envVar} in <coop>/.henhouse/skills.json), ` +
  'or switch to the keyless DuckDuckGo backend. Answering from the wiki for now.'

/**
 * The parent's `web_search` hostcall. Runs the same backend logic as the skill
 * entry used to, but with the key resolved in the parent so it never crosses
 * into the sandbox.
 */
export function createWebSearchHostcall (vaultRoot: string = paths.DEFAULT_VAULT_ROOT): WebSearchFn {
  const skills = require('../../scripts/lib/skills.js') as SkillsModule
  const { search } = require('../../scripts/skills/web-search/search.js') as SearchModule

  return async ({ query, count }) => {
    const settings = skills.loadSearchSettings(vaultRoot)
    const backend = settings.backend
    if (backend === 'brave' && !settings.braveApiKey) throw new Error(needsKey('Brave', 'BRAVE_API_KEY'))
    if (backend === 'tavily' && !settings.tavilyApiKey) throw new Error(needsKey('Tavily', 'TAVILY_API_KEY'))
    const results = await search(backend, query, Math.min(Math.max(1, Number(count) || 5), 10), {
      braveApiKey: settings.braveApiKey,
      tavilyApiKey: settings.tavilyApiKey
    })
    return { backend, results }
  }
}

/**
 * The parent's `internal_action` hostcall. Namespaced actions map to the
 * trusted operation logic; anything else is refused.
 */
export function createInternalActionHandler (
  vaultRoot: string = paths.DEFAULT_VAULT_ROOT
): InternalActionFn {
  const reminders = require('../../scripts/lib/reminder-actions.js') as ReminderActionsModule
  const kip = require('../../scripts/lib/kip-control.js') as KipControlModule

  return async ({ action, params }) => {
    switch (action) {
      case 'reminders':
        return reminders.runReminderOperation(asParams(params), { vaultRoot })
      case 'kip-control':
        return kip.runKipControlOperation(asParams(params), { vaultRoot })
      default:
        throw new Error(`unknown internal action "${action}"`)
    }
  }
}
