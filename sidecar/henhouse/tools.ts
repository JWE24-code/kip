// Bridges a discovered skill into the turn loop's `Tool` interface (kip#77).
//
// The loop only knows about tools: a `spec` it can advertise to the model and a
// `run(args, ctx)` that returns a string. A skill is not a tool — it is a
// manifest plus a sandboxed process — so this adapter is the seam: it validates
// arguments against the manifest, calls the executor with the turn's abort
// signal, and renders the bounded result back into the transcript. Marking it
// `kind: 'skill'` makes the loop give the exec its own full-fidelity trace line
// (protocol.ts `SkillExecEvent`).
//
// #78 builds on this to register web-search / reminders / kip-control rather
// than on the old unsandboxed `skills.js`.

import type { Tool, ToolContext } from '../session/loop.ts'
import type { SkillExecutor, SkillRunRequest } from './executor.ts'
import type { SkillManifest, SkillParameter } from './manifest.ts'
import type { LlmCompleteFn } from './hostcalls.ts'
import type { SkillSnapshot } from './mounts.ts'

export interface SkillToolDeps {
  executor: SkillExecutor
  manifest: SkillManifest
  vaultRoot: string
  /** Retrieved notes materialized read-only under the input mount. */
  snapshot?: SkillSnapshot
  llm?: LlmCompleteFn
  fetchImpl?: typeof fetch
}

function jsonType (type: string): string {
  switch (type) {
    case 'array': return 'array'
    case 'object': return 'object'
    case 'number': case 'integer': return 'number'
    case 'boolean': return 'boolean'
    default: return 'string'
  }
}

/** The manifest's parameter list as the JSON schema the loop advertises. */
export function skillParametersSchema (parameters: SkillParameter[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const param of parameters) {
    properties[param.name] = {
      type: jsonType(param.type),
      ...(param.description ? { description: param.description } : {}),
      ...(param.enum ? { enum: param.enum } : {})
    }
    if (param.required) required.push(param.name)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/** Renders a run into the string the loop feeds back (and the trace records). */
export function formatSkillResult (result: Awaited<ReturnType<SkillExecutor['run']>>): string {
  const body = result.output || (result.ok ? '(skill produced no output)' : '')
  const lines = [body]
  if (result.artifacts.length) {
    lines.push(`Files written:\n${result.artifacts.map((file) => `- ${file}`).join('\n')}`)
  }
  if (!result.ok) lines.push(`Error: ${result.error ?? result.reason}`)
  return lines.filter(Boolean).join('\n')
}

/** One manifest as a loop tool. The signal lets `chat.cancel` kill the skill. */
export function createSkillTool (deps: SkillToolDeps): Tool {
  const { manifest } = deps
  return {
    kind: 'skill',
    spec: {
      name: manifest.name,
      description: [manifest.description, manifest.whenToUse].filter(Boolean).join(' '),
      parameters: skillParametersSchema(manifest.parameters)
    },
    run: async (args: unknown, ctx: ToolContext): Promise<string> => {
      const request: SkillRunRequest = {
        manifest,
        input: args,
        vaultRoot: deps.vaultRoot,
        ...(deps.snapshot ? { snapshot: deps.snapshot } : {}),
        ...(deps.llm ? { llm: deps.llm } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        signal: ctx.signal
      }
      return formatSkillResult(await deps.executor.run(request))
    }
  }
}
