// The tool set a live `TurnLoop` is wired with (kip#94). Before this, ws.ts
// only ever reached the P1 stub, so every real tool built in P1–P7 — the read
// path, the git-versioned write path, and the capability-limited skills — was
// unreachable from a real client.
//
// `ask_user` is not here: the loop owns it, so every turn has it regardless of
// the tool set. `undo` is not a model tool either; it stays a client event
// (`undo` / `undo.applied`) because it must be usable when no turn is running.

import { createBuiltinSkillTools } from '../henhouse/skills.ts'
import { createSkillExecutor, type SkillExecutor } from '../henhouse/executor.ts'
import type { LlmCompleteFn } from '../henhouse/hostcalls.ts'
import type { CompleteFn } from './llm-client.ts'
import type { Tool } from './loop.ts'
import { createNoteTools } from './notes.ts'
import { createWriteTools } from './notes-write.ts'
import { createInternalActionHandler, createWebSearchHostcall } from './internal-actions.ts'

export interface DefaultToolDeps {
  vaultRoot: string
  /** The text-completion seam, exposed to skills as the `llm.complete` hostcall. */
  complete?: CompleteFn
  /** Skip skill discovery/registration entirely. */
  includeSkills?: boolean
  /** Injectable for tests. */
  executor?: SkillExecutor
}

/** `search_notes`, `read_note`, `write_agent_note`, `update_agent_note`, and the
 *  built-in skills discovered from `SKILL.md` (web-search, reminders,
 *  kip-control by default). */
export function createDefaultTools (deps: DefaultToolDeps): Tool[] {
  const tools: Tool[] = [
    ...createNoteTools({ vaultRoot: deps.vaultRoot }),
    ...createWriteTools({ vaultRoot: deps.vaultRoot })
  ]
  if (deps.includeSkills === false) return tools

  const complete = deps.complete
  const llm: LlmCompleteFn | undefined = complete
    ? async ({ prompt, system }) => ({ text: (await complete({ system: system ?? '', prompt })).text })
    : undefined

  tools.push(...createBuiltinSkillTools({
    executor: deps.executor ?? createSkillExecutor(),
    vaultRoot: deps.vaultRoot,
    ...(llm ? { llm } : {}),
    webSearch: createWebSearchHostcall(deps.vaultRoot),
    internalActions: createInternalActionHandler(deps.vaultRoot)
  }))
  return tools
}
