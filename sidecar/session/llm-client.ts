// The bridge from the sidecar's text-completion client (llm/client.ts, BYOK by
// default) to the model-driven `TurnLoop` (loop.ts).
//
// `callLLM` is a text protocol, not native function-calling: it takes a system
// prompt, one user prompt, and streams prose back. `TurnLoop` speaks native
// tool calls. This adapter is the seam between them — it advertises the loop's
// `ToolSpec`s in the system prompt, parses `<use_tool name="…">{json}</use_tool>`
// blocks out of the reply, and maps usage through. That keeps every provider
// (Anthropic, the OpenAI-compatible family, the managed backend) working
// without teaching `callLLM` each vendor's tool-call wire format.
//
// It is also where the old `session/turn.ts` text protocol now lives: the
// parsing/streaming helpers moved here when the stub loop was retired (kip#94)
// so there is exactly one reachable turn implementation.

import { randomUUID } from 'node:crypto'
import type { ToolSpec } from '../protocol.ts'
import type { LlmClient, LlmMessage, LlmStreamEvent, LlmStreamRequest } from './loop.ts'

// ---- the completion seam ---------------------------------------------------

export interface CompleteRequest {
  system: string
  prompt: string
  onDelta?: (text: string) => void
  signal?: AbortSignal
  label?: string
}

export interface Usage {
  input: number
  output: number
}

export interface CompleteResult {
  text: string
  usage: Usage
}

export type CompleteFn = (request: CompleteRequest) => Promise<CompleteResult>

// ---- the ReAct text protocol ----------------------------------------------

const TOOL_OPEN = '<use_tool'
const TOOL_TAG = /<use_tool\s+name="([^"]+)"\s*>([\s\S]*?)<\/use_tool>/g

export interface ParsedToolCall {
  name: string
  toolCallId: string
  args: unknown
  rawArgs: string
  jsonError?: string
}

/** Parses zero or more `<use_tool name="…">{json}</use_tool>` tags. A tag whose
 *  body is not JSON still surfaces as a call (with jsonError set) so the loop
 *  reports a failed tool call rather than treating broken output as an answer. */
export function parseToolCalls (text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = []
  for (const match of text.matchAll(TOOL_TAG)) {
    const rawArgs = match[2].trim()
    let args: unknown
    let jsonError: string | undefined
    try {
      args = JSON.parse(rawArgs)
    } catch (err) {
      jsonError = err instanceof Error ? err.message : String(err)
    }
    calls.push({ name: match[1], toolCallId: randomUUID(), args, rawArgs, jsonError })
  }
  return calls
}

/** How much of the buffer so far is safe to stream to the client. While the
 *  text could still be the opening of a <use_tool> tag we hold it back, so a
 *  tool-call turn produces no user-facing tag text. */
export function safeReleaseLength (buffer: string): number {
  const trimmed = buffer.replace(/^\s+/, '')
  if (!trimmed) return 0
  const lower = trimmed.toLowerCase()
  if (TOOL_OPEN.startsWith(lower)) return 0
  if (lower.startsWith(TOOL_OPEN)) return 0
  return buffer.length
}

/** Withholds tool tags from the streamed text: everything before the first
 *  `<use_tool`, and any trailing fragment that could still grow into one. */
class ToolTagFilter {
  private buffer = ''
  private emitted = 0

  push (chunk: string, emit: (text: string) => void): void {
    if (!chunk) return
    this.buffer += chunk
    this.flush(emit)
  }

  finish (emit: (text: string) => void): void {
    this.flush(emit)
  }

  private safeEnd (): number {
    const lower = this.buffer.toLowerCase()
    const tag = lower.indexOf(TOOL_OPEN, this.emitted)
    if (tag >= 0) return tag
    const maxPartial = TOOL_OPEN.length - 1
    for (let len = Math.min(maxPartial, this.buffer.length - this.emitted); len > 0; len -= 1) {
      const start = this.buffer.length - len
      if (lower.slice(start) === TOOL_OPEN.slice(0, len)) return start
    }
    return this.buffer.length
  }

