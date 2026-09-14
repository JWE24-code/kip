import test from 'node:test'
import assert from 'node:assert/strict'

import { runTurn, type CompleteFn, type CompleteRequest, type CompleteResult, type EmitFn } from '../session/turn.ts'

interface Step {
  text?: string
  chunks?: string[]
  usage?: { input: number, output: number }
}

function scriptedCompleter (steps: Step[]): { complete: CompleteFn, calls: CompleteRequest[] } {
  const calls: CompleteRequest[] = []
  let index = 0
  const complete: CompleteFn = async (request) => {
    calls.push(request)
    const step = steps[Math.min(index, steps.length - 1)]
    index += 1
    for (const chunk of step.chunks ?? []) request.onDelta?.(chunk)
    const result: CompleteResult = {
      text: step.text ?? '',
      usage: step.usage ?? { input: 1, output: 1 }
    }
    return result
  }
  return { complete, calls }
}

interface Recorded {
  type: string
  payload: Record<string, unknown>
}

function recorder (): { events: Recorded[], emit: EmitFn } {
  const events: Recorded[] = []
  return { events, emit: (type, payload) => events.push({ type, payload }) }
}

const TOOL_CALL = '<use_tool name="stub_echo">{ "query": "coop" }</use_tool>'

test('the stub tool round-trips and its result influences the next completion', async () => {
  const { complete, calls } = scriptedCompleter([
    { text: TOOL_CALL },
    { text: 'The coop is the vault.' }
  ])
  const { events, emit } = recorder()

  const result = await runTurn({
    turnId: 't1',
    text: 'what is the coop?',
    emit,
    complete,
    deltaBatchMs: 5
  })

  assert.equal(result.reason, 'complete')
  assert.equal(result.text, 'The coop is the vault.')
  assert.equal(result.toolCalls, 1)
  assert.equal(events[0].type, 'turn.start')
  assert.equal(events.at(-1)?.type, 'turn.end')

  const toolEnd = events.find((event) => event.type === 'agent.tool.end')
  assert.equal(toolEnd?.payload.result, 'stub_echo: coop')
  assert.match(calls[1].prompt, /stub_echo: coop/)
})

test('malformed tool args get exactly one retry, then a clean failure', async () => {
  const { complete, calls } = scriptedCompleter([
    { text: '<use_tool name="stub_echo">{ not json }</use_tool>' },
    { text: '<use_tool name="stub_echo">{ "query": 123 }</use_tool>' }
  ])
  const { events, emit } = recorder()

  const result = await runTurn({ turnId: 't2', text: 'x', emit, complete })

  assert.equal(calls.length, 2, 'one original call plus one retry')
  assert.match(calls[1].prompt, /invalid/)
  assert.equal(result.reason, 'error')
  assert.equal(result.toolCalls, 0)

  const errors = events.filter((event) => event.type === 'turn.error')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].payload.code, 'TOOL_ARGS_INVALID')
  assert.equal(events.filter((event) => event.type === 'agent.tool.start').length, 0)
})

test('the tool-call budget is 15 and ends the turn with max_tools', async () => {
  const steps: Step[] = Array.from({ length: 40 }, () => ({ text: TOOL_CALL }))
  const { complete } = scriptedCompleter(steps)
  const { events, emit } = recorder()

  const result = await runTurn({ turnId: 't3', text: 'x', emit, complete })

  assert.equal(result.reason, 'max_tools')
  assert.equal(result.toolCalls, 15)
  assert.equal(events.filter((event) => event.type === 'agent.tool.start').length, 15)
  assert.equal(events.filter((event) => event.type === 'agent.tool.end').length, 15)
})

test('tool results are truncated to maxResultChars before they reach the client', async () => {
  const long = 'y'.repeat(600)
  const { complete } = scriptedCompleter([
    { text: `<use_tool name="stub_echo">{ "query": "${long}" }</use_tool>` },
    { text: 'done' }
  ])
  const { events, emit } = recorder()

  await runTurn({ turnId: 't4', text: 'x', emit, complete, maxResultChars: 500 })

  const toolEnd = events.find((event) => event.type === 'agent.tool.end')
  assert.equal(toolEnd?.payload.truncated, true)
  assert.equal((toolEnd?.payload.result as string).length, 500)
})

test('streamed deltas are batched and a tool-call turn streams nothing', async () => {
  const prose = scriptedCompleter([
    { chunks: ['The ', 'coop ', 'is ', 'the ', 'vault.'], text: 'The coop is the vault.' }
  ])
  const proseRecorder = recorder()
  await runTurn({
    turnId: 't5',
    text: 'x',
    emit: proseRecorder.emit,
    complete: prose.complete,
    deltaBatchMs: 50
  })
  const deltas = proseRecorder.events.filter((event) => event.type === 'turn.delta')
  assert.equal(deltas.length, 1, 'five pushes coalesce into one batch')
  assert.equal(deltas[0].payload.text, 'The coop is the vault.')

  const tool = scriptedCompleter([
    { chunks: ['<use_tool name="stub_echo">', '{ "query": "a" }', '</use_tool>'], text: TOOL_CALL },
    { text: 'answer' }
  ])
  const toolRecorder = recorder()
  await runTurn({ turnId: 't6', text: 'x', emit: toolRecorder.emit, complete: tool.complete })
  assert.equal(toolRecorder.events.filter((event) => event.type === 'turn.delta').length, 0)
})

test('usage accumulates across every completion in the turn', async () => {
  const { complete } = scriptedCompleter([
    { text: TOOL_CALL, usage: { input: 10, output: 5 } },
    { text: 'answer', usage: { input: 3, output: 7 } }
  ])
  const { events, emit } = recorder()

  const result = await runTurn({ turnId: 't7', text: 'x', emit, complete })

  assert.deepEqual(result.usage, { input: 13, output: 12 })
  const usage = events.find((event) => event.type === 'turn.usage')
  assert.equal(usage?.payload.inputTokens, 13)
  assert.equal(usage?.payload.outputTokens, 12)
  assert.equal(usage?.payload.toolCalls, 1)
})

test('a failing completer becomes a clean turn.error/turn.end, not a throw', async () => {
  const complete: CompleteFn = async () => {
    throw new Error('no provider configured')
  }
  const { events, emit } = recorder()

  const result = await runTurn({ turnId: 't8', text: 'x', emit, complete })

  assert.equal(result.reason, 'error')
  const error = events.find((event) => event.type === 'turn.error')
  assert.equal(error?.payload.code, 'INTERNAL')
  assert.equal(events.at(-1)?.type, 'turn.end')
})
