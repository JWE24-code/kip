// The turn skeleton: a bounded, model-driven tool loop. The model is called
// with a text protocol (the same ReAct-style approach scripts/lib/prompts.js
// already uses, so lib/llm.js stays provider-agnostic — no native function
// calling), and the loop either streams the answer back or runs the stub tool
// and feeds the result into the next completion.
//
// Boundaries enforced here (SPEC-1 FR-1/FR-2): at most 15 tool calls per turn,
// exactly one retry on malformed tool arguments before the turn fails cleanly,
// turn.delta batched every ~50ms, and tool results truncated to 500 chars on
// the way to the client.

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { STUB_TOOL, STUB_TOOL_NAME, runStubTool, stubToolSchema, truncateResult } from './tools.ts'
import { ErrorCode, TurnEndReason } from '../server/protocol.ts'
import { silentLogger, type Logger } from '../logger.ts'

export const DEFAULT_MAX_TOOL_CALLS = 15
export const DEFAULT_DELTA_BATCH_MS = 50
export const DEFAULT_MAX_RESULT_CHARS = 500

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

export type EmitFn = (type: string, payload: Record<string, unknown>) => void

export interface RunTurnOptions {
  turnId: string
  text: string
  emit: EmitFn
  complete: CompleteFn
  maxToolCalls?: number
  deltaBatchMs?: number
  maxResultChars?: number
  signal?: AbortSignal
  logger?: Logger
}

export interface TurnResult {
  turnId: string
  reason: (typeof TurnEndReason)[keyof typeof TurnEndReason]
  text: string
  usage: Usage
  toolCalls: number
}

export interface ParsedToolCall {
  name: string
  toolCallId: string
  args: unknown
  rawArgs: string
  jsonError?: string
}

const TOOL_TAG = /<use_tool\s+name="([^"]+)"\s*>([\s\S]*?)<\/use_tool>/g
const CONTROL_PREFIX = '<use_tool'

/** Parses zero or more <use_tool name="…">{json}</use_tool> tags. A tag whose
 *  body is not JSON still surfaces as a call (with jsonError set) so the loop
 *  can count it as bad arguments and retry, rather than silently treating a
 *  broken tool call as the final answer. */
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
 *  tool-call turn produces no user-facing deltas and only the final answer's
 *  prose is streamed. */
export function safeReleaseLength (buffer: string): number {
  const trimmed = buffer.replace(/^\s+/, '')
  if (!trimmed) return 0
  const lower = trimmed.toLowerCase()
  if (CONTROL_PREFIX.startsWith(lower)) return 0
  if (lower.startsWith(CONTROL_PREFIX)) return 0
  return buffer.length
}

/** Accumulates streamed text and releases it in ~batchMs chunks. */
class DeltaStream {
  private readonly send: (text: string, seq: number) => void
  private readonly batchMs: number
  private buffer = ''
  private released = 0
  private seq = 0
  private timer: NodeJS.Timeout | null = null
  private finished = false

  constructor (send: (text: string, seq: number) => void, batchMs: number) {
    this.send = send
    this.batchMs = batchMs
  }

  push (chunk: string): void {
    if (this.finished || !chunk) return
    this.buffer += chunk
    if (safeReleaseLength(this.buffer) > this.released) this.schedule()
  }

  private schedule (): void {
    if (this.timer || this.finished) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.batchMs)
    this.timer.unref()
  }

  flush (): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const upto = this.finished ? this.buffer.length : safeReleaseLength(this.buffer)
    if (upto <= this.released) return
    const text = this.buffer.slice(this.released, upto)
    this.released = upto
    this.seq += 1
    this.send(text, this.seq)
  }

  /** `discard: true` drops the held text (a tool-call turn never streams);
   *  `false` flushes the remaining prose as the final delta. */
  finish (discard: boolean): void {
    if (this.finished) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.finished = true
    if (discard) {
      this.released = this.buffer.length
    } else {
      this.flush()
    }
  }
}

export function buildSystemPrompt (maxToolCalls: number): string {
  return `You are the Kip sidecar, answering one turn for a personal knowledge base. You drive the turn: you decide whether to call a tool or answer.

You have exactly one tool:

### ${STUB_TOOL.name}
${STUB_TOOL.description}
Arguments: { "query": string (required) }

To call it, make your ENTIRE reply exactly one tag and nothing else:
<use_tool name="${STUB_TOOL.name}">{ "query": "the text" }</use_tool>

You will receive the tool's result, then may call it again or answer. When you can answer, write clean readable prose with no tags and no JSON. Hard limit: ${maxToolCalls} tool calls per turn. If your tool arguments are rejected, fix the JSON and try once more; a second invalid call ends the turn.`
}

