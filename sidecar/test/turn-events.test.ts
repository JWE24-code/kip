// The loop→wire translation (kip#94): the loop's event vocabulary and the
// WebSocket payload schema are different shapes ("completed" vs "complete",
// callId vs toolCallId, an explicit per-turn seq and toolCalls count), and this
// is the only place they meet.

import test from 'node:test'
import assert from 'node:assert/strict'

import { TurnEventTranslator } from '../server/turn-events.ts'

test('turn.end maps the loop vocabulary onto the wire vocabulary', () => {
  const translator = new TurnEventTranslator()
  const cases = [
    ['completed', 'complete'],
    ['cancelled', 'cancelled'],
    ['error', 'error'],
    ['budget', 'max_tools']
  ] as const
  for (const [loop, wire] of cases) {
    const out = translator.translate({ type: 'turn.end', turnId: `t-${loop}`, reason: loop })
    assert.equal(out?.type, 'turn.end')
    assert.equal((out?.payload as { reason: string }).reason, wire)
  }
})

test('turn.delta is sequenced per turn and turn.end carries the accumulated text', () => {
  const translator = new TurnEventTranslator()
  const first = translator.translate({ type: 'turn.delta', turnId: 'x', text: 'foo ' })
  const second = translator.translate({ type: 'turn.delta', turnId: 'x', text: 'bar' })
  assert.equal((first?.payload as { seq: number }).seq, 1)
  assert.equal((second?.payload as { seq: number }).seq, 2)

  const end = translator.translate({ type: 'turn.end', turnId: 'x', reason: 'completed' })
  assert.equal((end?.payload as { text: string }).text, 'foo bar')

  const next = translator.translate({ type: 'turn.delta', turnId: 'x', text: 'again' })
  assert.equal((next?.payload as { seq: number }).seq, 1, 'sequence resets with the turn')
})

test('ask_user and agent.tool.* are renamed to toolCallId, and usage counts tools', () => {
  const translator = new TurnEventTranslator()
  const ask = translator.translate({ type: 'ask_user', turnId: 'x', callId: 'c1', question: 'q', options: ['a'] })
  assert.equal((ask?.payload as { toolCallId: string }).toolCallId, 'c1')

  translator.translate({ type: 'agent.tool.start', turnId: 'x', callId: 'c1', name: 'search_notes', args: { query: 'q' } })
  const usage = translator.translate({ type: 'turn.usage', turnId: 'x', usage: { inputTokens: 1, outputTokens: 2 } })
  assert.equal((usage?.payload as { toolCalls: number }).toolCalls, 1)
})

test('the client echo and the trace-only skill.exec never reach the wire', () => {
  const translator = new TurnEventTranslator()
  assert.equal(translator.translate({ type: 'chat.respond', turnId: 'x', callId: 'c1', answer: 'a' }), null)
  assert.equal(
    translator.translate({ type: 'skill.exec', turnId: 'x', callId: 'c1', name: 's', args: {}, result: 'r', ok: true }),
    null
  )
})

test('skill.progress keeps its optional fields only when present', () => {
  const translator = new TurnEventTranslator()
  const bare = translator.translate({ type: 'skill.progress', turnId: 'x', skill: 's', phase: 'start' })
  assert.deepEqual(bare?.payload, { turnId: 'x', skill: 's', phase: 'start' })
  const full = translator.translate({ type: 'skill.progress', turnId: 'x', skill: 's', phase: 'working', message: 'half', pct: 50 })
  assert.deepEqual(full?.payload, { turnId: 'x', skill: 's', phase: 'working', message: 'half', pct: 50 })
})

test('turn.end runs the enricher over the answer text and the turn accounting (kip#98)', () => {
  const seen: Array<{ text: string, accounting?: unknown }> = []
  const translator = new TurnEventTranslator((input) => {
    seen.push(input)
    return {
      candidateSlugs: ['a'],
      citedSlugs: ['a'],
      deadCitations: [],
      lintWarnings: [],
      sources: [{ slug: 'a', title: 'a' }]
    }
  })

  const end = translator.translate({
    type: 'turn.end',
    turnId: 'x',
    reason: 'completed',
    text: 'See [[a]].',
    accounting: { candidateSlugs: ['a'], writes: [] }
  })

  assert.deepEqual(seen, [{ text: 'See [[a]].', accounting: { candidateSlugs: ['a'], writes: [] } }])
  const payload = end?.payload as { citedSlugs?: string[], sources?: unknown[] }
  assert.deepEqual(payload.citedSlugs, ['a'])
  assert.deepEqual(payload.sources, [{ slug: 'a', title: 'a' }])
})
