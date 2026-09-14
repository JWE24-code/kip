// The turn-loop protocol surface shared by the loop, the trace recorder, and
// (from #68 on) the WebSocket envelope. Types only where possible so this file
// runs under Node's native type stripping with no build step.

export const PROTOCOL_VERSION = 1

// Why a turn stopped. `cancelled` is the only reason a client can force; the
// rest are derived by the loop.
export type TurnEndReason = 'completed' | 'cancelled' | 'error' | 'budget'

export interface Usage {
  inputTokens: number
  outputTokens: number
  costUsd?: number
}

export interface LlmToolCall {
  id: string
  name: string
  arguments: unknown
}

export interface ToolSpec {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

// Rejectable protocol failures. These are the codes a client sees for a
// misplaced `chat.respond`/`chat.cancel`, plus the in-loop budget guard.
export const ERROR_CODES = {
  TURN_NOT_FOUND: 'TURN_NOT_FOUND',
  NO_PENDING_ASK: 'NO_PENDING_ASK',
  TURN_ALREADY_RUNNING: 'TURN_ALREADY_RUNNING',
  BAD_TOOL_ARGS: 'BAD_TOOL_ARGS',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  ABORTED: 'ABORTED',
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

export class ProtocolError extends Error {
  code: ErrorCode

  constructor(code: ErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'ProtocolError'
    this.code = code
  }
}

// ---- The event catalog a turn emits, in lifecycle order ----
// turn.start → turn.delta* → (agent.tool.start / agent.tool.end)* →
// (ask_user → chat.respond)? → turn.usage → turn.end | turn.error.
// `skill.exec` is trace-only: it carries the untruncated result of a skill-kind
// tool and never crosses to the client.

export interface TurnStartEvent {
  type: 'turn.start'
  turnId: string
  sessionId: string
}

export interface TurnDeltaEvent {
  type: 'turn.delta'
  turnId: string
  text: string
}

export interface AgentToolStartEvent {
  type: 'agent.tool.start'
  turnId: string
  callId: string
  name: string
  args: unknown
}

export interface AgentToolEndEvent {
  type: 'agent.tool.end'
  turnId: string
  callId: string
  name: string
  ok: boolean
  result: string
}

export interface AskUserEvent {
  type: 'ask_user'
  turnId: string
  callId: string
  question: string
  options?: string[]
}

export interface ChatRespondEvent {
  type: 'chat.respond'
  turnId: string
  callId: string
  answer: string
}

export interface TurnUsageEvent {
  type: 'turn.usage'
  turnId: string
  usage: Usage
}

export interface TurnEndEvent {
  type: 'turn.end'
  turnId: string
  reason: TurnEndReason
}

export interface TurnErrorEvent {
  type: 'turn.error'
  turnId: string
  code: string
  message: string
}

export interface SkillExecEvent {
  type: 'skill.exec'
  turnId: string
  callId: string
  name: string
  args: unknown
  result: string
  ok: boolean
}

// A long-running skill's coarse progress. `skill.exec` is trace-only; this is
// the event that reaches the client so the UI can show a live phase while a
// skill runs (kip#94).
export interface SkillProgressEvent {
  type: 'skill.progress'
  turnId: string
  skill: string
  phase: string
  message?: string
  pct?: number
}

export type TurnEvent =
  | TurnStartEvent
  | TurnDeltaEvent
  | AgentToolStartEvent
  | AgentToolEndEvent
  | AskUserEvent
  | ChatRespondEvent
  | TurnUsageEvent
  | TurnEndEvent
  | TurnErrorEvent
  | SkillExecEvent
  | SkillProgressEvent

export interface TurnError {
  code: string
  message: string
}

export interface TurnResult {
  turnId: string
  reason: TurnEndReason
  usage: Usage
  error?: TurnError
}
