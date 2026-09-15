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

// ---- Answer enrichment (kip#98) --------------------------------------------
// The pre-sidecar `peckTurn()` returned a rich answer shape — cited/candidate
// slugs, dead citations, lint warnings, sources, and the statement/filed-fact
// card — but the model-driven loop reaches an answer through arbitrary tool
// calls, so there is no single `answerFromPages()` to read it from. Instead
// tools *account* for what they surfaced or wrote (TurnAccounting), the loop
// attaches that to `turn.end`, and the server's enricher (`server/
// turn-enrichment.ts`, which owns the vault) turns it into the TurnEnrichment
// kip-app's `turn->message` already maps.

/** One groom finding, exactly as `.roost/lint.json` stores it (kip-app#116). */
export interface LintWarning {
  slug: string
  kind: string
  note: string
}

/** A cited page plus the human-readable title peck's `sources` list carries. */
export interface SourceRef {
  slug: string
  title: string
}

/** A note a write tool created or updated; the "✓ Learned" card's pages. */
export interface LearnedPage {
  action: 'create' | 'update'
  slug: string
}

/** Raw per-turn facts a tool contributed (via `ToolOutput.enrichment`). The
 *  loop merges them and puts them on `turn.end`; on their own they are not
 *  enough to compute citations — the enricher still needs the final text and
 *  the vault. */
export interface TurnAccounting {
  /** Slugs surfaced by `search_notes`/`read_note` during the turn. */
  candidateSlugs: string[]
  /** Notes written by `write_agent_note`/`update_agent_note`. */
  writes: LearnedPage[]
}

/** The enrichment kip-app consumes on `turn.end`. */
export interface TurnEnrichment {
  candidateSlugs: string[]
  citedSlugs: string[]
  deadCitations: string[]
  lintWarnings: LintWarning[]
  sources: SourceRef[]
  /** Set when the turn filed a fact instead of answering. */
  intent?: 'statement'
  learned?: boolean
  /** The card text (the model's confirmation, or a synthesized line). */
  note?: string
  pages?: LearnedPage[]
}

/** What one tool can report about a turn beyond its result text. */
export interface ToolEnrichment {
  candidates?: string[]
  write?: LearnedPage
}

/** A tool's result: the text the model sees, plus optional accounting. */
export interface ToolOutput {
  text: string
  enrichment?: ToolEnrichment
}

export interface TurnEndEvent {
  type: 'turn.end'
  turnId: string
  reason: TurnEndReason
  /** The final answer text when the model answered (`completed`); absent for
   *  cancellations/errors, where the streamed deltas are the tail. */
  text?: string
  /** What the tools of this turn surfaced/wrote (kip#98). */
  accounting?: TurnAccounting
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
