// The sidecar's wire contract. Every frame is the same envelope
// ({ v, id, type, ts, payload }); `v` is the protocol version and `type` is
// one entry from the fixed catalog below. Keeping the envelope stable while
// the catalog grows is the whole point: a client that speaks v1 can recognise
// (and reject) a frame from a newer protocol instead of misreading it.
//
// Incoming payloads are the client's untrusted input, so each event type has a
// zod schema in payloadSchemas and validatePayload() is the only gate. The
// schemas are also the source of truth for the TypeScript payload types.

import { z } from 'zod'

export const PROTOCOL_VERSION = 1

export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  PROTOCOL_VERSION_MISMATCH: 'PROTOCOL_VERSION_MISMATCH',
  TURN_IN_PROGRESS: 'TURN_IN_PROGRESS',
  TURN_NOT_FOUND: 'TURN_NOT_FOUND',
  NO_PENDING_ASK: 'NO_PENDING_ASK',
  TOOL_ARGS_INVALID: 'TOOL_ARGS_INVALID',
  UNDO_UNAVAILABLE: 'UNDO_UNAVAILABLE',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  INTERNAL: 'INTERNAL'
} as const
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export const TurnEndReason = {
  COMPLETE: 'complete',
  CANCELLED: 'cancelled',
  ERROR: 'error',
  MAX_TOOLS: 'max_tools'
} as const
export type TurnEndReason = (typeof TurnEndReason)[keyof typeof TurnEndReason]

// Client → server. `hello` must be first; the rest are only accepted once the
// handshake has authenticated the socket.
export const CLIENT_EVENT_TYPES = [
  'hello',
  'chat.send',
  'chat.respond',
  'chat.cancel',
  'undo',
  'ping'
] as const

// Server → client.
export const SERVER_EVENT_TYPES = [
  'ready',
  'pong',
  'turn.start',
  'turn.delta',
  'agent.tool.start',
  'agent.tool.end',
  'ask_user',
  'turn.end',
  'turn.usage',
  'turn.error',
  'undo.applied',
  'error',
  'skill.progress'
] as const

export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number]
export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number]

const emptyPayload = z.object({}).optional()

const toolArgs = z.record(z.string(), z.unknown())

export const payloadSchemas = {
  hello: z.object({ token: z.string().min(1) }),
  ready: z.object({
    protocolVersion: z.number().int(),
    sessionId: z.string().min(1),
    pid: z.number().int()
  }),

  'chat.send': z.object({
    text: z.string().min(1),
    threadId: z.string().min(1).optional()
  }),
  'chat.respond': z.object({
    toolCallId: z.string().min(1),
    value: z.string()
  }),
  'chat.cancel': z.object({
    turnId: z.string().min(1).optional()
  }),
  undo: z.object({
    count: z.number().int().positive().max(100).optional()
  }),
  ping: emptyPayload,
  pong: z.object({ pingId: z.string().min(1).optional() }).optional(),

  'turn.start': z.object({
    turnId: z.string().min(1),
    startedAt: z.number().int().nonnegative()
  }),
  'turn.delta': z.object({
    turnId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    text: z.string()
  }),
  'agent.tool.start': z.object({
    turnId: z.string().min(1),
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    args: toolArgs
  }),
  'agent.tool.end': z.object({
    turnId: z.string().min(1),
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    ok: z.boolean(),
    result: z.string().optional(),
    error: z.string().optional(),
    truncated: z.boolean().optional()
  }),
  ask_user: z.object({
    turnId: z.string().min(1),
    toolCallId: z.string().min(1),
    question: z.string().min(1),
    options: z.array(z.string()).optional()
  }),
  'turn.end': z.object({
    turnId: z.string().min(1),
    reason: z.enum(['complete', 'cancelled', 'error', 'max_tools']),
    text: z.string().optional()
  }),
  'turn.usage': z.object({
    turnId: z.string().min(1),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative()
  }),
  'turn.error': z.object({
    turnId: z.string().min(1).optional(),
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean().optional()
  }),
  'undo.applied': z.object({
    revertedSha: z.string().min(1),
    restoredFiles: z.array(z.string()),
    undone: z.boolean()
  }),
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    id: z.string().min(1).optional()
  }),
  'skill.progress': z.object({
    turnId: z.string().min(1),
    skill: z.string().min(1),
    phase: z.string().min(1),
    message: z.string().optional(),
    pct: z.number().min(0).max(100).optional()
  })
} as const

export type EventPayloads = {
  [K in keyof typeof payloadSchemas]: z.infer<(typeof payloadSchemas)[K]>
}

export const envelopeSchema = z.object({
  v: z.number().int().positive(),
  id: z.string().min(1),
  type: z.string().min(1),
  ts: z.number().int().nonnegative(),
  payload: z.unknown().optional()
})

export type Envelope = z.infer<typeof envelopeSchema>

export type ValidationResult<T> =
  | { ok: true, data: T }
  | { ok: false, error: string }

function summarize (error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length ? `${issue.path.join('.')}: ` : ''
      return `${where}${issue.message}`
    })
    .join('; ')
}

/** Parses an untrusted frame off the socket. Does not check `v` against this
 *  build — the caller does that so it can answer with PROTOCOL_VERSION_MISMATCH
 *  before any payload is looked at. */
export function parseEnvelope (raw: unknown): ValidationResult<Envelope> {
  const result = envelopeSchema.safeParse(raw)
  if (!result.success) return { ok: false, error: summarize(result.error) }
  return { ok: true, data: result.data }
}

/** Validates one event's payload against the catalog. Unknown types fail: the
 *  catalog is fixed, not extensible by the client. */
export function validatePayload<T extends keyof typeof payloadSchemas> (
  type: T,
  payload: unknown
): ValidationResult<EventPayloads[T]> {
  const schema = payloadSchemas[type]
  if (!schema) return { ok: false, error: `unknown event type "${String(type)}"` }
  const result = schema.safeParse(payload)
  if (!result.success) return { ok: false, error: summarize(result.error) }
  return { ok: true, data: result.data as EventPayloads[T] }
}

export function isClientEvent (type: string): type is ClientEventType {
  return (CLIENT_EVENT_TYPES as readonly string[]).includes(type)
}

export function isServerEvent (type: string): type is ServerEventType {
  return (SERVER_EVENT_TYPES as readonly string[]).includes(type)
}

/** Builds one outgoing frame. `id` is the caller's correlation id; generated
 *  when omitted. */
export function makeEnvelope (
  type: ServerEventType,
  payload: unknown,
  id: string
): Envelope {
  return { v: PROTOCOL_VERSION, id, type, ts: Date.now(), payload }
}
