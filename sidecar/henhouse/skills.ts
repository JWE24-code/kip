// Registers the migrated built-in skills as turn-loop tools (kip#78, kip#105).
//
// The four skills — web-search, reminders, kip-control, docx — are discovered
// from their `SKILL.md` manifests (with the capability fields the executor
// enforces) and bridged into the loop's `Tool` interface. Each runs through
// the capability-limited executor; the parent supplies the hostcall
// implementations (`webSearch`, `internalActions`, and the vault-rooted
// `read_vault_file`) and, where a turn has retrieved notes, a read-only
// snapshot.
//
// This is the seam the sidecar wires once it constructs its TurnLoop; the
// skills themselves never appear here by name again.

import type { Tool } from '../session/loop.ts'
import type { SkillExecutor } from './executor.ts'
import type { InternalActionFn, LlmCompleteFn, WebSearchFn } from './hostcalls.ts'
import type { SkillSnapshot } from './mounts.ts'
import { discoverSkills } from './manifest.ts'
import { createSkillTool } from './tools.ts'

export const MIGRATED_BUILTIN_SKILLS = ['web-search', 'reminders', 'kip-control', 'docx'] as const

export interface BuiltinSkillToolsDeps {
  executor: SkillExecutor
  vaultRoot: string
  /** Parent-side LLM for `llm.complete` (none of the three need it today). */
  llm?: LlmCompleteFn
  /** Parent-side search for the web-search skill. */
  webSearch?: WebSearchFn
  /** Parent-side operations for reminders / kip-control. */
  internalActions?: InternalActionFn
  /** Retrieved notes materialized read-only for this turn. */
  snapshot?: SkillSnapshot
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Override the skill set (tests, or future opt-ins). */
  names?: readonly string[]
}

/** One `Tool` per discovered migrated built-in skill. */
export function createBuiltinSkillTools (deps: BuiltinSkillToolsDeps): Tool[] {
  const wanted = new Set(deps.names ?? MIGRATED_BUILTIN_SKILLS)
  return discoverSkills({ vaultRoot: deps.vaultRoot })
    .filter((manifest) => wanted.has(manifest.name))
    .map((manifest) => createSkillTool({
      executor: deps.executor,
      manifest,
      vaultRoot: deps.vaultRoot,
      ...(deps.snapshot ? { snapshot: deps.snapshot } : {}),
      ...(deps.llm ? { llm: deps.llm } : {}),
      ...(deps.webSearch ? { webSearch: deps.webSearch } : {}),
      ...(deps.internalActions ? { internalActions: deps.internalActions } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
    }))
}
