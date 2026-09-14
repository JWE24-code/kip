import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TurnEvent, Usage } from '../protocol.ts'
import type { LlmStreamEvent, LlmStreamRequest, Tool } from '../session/loop.ts'
import { ASK_USER_NAME, TurnLoop } from '../session/loop.ts'
import { TraceRecorder } from '../traces/recorder.ts'

type Step = (request: LlmStreamRequest) => AsyncIterable<LlmStreamEvent>

class ScriptedLlm {
  steps: Step[]
  requests: LlmStreamRequest[]

  constructor(steps: Step[]) {
    this.steps = steps
    this.requests = []
  }

  async *stream(request: LlmStreamRequest): AsyncIterable<LlmStreamEvent> {
    this.requests.push(request)
    const step = this.steps.shift()
    if (!step) {
      yield { type: 'done' }
      return
    }
    yield* step(request)
  }
}

function idSequence(): () => string {
  let n = 0
  return () => `id-${++n}`
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for condition'))
      setTimeout(tick, 5)
    }
    tick()
  })
}

function hangUntilAborted(signal: AbortSignal, reject: (error: unknown) => void): Promise<never> {
  return new Promise<never>((_resolve, rejectPromise) => {
    if (signal.aborted) {
      rejectPromise(new Error('aborted'))
      return
    }
    signal.addEventListener('abort', () => rejectPromise(new Error('aborted')), { once: true })
    // Keep the outer `reject` reference meaningful for callers that inspect it.
    void reject
  })
}

function usage(inputTokens: number, outputTokens: number): Usage {
  return { inputTokens, outputTokens }
}

test('ask_user suspends the turn and chat.respond resumes it', async () => {
  const llm = new ScriptedLlm([
    async function* () {
      yield { type: 'text', text: 'Let me check. ' }
      yield {
        type: 'tool-call',
        call: { id: 'c1', name: ASK_USER_NAME, arguments: { question: 'Which one?', options: ['a', 'b'] } },
      }
      yield { type: 'usage', usage: usage(10, 4) }
    },
    async function* () {
      yield { type: 'text', text: 'Thanks.' }
      yield { type: 'usage', usage: usage(20, 3) }
    },
  ])

  const events: TurnEvent[] = []
  const loop = new TurnLoop({ llm, emit: (event) => events.push(event), newId: idSequence() })

  const resultPromise = loop.start('sess-1', 'hi')
  await waitFor(() => events.some((event) => event.type === 'ask_user'))

  const ask = events.find((event) => event.type === 'ask_user')
  assert.ok(ask && ask.type === 'ask_user')
  assert.equal(ask.question, 'Which one?')
  assert.deepEqual(ask.options, ['a', 'b'])

  loop.respond(ask.callId, 'b')
  const result = await resultPromise

  assert.equal(result.reason, 'completed')
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 7 })
  assert.deepEqual(
    events.map((event) => event.type),
    ['turn.start', 'turn.delta', 'ask_user', 'chat.respond', 'turn.delta', 'turn.usage', 'turn.end'],
  )
  assert.ok(!loop.isRunning(), 'turn released its slot')
})

test('chat.cancel mid-stream ends within 1s and still reports usage', async () => {
  const llm = new ScriptedLlm([
    async function* (request) {
      yield { type: 'text', text: 'partial answer' }
      yield { type: 'usage', usage: usage(7, 2) }
      await hangUntilAborted(request.signal, () => {})
    },
  ])

  const events: TurnEvent[] = []
  const loop = new TurnLoop({ llm, emit: (event) => events.push(event), newId: idSequence() })
  const resultPromise = loop.start('sess-1', 'hi')
  await waitFor(() => events.some((event) => event.type === 'turn.delta'))

  const turnId = events[0].turnId
  const started = Date.now()
  await loop.cancel(turnId)
  const elapsed = Date.now() - started

  assert.ok(elapsed < 1000, `cancel took ${elapsed}ms`)
  const result = await resultPromise
  assert.equal(result.reason, 'cancelled')
  assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 2 })

  const end = events.find((event) => event.type === 'turn.end')
  assert.ok(end && end.type === 'turn.end' && end.reason === 'cancelled')
  const reported = events.find((event) => event.type === 'turn.usage')
  assert.ok(reported && reported.type === 'turn.usage')
  assert.deepEqual(reported.usage, { inputTokens: 7, outputTokens: 2 })
  assert.ok(!loop.isRunning())
})

