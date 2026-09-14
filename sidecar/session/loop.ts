// The turn loop — the model-driven tool-calling core the sidecar wraps.
//
// Extends the #68 skeleton with the two pieces a one-shot pipeline can't
// express: a turn can *suspend* on `ask_user` and resume on the matching
// `chat.respond`, and a turn can be *cancelled* mid-stream, ending within 1s
// while still reporting the tokens consumed so far. Every significant event is
// handed to a trace sink (traces/recorder.ts) with untruncated results; the
// client sees tool results truncated to a sane size.

import { randomUUID } from 'node:crypto'
import type {
  AskUserEvent,
  ErrorCode,
  LlmToolCall,
  ToolSpec,
  TurnEndReason,
  TurnError,
  TurnEvent,
  TurnResult,
  Usage,
} from '../protocol.ts'
import { ERROR_CODES, ProtocolError } from '../protocol.ts'

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string }

export type LlmStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; call: LlmToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'done' }

export interface LlmStreamRequest {
  sessionId: string
  messages: LlmMessage[]
  tools: ToolSpec[]
  signal: AbortSignal
}

export interface LlmClient {
  stream(request: LlmStreamRequest): AsyncIterable<LlmStreamEvent>
}

export interface ToolContext {
  sessionId: string
  turnId: string
  signal: AbortSignal
  // Available to any tool, not just the built-in one: a skill may need to ask
  // the user mid-work.
  askUser(question: string, options?: string[]): Promise<string>
}

export interface Tool {
  spec: ToolSpec
  // `skill` marks a tool whose exec gets its own full-fidelity trace line.
  kind?: 'tool' | 'skill'
  run(args: unknown, ctx: ToolContext): Promise<string> | string
}

export interface TraceSink {
  record(event: { type: string; [key: string]: unknown }): void
}

export interface TurnLoopOptions {
  llm: LlmClient
  emit: (event: TurnEvent) => void
  recorder?: TraceSink | null
  tools?: Tool[]
  // ≤15 tool calls per turn (SPEC-1 FR-29/30 baseline from #68).
  maxToolCalls?: number
  // The client-facing cap on a tool result; the trace keeps the full string.
  clientResultCharLimit?: number
  // Hard ceiling for a cancel to unwind the loop.
  cancelTimeoutMs?: number
  now?: () => number
  newId?: () => string
}

interface PendingAsk {
  callId: string
  resolve: (answer: string) => void
  reject: (error: unknown) => void
  onAbort: () => void
}

interface ActiveTurn {
  turnId: string
  sessionId: string
  controller: AbortController
  cancelled: boolean
  ended: boolean
  reason: TurnEndReason | null
  error: TurnError | null
  toolCalls: number
  usage: Usage
  messages: LlmMessage[]
  pendingAsk: PendingAsk | null
  done: Promise<void>
  resolveDone: () => void
}

export const ASK_USER_NAME = 'ask_user'

export const ASK_USER_SPEC: ToolSpec = {
  name: ASK_USER_NAME,
  description: 'Pause the turn and ask the user a clarifying question. Returns their answer as a string.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to put to the user.' },
      options: { type: 'array', items: { type: 'string' }, description: 'Optional suggested answers.' },
    },
    required: ['question'],
  },
}

function abortError(): ProtocolError {
  return new ProtocolError(ERROR_CODES.ABORTED, 'turn aborted')
}

function isAbort(error: unknown): boolean {
  return error instanceof ProtocolError && error.code === ERROR_CODES.ABORTED
}