  private flush (emit: (text: string) => void): void {
    const end = this.safeEnd()
    if (end > this.emitted) {
      emit(this.buffer.slice(this.emitted, end))
      this.emitted = end
    }
  }
}

/** The system prompt advertising the loop's tools and the tag protocol. */
export function buildSystemPrompt (tools: ToolSpec[]): string {
  const lines = [
    'You are the Kip sidecar, answering one turn for a personal knowledge base. You drive the turn: call tools when they help, otherwise answer.',
    '',
    'Available tools:',
  ]
  for (const tool of tools) {
    lines.push(`- ${tool.name}: ${tool.description}`)
    if (tool.parameters) lines.push(`  arguments: ${JSON.stringify(tool.parameters)}`)
  }
  lines.push(
    '',
    'To call one or more tools, include blocks of exactly this shape in your reply:',
    '<use_tool name="TOOL_NAME">{ "argument": "value" }</use_tool>',
    'Do not wrap them in markdown code fences. After the tool results come back, either call another tool or answer in clean readable prose with no tags.',
  )
  return lines.join('\n')
}

/** Renders the loop's message history into the single prompt `callLLM` takes. */
export function renderMessages (messages: LlmMessage[]): string {
  const toolNames = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls) {
      for (const call of message.toolCalls) toolNames.set(call.id, call.name)
    }
  }

  const lines: string[] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'user') {
      lines.push(`User: ${message.content}`)
    } else if (message.role === 'assistant') {
      const tags = (message.toolCalls ?? [])
        .map((call) => `<use_tool name="${call.name}">${JSON.stringify(call.arguments ?? {})}</use_tool>`)
        .join('\n')
      lines.push(`Assistant: ${[message.content, tags].filter(Boolean).join('\n')}`)
    } else {
      const name = toolNames.get(message.toolCallId)
      lines.push(`Tool${name ? ` ${name}` : ''} result (${message.toolCallId}):\n${message.content}`)
    }
  }
  if (messages.at(-1)?.role === 'tool') {
    lines.push('Continue: call another tool if needed, otherwise answer in prose.')
  }
  return lines.join('\n\n')
}

// ---- the adapter -----------------------------------------------------------

/**
 * Wraps a `CompleteFn` as the `LlmClient` the `TurnLoop` consumes. Text is
 * streamed live (tool tags filtered out); parsed calls and usage follow once
 * the completion resolves. The completion's abort signal is the loop's, so a
 * `chat.cancel` unwinds an in-flight provider request directly.
 */
export function createReActLlmClient (complete: CompleteFn): LlmClient {
  return {
    async *stream (request: LlmStreamRequest): AsyncIterable<LlmStreamEvent> {
      const system = buildSystemPrompt(request.tools)
      const prompt = renderMessages(request.messages)
      const filter = new ToolTagFilter()

      const queue: LlmStreamEvent[] = []
      let wake: (() => void) | null = null
      let finished = false
      let failure: unknown = null

      const push = (event: LlmStreamEvent): void => {
        queue.push(event)
        wake?.()
        wake = null
      }

      const run = complete({
        system,
        prompt,
        onDelta: (chunk) => filter.push(chunk, (text) => push({ type: 'text', text })),
        signal: request.signal,
        label: 'sidecar:turn',
      }).then((result) => {
        filter.finish((text) => push({ type: 'text', text }))
        for (const call of parseToolCalls(result.text)) {
          const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {}
          push({ type: 'tool-call', call: { id: call.toolCallId, name: call.name, arguments: args } })
        }
        push({ type: 'usage', usage: { inputTokens: result.usage.input, outputTokens: result.usage.output } })
      }).catch((error: unknown) => {
        failure = error
      }).finally(() => {
        finished = true
        wake?.()
        wake = null
      })
      void run

      while (!finished || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift() as LlmStreamEvent
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }

      if (failure) throw failure
      yield { type: 'done' }
    },
  }
}