test('cancelling while an ask_user is pending is a clean turn end', async () => {
  const llm = new ScriptedLlm([
    async function* () {
      yield { type: 'tool-call', call: { id: 'c1', name: ASK_USER_NAME, arguments: { question: 'well?' } } }
    },
  ])

  const events: TurnEvent[] = []
  const loop = new TurnLoop({ llm, emit: (event) => events.push(event), newId: idSequence() })
  const resultPromise = loop.start('sess-1', 'hi')
  await waitFor(() => events.some((event) => event.type === 'ask_user'))

  await loop.cancel(events[0].turnId)
  const result = await resultPromise

  assert.equal(result.reason, 'cancelled')
  assert.equal(result.error, undefined)
  const end = events.at(-1)
  assert.ok(end && end.type === 'turn.end' && end.reason === 'cancelled')
  assert.ok(!loop.isRunning())
})

test('stray respond/cancel map to NO_PENDING_ASK and TURN_NOT_FOUND', async () => {
  const llm = new ScriptedLlm([
    async function* () {
      yield { type: 'tool-call', call: { id: 'c1', name: ASK_USER_NAME, arguments: { question: 'well?' } } }
    },
  ])
  const loop = new TurnLoop({ llm, emit: () => {}, newId: idSequence() })

  await assert.rejects(
    async () => loop.cancel('nope'),
    (error: { code?: string }) => error.code === 'TURN_NOT_FOUND',
  )
  assert.throws(
    () => loop.respond('whatever', 'x'),
    (error: { code?: string }) => error.code === 'TURN_NOT_FOUND',
  )

  const resultPromise = loop.start('sess-1', 'hi')
  await waitFor(() => loop.activeTurnId() !== null && loop.isRunning())
  await waitFor(() => {
    try {
      loop.respond('wrong-call', 'x')
    } catch (error) {
      return (error as { code?: string }).code === 'NO_PENDING_ASK'
    }
    return false
  })
  await assert.rejects(
    async () => loop.cancel('wrong-turn'),
    (error: { code?: string }) => error.code === 'TURN_NOT_FOUND',
  )

  const events: TurnEvent[] = []
  loop.emit = (event) => events.push(event)
  loop.respond('c1', 'done')
  const result = await resultPromise
  assert.equal(result.reason, 'completed')
})

test('a tool round-trips its result into the next completion', async () => {
  const seenToolResults: string[] = []
  const llm = new ScriptedLlm([
    async function* () {
      yield { type: 'tool-call', call: { id: 'c1', name: 'search_notes', arguments: { query: 'kip' } } }
    },
    async function* (request) {
      for (const message of request.messages) {
        if (message.role === 'tool') seenToolResults.push(message.content)
      }
      yield { type: 'text', text: 'found it' }
    },
  ])

  const tool: Tool = {
    spec: { name: 'search_notes', description: 'search', parameters: { type: 'object' } },
    kind: 'skill',
    run: () => 'RESULT-42',
  }

  const events: TurnEvent[] = []
  const loop = new TurnLoop({ llm, emit: (event) => events.push(event), tools: [tool], newId: idSequence() })
  const result = await loop.start('sess-1', 'find kip')

  assert.equal(result.reason, 'completed')
  assert.deepEqual(seenToolResults, ['RESULT-42'])
  assert.ok(events.some((event) => event.type === 'agent.tool.start' && event.name === 'search_notes'))
  assert.ok(events.some((event) => event.type === 'agent.tool.end' && event.result === 'RESULT-42'))
})

test('every event of a turn lands in the session trace, in order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kip-loop-trace-'))
  const recorder = new TraceRecorder({ sessionId: 'sess-1', dir, enabled: true })
  const llm = new ScriptedLlm([
    async function* () {
      yield { type: 'tool-call', call: { id: 'c1', name: ASK_USER_NAME, arguments: { question: 'which?' } } }
    },
    async function* () {
      yield { type: 'text', text: 'done' }
      yield { type: 'usage', usage: usage(5, 1) }
    },
  ])

  const events: TurnEvent[] = []
  const loop = new TurnLoop({
    llm,
    emit: (event) => events.push(event),
    recorder,
    newId: idSequence(),
  })
  const resultPromise = loop.start('sess-1', 'hi')
  await waitFor(() => events.some((event) => event.type === 'ask_user'))
  loop.respond('c1', 'because')
  await resultPromise

  const lines = readFileSync(join(dir, 'sess-1.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))

  assert.deepEqual(
    lines.map((line) => line.type),
    [
      'turn.start',
      'turn.prompt',
      'ask_user',
      'chat.respond',
      'turn.delta',
      'turn.usage',
      'turn.end',
    ],
  )
  assert.equal(lines[1].prompt, 'hi')
  assert.equal(lines[2].question, 'which?')
  assert.equal(lines[3].answer, 'because')
})
