import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CLIENT_EVENT_TYPES,
  ErrorCode,
  PROTOCOL_VERSION,
  SERVER_EVENT_TYPES,
  makeEnvelope,
  parseEnvelope,
  payloadSchemas,
  validatePayload
} from '../server/protocol.ts'
import { parseToolCalls, safeReleaseLength } from '../session/turn.ts'

test('every catalogued event has a payload schema', () => {
  const types = [...CLIENT_EVENT_TYPES, ...SERVER_EVENT_TYPES]
  for (const type of types) {
    assert.ok(payloadSchemas[type as keyof typeof payloadSchemas], `missing schema for ${type}`)
  }
})

test('an envelope round-trips through parseEnvelope', () => {
  const envelope = makeEnvelope('pong', { pingId: 'p1' }, 'm1')
  assert.equal(envelope.v, PROTOCOL_VERSION)
  assert.equal(envelope.type, 'pong')
  const parsed = parseEnvelope(envelope)
  assert.equal(parsed.ok, true)
  if (parsed.ok) assert.equal(parsed.data.id, 'm1')
})

test('a frame missing required envelope fields is rejected', () => {
  const result = parseEnvelope({ id: 'x', type: 'ping' })
  assert.equal(result.ok, false)
})

test('a non-numeric protocol version is rejected as malformed', () => {
  const result = parseEnvelope({ v: 'one', id: 'x', type: 'ping', ts: 1 })
  assert.equal(result.ok, false)
})

test('hello payload requires a non-empty token', () => {
  assert.equal(validatePayload('hello', { token: 'abc' }).ok, true)
  assert.equal(validatePayload('hello', { token: '' }).ok, false)
  assert.equal(validatePayload('hello', {}).ok, false)
})

test('chat.send requires text and drops nothing the loop needs', () => {
  const good = validatePayload('chat.send', { text: 'hello' })
  assert.equal(good.ok, true)
  assert.equal(validatePayload('chat.send', { text: '' }).ok, false)
})

test('unknown event types fail validation', () => {
  const result = validatePayload('not.real' as 'ping', {})
  assert.equal(result.ok, false)
})

test('the error code catalog is fixed and non-empty', () => {
  assert.equal(ErrorCode.UNAUTHORIZED, 'UNAUTHORIZED')
  assert.equal(ErrorCode.PROTOCOL_VERSION_MISMATCH, 'PROTOCOL_VERSION_MISMATCH')
})

test('parseToolCalls reads one or more tool tags', () => {
  const text = 'Sure.\n<use_tool name="stub_echo">{ "query": "a" }</use_tool>\n' +
    '<use_tool name="stub_echo">{ "query": "b" }</use_tool>'
  const calls = parseToolCalls(text)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].args, { query: 'a' })
  assert.equal(calls[1].name, 'stub_echo')
})

test('parseToolCalls keeps a broken tag as a call with jsonError', () => {
  const calls = parseToolCalls('<use_tool name="stub_echo">{ query: nope }</use_tool>')
  assert.equal(calls.length, 1)
  assert.ok(calls[0].jsonError)
})

test('parseToolCalls returns nothing for plain prose', () => {
  assert.deepEqual(parseToolCalls('The answer is 42.'), [])
})

test('safeReleaseLength holds back anything that could open a tool tag', () => {
  assert.equal(safeReleaseLength(''), 0)
  assert.equal(safeReleaseLength('<'), 0)
  assert.equal(safeReleaseLength('<use'), 0)
  assert.equal(safeReleaseLength('<use_tool name="stub_echo">{'), 0)
  assert.equal(safeReleaseLength('Hello'), 5)
  assert.equal(safeReleaseLength('  Hello'), 7)
})
