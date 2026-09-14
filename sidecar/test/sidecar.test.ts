import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

import { connect } from '../client.ts'
import { startSidecarServer, generateToken } from '../server/ws.ts'
import { discoveryPath } from '../discovery.ts'
import { PROTOCOL_VERSION } from '../server/protocol.ts'
import type { CompleteFn, CompleteRequest, CompleteResult } from '../session/turn.ts'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const INDEX = path.join(REPO_ROOT, 'sidecar', 'index.ts')

interface Step {
  text: string
  chunks?: string[]
}

function scriptedCompleter (steps: Step[]): CompleteFn {
  let index = 0
  return async (request: CompleteRequest): Promise<CompleteResult> => {
    const step = steps[Math.min(index, steps.length - 1)]
    index += 1
    for (const chunk of step.chunks ?? []) request.onDelta?.(chunk)
    return { text: step.text, usage: { input: 1, output: 1 } }
  }
}

function TMP (): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kip-sidecar-'))
}

async function waitForFile (file: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (fs.existsSync(file)) return
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${file}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function waitForExit (child: ChildProcess, timeoutMs = 8000): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not exit')), timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

test('a bare client completes hello/ready and a full turn over the socket', async () => {
  const token = generateToken()
  const server = await startSidecarServer({
    token,
    complete: scriptedCompleter([
      { text: '<use_tool name="stub_echo">{ "query": "coop" }</use_tool>' },
      { text: 'The coop is the vault.', chunks: ['The coop ', 'is the vault.'] }
    ])
  })
  const client = await connect({ url: `ws://127.0.0.1:${server.port}`, token })
  try {
    assert.ok(client.sessionId.length > 0)

    client.send('chat.send', { text: 'what is the coop?' })
    const end = await client.next('turn.end')
    const endPayload = end.payload as { reason: string, text?: string }

    assert.equal(endPayload.reason, 'complete')
    assert.equal(endPayload.text, 'The coop is the vault.')

    const types = client.events.map((event) => event.type)
    const order = (type: string): number => types.indexOf(type)
    assert.ok(order('turn.start') < order('agent.tool.start'))
    assert.ok(order('agent.tool.start') < order('agent.tool.end'))
    assert.ok(order('agent.tool.end') < order('turn.delta'))
    assert.ok(order('turn.delta') < order('turn.end'))
  } finally {
    client.close()
    await server.close()
  }
})

test('a wrong token is rejected with UNAUTHORIZED', async () => {
  const server = await startSidecarServer({ token: 'the-right-token', complete: scriptedCompleter([{ text: 'x' }]) })
  try {
    await assert.rejects(
      connect({ url: `ws://127.0.0.1:${server.port}`, token: 'the-wrong-token' }),
      /UNAUTHORIZED/
    )
  } finally {
    await server.close()
  }
})

test('a wrong protocol version is rejected with PROTOCOL_VERSION_MISMATCH', async () => {
  const server = await startSidecarServer({ token: 't', complete: scriptedCompleter([{ text: 'x' }]) })
  try {
    await assert.rejects(
      connect({ url: `ws://127.0.0.1:${server.port}`, token: 't', protocolVersion: 999 }),
      /PROTOCOL_VERSION_MISMATCH/
    )
  } finally {
    await server.close()
  }
})

test('ping is answered with pong and unimplemented events come back as errors', async () => {
  const token = generateToken()
  const server = await startSidecarServer({ token, complete: scriptedCompleter([{ text: 'x' }]) })
  const client = await connect({ url: `ws://127.0.0.1:${server.port}`, token })
  try {
    const pingId = client.send('ping')
    const pong = await client.next('pong')
    assert.equal((pong.payload as { pingId?: string }).pingId, pingId)

    client.send('chat.cancel', {})
    const error = await client.next('error')
    assert.equal((error.payload as { code: string }).code, 'NOT_IMPLEMENTED')
  } finally {
    client.close()
    await server.close()
  }
})

test('the entry point publishes discovery and exits cleanly on SIGTERM', async () => {
  const vault = TMP()
  const child = spawn(
    process.execPath,
    [INDEX, '--port', '0', '--vault-root', vault, '--silence-ms', '60000'],
    { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  child.stderr.on('data', () => {})
  try {
    const file = discoveryPath(vault)
    await waitForFile(file)
    const info = JSON.parse(fs.readFileSync(file, 'utf8'))

    assert.equal(info.protocolVersion, PROTOCOL_VERSION)
    assert.equal(info.pid, child.pid)
    assert.equal(info.vaultRoot, vault)
    assert.ok(info.port > 0)

    const client = await connect({ url: info.url, token: info.token })
    assert.ok(client.sessionId.length > 0)
    client.close()

    child.kill('SIGTERM')
    assert.equal(await waitForExit(child), 0)
    assert.equal(fs.existsSync(file), false, 'discovery file is removed on shutdown')
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    fs.rmSync(vault, { recursive: true, force: true })
  }
})

test('the entry point exits on socket silence', async () => {
  const vault = TMP()
  const child = spawn(
    process.execPath,
    [INDEX, '--port', '0', '--vault-root', vault, '--silence-ms', '500'],
    { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  child.stderr.on('data', () => {})
  try {
    const file = discoveryPath(vault)
    await waitForFile(file)
    assert.equal(await waitForExit(child), 0)
    assert.equal(fs.existsSync(file), false, 'discovery file is removed on shutdown')
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    fs.rmSync(vault, { recursive: true, force: true })
  }
})
