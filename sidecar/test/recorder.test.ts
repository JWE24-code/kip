import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TraceRecorder, sanitizeSessionId, tracesDir, tracesEnabled } from '../traces/recorder.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'kip-trace-'))
}

function readLines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

test('writes one JSONL line per event, in order', () => {
  const dir = tempDir()
  const recorder = new TraceRecorder({ sessionId: 'sess-1', dir, enabled: true })

  recorder.record({ type: 'turn.start', ts: 1, turnId: 't1' })
  recorder.record({ type: 'turn.prompt', ts: 2, turnId: 't1', prompt: 'hello' })
  recorder.record({ type: 'turn.end', ts: 3, turnId: 't1', reason: 'completed' })

  const lines = readLines(join(dir, 'sess-1.jsonl'))
  assert.deepEqual(lines.map((line) => line.type), ['turn.start', 'turn.prompt', 'turn.end'])
  assert.equal(lines[1].prompt, 'hello')
  assert.equal(lines[2].reason, 'completed')
})

test('a disabled recorder is a true no-op', () => {
  const dir = tempDir()
  const recorder = new TraceRecorder({ sessionId: 'sess-1', dir, enabled: false })
  recorder.record({ type: 'turn.start' })
  assert.throws(() => readFileSync(join(dir, 'sess-1.jsonl')))
})

test('tracesEnabled prefers KIP_TRACES then falls back to not-production', () => {
  assert.equal(tracesEnabled({ KIP_TRACES: '1', NODE_ENV: 'production' }), true)
  assert.equal(tracesEnabled({ KIP_TRACES: 'true' }), true)
  assert.equal(tracesEnabled({ KIP_TRACES: '0', NODE_ENV: 'development' }), false)
  assert.equal(tracesEnabled({ KIP_TRACES: 'false' }), false)
  assert.equal(tracesEnabled({ NODE_ENV: 'production' }), false)
  assert.equal(tracesEnabled({ NODE_ENV: 'development' }), true)
  assert.equal(tracesEnabled({}), true)
})

test('session ids are confined to a single path segment', () => {
  assert.equal(sanitizeSessionId('abc-123'), 'abc-123')
  const traversal = sanitizeSessionId('../../etc/passwd')
  assert.ok(!traversal.includes('/'), traversal)
  assert.ok(!traversal.includes('\\'), traversal)
  assert.equal(sanitizeSessionId('///'), 'session')
  assert.equal(sanitizeSessionId(''), 'session')
})

test('the default trace dir sits in the workspace, never the coop', () => {
  const previousWorkspace = process.env.KIP_WORKSPACE_ROOT
  const previousCoop = process.env.KIP_COOP_ROOT
  const workspace = tempDir()
  process.env.KIP_WORKSPACE_ROOT = workspace
  process.env.KIP_COOP_ROOT = '/some/synced/coop'
  try {
    const dir = tracesDir()
    assert.ok(dir.startsWith(workspace), `expected ${dir} under ${workspace}`)
    assert.equal(dir, join(dir), 'is absolute')
    assert.ok(dir.endsWith('traces'))
    assert.ok(!dir.startsWith('/some/synced/coop'))
  } finally {
    if (previousWorkspace === undefined) delete process.env.KIP_WORKSPACE_ROOT
    else process.env.KIP_WORKSPACE_ROOT = previousWorkspace
    if (previousCoop === undefined) delete process.env.KIP_COOP_ROOT
    else process.env.KIP_COOP_ROOT = previousCoop
  }
})
