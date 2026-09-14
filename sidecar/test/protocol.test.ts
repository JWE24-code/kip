import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ERROR_CODES, PROTOCOL_VERSION, ProtocolError } from '../protocol.ts'

test('protocol version is pinned', () => {
  assert.equal(PROTOCOL_VERSION, 1)
})

test('ProtocolError carries a stable code', () => {
  const error = new ProtocolError(ERROR_CODES.NO_PENDING_ASK)
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'ProtocolError')
  assert.equal(error.code, 'NO_PENDING_ASK')
  assert.equal(error.message, 'NO_PENDING_ASK')

  const custom = new ProtocolError(ERROR_CODES.TURN_NOT_FOUND, 'no such turn')
  assert.equal(custom.message, 'no such turn')
})
