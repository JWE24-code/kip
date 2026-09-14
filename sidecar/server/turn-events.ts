// Translates the turn loop's native event catalogue (protocol.ts `TurnEvent`)
// into the WebSocket wire payloads (server/protocol.ts). The two diverged while
// the loop was built: the loop carries structured `callId`s and a
// completed/budget reason vocabulary, the wire carries `toolCallId`s, a
// per-turn delta `seq`, a `toolCalls` count, and complete/max_tools. Keeping
// the mapping here — instead of scattering it through ws.ts — is what makes it
// testable and obvious which loop events never reach the client.

import { TurnEndReason as WireReason } from './protocol.ts'
import type { ServerEventType } from './protocol.ts'
import type { TurnEndReason, TurnEvent } from '../protocol.ts'
import type { TurnEnricher } from './turn-enrichment.ts'

export interface WireEvent {
  type: ServerEventType
  payload: Record<string, unknown>
}

const REASON: Record<TurnEndReason, string> = {
  completed: WireReason.COMPLETE,
  cancelled: WireReason.CANCELLED,
  error: WireReason.ERROR,
  budget: WireReason.MAX_TOOLS
}

/**
 * One translator per connection. It owns the per-turn delta sequence and the
 * tool-call count the wire schema expects, and drops the loop events that are
 * not part of the wire contract (`chat.respond` is the client's own echo;
 * `skill.exec` is trace-only).
 */
export class TurnEventTranslator {
  private readonly seq = new Map<string, number>()
  private readonly toolCalls = new Map<string, number>()
  private readonly text = new Map<string, string>()
  private readonly enrich?: TurnEnricher

  /** `enrich` is the vault-bound answer-enrichment builder (kip#98). Without it
   *  the wire still carries the raw text and vocabulary; tests use that. */
  constructor (enrich?: TurnEnricher) {
    this.enrich = enrich
  }

  translate (event: TurnEvent): WireEvent | null {
    switch (event.type) {
      case 'turn.start':
        return { type: 'turn.start', payload: { turnId: event.turnId, startedAt: Date.now() } }
      case 'turn.delta': {
        const seq = (this.seq.get(event.turnId) ?? 0) + 1
        this.seq.set(event.turnId, seq)
        // The stub used to put the whole answer on `turn.end`; accumulate the
        // streamed prose so a client that reads `turn.end.text` keeps working.
        this.text.set(event.turnId, (this.text.get(event.turnId) ?? '') + event.text)
        return { type: 'turn.delta', payload: { turnId: event.turnId, seq, text: event.text } }
      }
      case 'agent.tool.start': {
        this.toolCalls.set(event.turnId, (this.toolCalls.get(event.turnId) ?? 0) + 1)
        return {
          type: 'agent.tool.start',
          payload: { turnId: event.turnId, toolCallId: event.callId, name: event.name, args: event.args }
        }
      }
      case 'agent.tool.end':
        return {
          type: 'agent.tool.end',
          payload: {
            turnId: event.turnId,
            toolCallId: event.callId,
            name: event.name,
            ok: event.ok,
            result: event.result
          }
        }
      case 'ask_user':
        return {
          type: 'ask_user',
          payload: {
            turnId: event.turnId,
            toolCallId: event.callId,
            question: event.question,
            ...(event.options ? { options: event.options } : {})
          }
        }
      case 'turn.usage':
        return {
          type: 'turn.usage',
          payload: {
            turnId: event.turnId,
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            toolCalls: this.toolCalls.get(event.turnId) ?? 0
          }
        }
      case 'turn.end': {
        const wire = this.translateEnd(event)
        this.seq.delete(event.turnId)
        this.toolCalls.delete(event.turnId)
        this.text.delete(event.turnId)
        return wire
      }
      case 'turn.error':
        return {
          type: 'turn.error',
          payload: { turnId: event.turnId, code: event.code, message: event.message }
        }
      case 'skill.progress':
        return {
          type: 'skill.progress',
          payload: {
            turnId: event.turnId,
            skill: event.skill,
            phase: event.phase,
            ...(event.message !== undefined ? { message: event.message } : {}),
            ...(event.pct !== undefined ? { pct: event.pct } : {})
          }
        }
      case 'chat.respond':
      case 'skill.exec':
        return null
    }
  }

  private translateEnd (event: Extract<TurnEvent, { type: 'turn.end' }>): WireEvent {
    // A completed turn's authoritative answer is the loop's own final text; for
    // a cancellation/error the streamed deltas are the tail we have. Preferring
    // the loop's text also covers a provider that answered without streaming.
    const streamed = this.text.get(event.turnId) ?? ''
    const text = event.reason === 'completed' ? event.text ?? streamed : streamed
    const payload: Record<string, unknown> = {
      turnId: event.turnId,
      reason: REASON[event.reason] ?? WireReason.ERROR,
      ...(text ? { text } : {})
    }
    if (this.enrich) {
      // The enrichment is what lets kip-app show sources, the evidence row,
      // lint warnings and the "✓ Learned" card (kip#98).
      Object.assign(payload, this.enrich({ text, ...(event.accounting ? { accounting: event.accounting } : {}) }))
    }
    return { type: 'turn.end', payload }
  }
}