function summarizeZodError (error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join('; ')
}

export async function runTurn (options: RunTurnOptions): Promise<TurnResult> {
  const turnId = options.turnId
  const maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS
  const deltaBatchMs = options.deltaBatchMs ?? DEFAULT_DELTA_BATCH_MS
  const maxResultChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS
  const logger = options.logger ?? silentLogger

  const usage: Usage = { input: 0, output: 0 }
  let toolCalls = 0
  let invalidRetries = 0

  const emit: EmitFn = (type, payload) => {
    try {
      options.emit(type, payload)
    } catch (err) {
      logger.warn(`emit ${type} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const emitUsage = (): void => {
    emit('turn.usage', {
      turnId,
      inputTokens: usage.input,
      outputTokens: usage.output,
      toolCalls
    })
  }

  const end = (
    reason: TurnResult['reason'],
    text: string
  ): TurnResult => {
    emitUsage()
    emit('turn.end', { turnId, reason, text })
    return { turnId, reason, text, usage, toolCalls }
  }

  emit('turn.start', { turnId, startedAt: Date.now() })

  let transcript = `User: ${options.text}`
  const system = buildSystemPrompt(maxToolCalls)

  try {
    for (;;) {
      const stream = new DeltaStream(
        (delta, seq) => emit('turn.delta', { turnId, seq, text: delta }),
        deltaBatchMs
      )

      let completion: CompleteResult
      try {
        completion = await options.complete({
          system,
          prompt: transcript,
          onDelta: (chunk) => stream.push(chunk),
          signal: options.signal,
          label: 'sidecar:turn'
        })
      } catch (err) {
        stream.finish(true)
        throw err
      }

      usage.input += completion.usage.input
      usage.output += completion.usage.output

      const calls = parseToolCalls(completion.text)
      if (!calls.length) {
        stream.finish(false)
        return end(TurnEndReason.COMPLETE, completion.text)
      }

      stream.finish(true)
      const call = calls[0]

      if (call.name !== STUB_TOOL_NAME) {
        invalidRetries += 1
        if (invalidRetries <= 1) {
          transcript += `\n\nAssistant: ${completion.text}` +
            `\n\nSystem: No tool named "${call.name}". Use only ${STUB_TOOL_NAME}, or answer in prose.`
          continue
        }
        emit('turn.error', {
          turnId,
          code: ErrorCode.TOOL_ARGS_INVALID,
          message: `unknown tool "${call.name}" after one retry`
        })
        return end(TurnEndReason.ERROR, '')
      }

      const validated = call.jsonError
        ? { success: false as const, error: `invalid JSON: ${call.jsonError}` }
        : validateStubArgs(call.args)

      if (!validated.success) {
        invalidRetries += 1
        if (invalidRetries <= 1) {
          transcript += `\n\nAssistant: ${completion.text}` +
            `\n\nSystem: That tool call's arguments were invalid (${validated.error}). ` +
            'Reply again with a valid call or a final prose answer.'
          continue
        }
        emit('turn.error', {
          turnId,
          code: ErrorCode.TOOL_ARGS_INVALID,
          message: `tool arguments invalid after one retry: ${validated.error}`
        })
        return end(TurnEndReason.ERROR, '')
      }

      invalidRetries = 0

      if (toolCalls >= maxToolCalls) {
        return end(TurnEndReason.MAX_TOOLS, '')
      }

      toolCalls += 1
      const toolCallId = call.toolCallId
      emit('agent.tool.start', { turnId, toolCallId, name: call.name, args: validated.data })

      const { text: resultText, truncated } = truncateResult(runStubToolSafe(validated.data), maxResultChars)
      emit('agent.tool.end', {
        turnId,
        toolCallId,
        name: call.name,
        ok: true,
        result: resultText,
        truncated
      })

      transcript += `\n\nAssistant: ${completion.text}` +
        `\n\nTool ${call.name} result (id ${toolCallId}):\n${resultText}` +
        `\n\nUse this result. Call ${STUB_TOOL_NAME} again if useful, otherwise answer in prose.`
    }
  } catch (err) {
    emit('turn.error', {
      turnId,
      code: ErrorCode.INTERNAL,
      message: err instanceof Error ? err.message : String(err)
    })
    return end(TurnEndReason.ERROR, '')
  }
}

function validateStubArgs (
  args: unknown
): { success: true, data: z.infer<typeof stubToolSchema> } | { success: false, error: string } {
  const result = stubToolSchema.safeParse(args)
  if (result.success) return { success: true, data: result.data }
  return { success: false, error: summarizeZodError(result.error) }
}

function runStubToolSafe (args: z.infer<typeof stubToolSchema>): string {
  try {
    return runStubTool(args)
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`
  }
}
