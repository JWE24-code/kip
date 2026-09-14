// The one stub tool the skeleton runs. It exists to prove the loop's tool
// round-trip end to end — the model calls it, its result is fed back into the
// next completion, and that result is visible in the answer. Real tools
// (search_notes, read_note, write_agent_note, …) land in later phases and
// replace this entry without changing the loop or the wire protocol.

import { z } from 'zod'

export const STUB_TOOL_NAME = 'stub_echo'

export const stubToolSchema = z.object({
  query: z.string().min(1).describe('The text to echo back.')
})

export type StubToolArgs = z.infer<typeof stubToolSchema>

export interface ToolDefinition {
  name: string
  description: string
  schema: z.ZodType
}

export const STUB_TOOL: ToolDefinition = {
  name: STUB_TOOL_NAME,
  description: 'Echo a query back with a short canned note. Use it to confirm the tool path works.',
  schema: stubToolSchema
}

/** Deterministic, no I/O — the next completion can be asserted against it. */
export function runStubTool (args: StubToolArgs): string {
  return `stub_echo: ${args.query}`
}

export function truncateResult (
  text: string,
  maxChars: number
): { text: string, truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(0, maxChars), truncated: true }
}