function errorCode(error: unknown): ErrorCode | string {
  return error instanceof ProtocolError ? error.code : 'TURN_FAILED'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

export class TurnLoop {
  llm: LlmClient
  emit: (event: TurnEvent) => void
  recorder: TraceSink | null
  tools: Map<string, Tool>
  maxToolCalls: number
  clientResultCharLimit: number
  cancelTimeoutMs: number
  now: () => number
  newId: () => string

  private active: ActiveTurn | null = null

  constructor(options: TurnLoopOptions) {
    this.llm = options.llm
    this.emit = options.emit
    this.recorder = options.recorder ?? null
    this.tools = new Map((options.tools ?? []).map((tool) => [tool.spec.name, tool]))
    this.maxToolCalls = options.maxToolCalls ?? 15
    this.clientResultCharLimit = options.clientResultCharLimit ?? 500
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? 1000
    this.now = options.now ?? (() => Date.now())
    this.newId = options.newId ?? (() => randomUUID())
  }

  isRunning(): boolean {
    return this.active !== null
  }

  activeTurnId(): string | null {
    return this.active ? this.active.turnId : null
  }

  async start(sessionId: string, userMessage: string): Promise<TurnResult> {
    if (this.active) {
      throw new ProtocolError(
        ERROR_CODES.TURN_ALREADY_RUNNING,
        `turn ${this.active.turnId} is still running on session ${this.active.sessionId}`,
      )
    }

    const turnId = this.newId()
    let resolveDone: () => void = () => {}
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    const active: ActiveTurn = {
      turnId,
      sessionId,
      controller: new AbortController(),
      cancelled: false,
      ended: false,
      reason: null,
      error: null,
      toolCalls: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      messages: [{ role: 'user', content: userMessage }],
      pendingAsk: null,
      done,
      resolveDone,
    }
    this.active = active

    this.dispatch(active, { type: 'turn.start', turnId, sessionId })
    this.trace(active, { type: 'turn.prompt', prompt: userMessage, messages: active.messages })

    try {
      await this.runModel(active)
      this.finish(active, active.cancelled ? 'cancelled' : 'completed')
    } catch (error) {
      if (active.cancelled || isAbort(error)) {
        this.finish(active, 'cancelled')
      } else {
        const code = errorCode(error)
        const message = errorMessage(error)
        active.error = { code, message }
        this.dispatch(active, { type: 'turn.error', turnId, code, message })
        this.finish(active, 'error')
      }
    }

    const result: TurnResult = {
      turnId,
      reason: active.reason ?? 'error',
      usage: { ...active.usage },
    }
    if (active.error) result.error = active.error
    return result
  }

  // Resume a suspended turn. A respond with no active turn is a turn-scoped
  // miss; a respond for a call that isn't the pending ask is an ask-scoped miss.
  respond(callId: string, answer: string): void {
    const active = this.active
    if (!active) {
      throw new ProtocolError(ERROR_CODES.TURN_NOT_FOUND, 'no active turn to respond to')
    }
    const pending = active.pendingAsk
    if (!pending || pending.callId !== callId) {
      throw new ProtocolError(ERROR_CODES.NO_PENDING_ASK, `no pending ask_user for toolCallId ${callId}`)
    }
    active.pendingAsk = null
    active.controller.signal.removeEventListener('abort', pending.onAbort)
    this.dispatch(active, { type: 'chat.respond', turnId: active.turnId, callId, answer })
    pending.resolve(answer)
  }

  // Abort the in-flight stream and any pending ask_user, then wait for the turn
  // to unwind — bounded by cancelTimeoutMs so the ≤1s contract holds even if a
  // client ignores the abort signal. Idempotent once the turn has ended.
  async cancel(turnId: string): Promise<void> {
    const active = this.active
    if (!active || active.turnId !== turnId) {
      throw new ProtocolError(ERROR_CODES.TURN_NOT_FOUND, `no active turn ${turnId}`)
    }
    active.cancelled = true
    active.controller.abort()

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.cancelTimeoutMs) })
    try {
      await Promise.race([active.done, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (!active.ended) this.finish(active, 'cancelled')
  }

  private async runModel(active: ActiveTurn): Promise<void> {
    const specs: ToolSpec[] = [...this.tools.values()].map((tool) => tool.spec)
    specs.push(ASK_USER_SPEC)

    for (let round = 0; round <= this.maxToolCalls; round++) {
      if (active.controller.signal.aborted) throw abortError()

      const textParts: string[] = []
      const calls: LlmToolCall[] = []

      for await (const event of this.llm.stream({
        sessionId: active.sessionId,
        messages: active.messages,
        tools: specs,
        signal: active.controller.signal,
      })) {
        if (active.controller.signal.aborted) throw abortError()
        if (event.type === 'text') {
          if (event.text) {
            textParts.push(event.text)
            this.dispatch(active, { type: 'turn.delta', turnId: active.turnId, text: event.text })
          }
        } else if (event.type === 'tool-call') {
          calls.push(event.call)
        } else if (event.type === 'usage') {
          this.addUsage(active, event.usage)
        }
      }

      // No tool calls → the assistant answered; the turn is done.
      if (calls.length === 0) return

      active.messages.push({ role: 'assistant', content: textParts.join(''), toolCalls: calls })

      for (const call of calls) {
        if (active.toolCalls >= this.maxToolCalls) {
          throw new ProtocolError(
            ERROR_CODES.BUDGET_EXCEEDED,
            `tool-call budget of ${this.maxToolCalls} exceeded`,
          )
        }
        active.toolCalls += 1
        const result = await this.executeTool(active, call)
        active.messages.push({ role: 'tool', toolCallId: call.id, content: result })
      }
    }
  }

  private async executeTool(active: ActiveTurn, call: LlmToolCall): Promise<string> {
    if (call.name === ASK_USER_NAME) return this.askUser(active, call)

    const tool = this.tools.get(call.name)
    if (!tool) {
      const result = `Unknown tool: ${call.name}`
      this.emitToolEnd(active, call, false, result)
      return result
    }

    this.dispatch(active, {
      type: 'agent.tool.start',
      turnId: active.turnId,
      callId: call.id,
      name: call.name,
      args: call.arguments,
    })

    let ok = true
    let result: string
    try {
      result = String(await tool.run(call.arguments, this.toolContext(active)))
    } catch (error) {
      ok = false
      result = errorMessage(error)
    }

    // Client gets a bounded result; the trace keeps the whole thing, and a
    // skill gets its own line so skill execs are reconstructable on their own.
    this.emitToolEnd(active, call, ok, result)
    if (tool.kind === 'skill') {
      this.trace(active, {
        type: 'skill.exec',
        callId: call.id,
        name: call.name,
        args: call.arguments,
        result,
        ok,
      })
    }
    return result
  }

  private emitToolEnd(active: ActiveTurn, call: LlmToolCall, ok: boolean, result: string): void {
    this.emitToClient({
      type: 'agent.tool.end',
      turnId: active.turnId,
      callId: call.id,
      name: call.name,
      ok,
      result: truncate(result, this.clientResultCharLimit),
    })
    this.trace(active, {
      type: 'agent.tool.end',
      turnId: active.turnId,
      callId: call.id,
      name: call.name,
      ok,
      result,
    })
  }

  // Suspend: emit ask_user and park until respond() resolves or cancel() aborts.
  private askUser(active: ActiveTurn, call: LlmToolCall): Promise<string> {
    const args = call.arguments && typeof call.arguments === 'object'
      ? call.arguments as Record<string, unknown>
      : {}
    const question = typeof args.question === 'string' ? args.question : ''
    if (!question) {
      const result = 'ask_user requires a non-empty "question" string'
      this.emitToolEnd(active, call, false, result)
      return Promise.resolve(result)
    }
    const options = Array.isArray(args.options)
      ? args.options.filter((option): option is string => typeof option === 'string')
      : undefined

    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        if (active.pendingAsk && active.pendingAsk.callId === call.id) active.pendingAsk = null
        reject(abortError())
      }
      active.pendingAsk = { callId: call.id, resolve, reject, onAbort }
      active.controller.signal.addEventListener('abort', onAbort, { once: true })

      const event: AskUserEvent = {
        type: 'ask_user',
        turnId: active.turnId,
        callId: call.id,
        question,
        ...(options ? { options } : {}),
      }
      this.dispatch(active, event)
    })
  }

  private toolContext(active: ActiveTurn): ToolContext {
    return {
      sessionId: active.sessionId,
      turnId: active.turnId,
      signal: active.controller.signal,
      askUser: (question: string, options?: string[]) => this.askUser(active, {
        id: this.newId(),
        name: ASK_USER_NAME,
        arguments: options ? { question, options } : { question },
      }),
    }
  }

  private addUsage(active: ActiveTurn, usage: Usage): void {
    active.usage.inputTokens += usage.inputTokens || 0
    active.usage.outputTokens += usage.outputTokens || 0
    if (typeof usage.costUsd === 'number') {
      active.usage.costUsd = (active.usage.costUsd ?? 0) + usage.costUsd
    }
  }

  // Idempotent terminal transition: reports usage then the end reason exactly
  // once, and releases any cancel() waiter.
  private finish(active: ActiveTurn, reason: TurnEndReason): void {
    if (active.ended) return
    active.ended = true
    active.reason = reason
    if (this.active === active) this.active = null
    active.pendingAsk = null

    this.dispatch(active, { type: 'turn.usage', turnId: active.turnId, usage: { ...active.usage } })
    this.dispatch(active, { type: 'turn.end', turnId: active.turnId, reason })
    active.resolveDone()
  }

  private dispatch(active: ActiveTurn, event: TurnEvent): void {
    this.emitToClient(event)
    this.trace(active, event)
  }

  private emitToClient(event: TurnEvent): void {
    try {
      this.emit(event)
    } catch {
      // A misbehaving client sink must not take the loop down.
    }
  }

  private trace(active: ActiveTurn, record: { type: string; [key: string]: unknown }): void {
    if (!this.recorder) return
    this.recorder.record({
      ts: this.now(),
      turnId: active.turnId,
      sessionId: active.sessionId,
      ...record,
    })
  }
}
