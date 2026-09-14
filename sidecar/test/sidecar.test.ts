import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'

import { connect } from '../client.ts'
import { createNoteTools, SEARCH_NOTES_TOOL_NAME } from '../session/notes.ts'
import { createWriteTools, WRITE_AGENT_NOTE_TOOL_NAME } from '../session/notes-write.ts'
import { startSidecarServer, generateToken } from '../server/ws.ts'
import { discoveryPath } from '../discovery.ts'
import { PROTOCOL_VERSION } from '../server/protocol.ts'
import { commitAction, workspacePaths } from '../workspace/git.ts'
import type { CompleteFn, CompleteRequest, CompleteResult } from '../session/llm-client.ts'
import type { Tool } from '../session/loop.ts'

const require = createRequire(import.meta.url)
const { rebuildRoost } = require('../../scripts/rebuild-roost.js') as {
  rebuildRoost: (vaultRoot: string) => { indexed: number }
}

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

test('a bare client completes hello/ready and a full tool-using turn over the socket', async () => {
  const token = generateToken()
  const tool: Tool = {
    spec: {
      name: 'echo',
      description: 'Echo a query back.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    },
    run: (args) => `echo: ${(args as { query: string }).query}`
  }
  const server = await startSidecarServer({
    token,
    tools: [tool],
    complete: scriptedCompleter([
      { text: '<use_tool name="echo">{ "query": "coop" }</use_tool>' },
      { text: 'The coop is the vault.', chunks: ['The coop ', 'is the vault.'] }
    ])
  })
  const client = await connect({ url: `ws://127.0.0.1:${server.port}`, token })
  try {
    assert.ok(client.sessionId.length > 0)

    client.send('chat.send', { text: 'what is the coop?' })
    const end = await client.next('turn.end')
    const endPayload = end.payload as { reason: string }

    assert.equal(endPayload.reason, 'complete')

    const deltas = client.events
      .filter((event) => event.type === 'turn.delta')
      .map((event) => (event.payload as { text: string }).text)
      .join('')
    assert.equal(deltas, 'The coop is the vault.')

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

test('a fresh client reads cancel from the ready capabilities and can gate on it', async () => {
  const token = generateToken()
  const server = await startSidecarServer({ token, complete: scriptedCompleter([{ text: 'x' }]) })
  const client = await connect({ url: `ws://127.0.0.1:${server.port}`, token })
  try {
    const ready = client.events.find((event) => event.type === 'ready')
    const advertised = (ready?.payload as { capabilities?: string[] }).capabilities ?? []
    assert.ok(advertised.includes('cancel'), `ready advertised ${JSON.stringify(advertised)}`)
    assert.deepEqual(client.capabilities, advertised)

    const cancelSupported = client.capabilities.includes('cancel')
    assert.equal(cancelSupported, true)
    assert.equal(client.capabilities.includes('teleport'), false)
  } finally {
    client.close()
    await server.close()
  }
})

test('ping is answered with pong and a stray cancel is TURN_NOT_FOUND', async () => {
  const token = generateToken()
  const server = await startSidecarServer({ token, complete: scriptedCompleter([{ text: 'x' }]) })
  const client = await connect({ url: `ws://127.0.0.1:${server.port}`, token })
  try {
    const pingId = client.send('ping')
    const pong = await client.next('pong')
    assert.equal((pong.payload as { pingId?: string }).pingId, pingId)

    client.send('chat.cancel', {})
    const error = await client.next('error')
    assert.equal((error.payload as { code: string }).code, 'TURN_NOT_FOUND')

    client.send('chat.respond', { toolCallId: 'nope', value: 'x' })
    const respondError = await client.next('error', (envelope) =>
      (envelope.payload as { code?: string }).code === 'TURN_NOT_FOUND')
    assert.equal((respondError.payload as { code: string }).code, 'TURN_NOT_FOUND')
  } finally {
    client.close()
    await server.close()
  }
})

test('undo reverts the last agent commit and reports it over the socket', async () => {
  const base = TMP()
  const vaultRoot = path.join(base, 'coop')
  const originalWorkspaceRoot = process.env.KIP_WORKSPACE_ROOT
  process.env.KIP_WORKSPACE_ROOT = path.join(base, 'workspace')
  const { dir } = workspacePaths(vaultRoot)
  fs.mkdirSync(path.join(dir, 'concepts'), { recursive: true })

  fs.writeFileSync(path.join(dir, 'concepts', 'note.md'), 'v1\n')
  await commitAction({ vaultRoot, message: 'write note' })
  fs.writeFileSync(path.join(dir, 'concepts', 'note.md'), 'v2 — changed\n')
  await commitAction({ vaultRoot, message: 'edit note' })

  const token = generateToken()
  const server = await startSidecarServer({
    token,
    complete: scriptedCompleter([{ text: 'x' }]),
    vaultRoot
  })
  const client = await connect({ url: `ws://127.0.0.1:${server.port}`, token })
  try {
    client.send('undo', { count: 1 })
    const applied = await client.next('undo.applied')
    const payload = applied.payload as { revertedSha: string, restoredFiles: string[], undone: boolean }

    assert.equal(payload.undone, true)
    assert.deepEqual(payload.restoredFiles, ['concepts/note.md'])
    assert.equal(fs.readFileSync(path.join(dir, 'concepts', 'note.md'), 'utf8'), 'v1\n')
    assert.match(payload.revertedSha, /^[0-9a-f]{40}$/)
  } finally {
    client.close()
    await server.close()
    process.env.KIP_WORKSPACE_ROOT = originalWorkspaceRoot
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('undo before any agent write is UNDO_UNAVAILABLE', async () => {
  const base = TMP()
  const originalWorkspaceRoot = process.env.KIP_WORKSPACE_ROOT
  process.env.KIP_WORKSPACE_ROOT = path.join(base, 'workspace')
  const token = generateToken()
  const server = await startSidecarServer({
    token,
    complete: scriptedCompleter([{ text: 'x' }]),
    vaultRoot: path.join(base, 'coop')
  })
  const client = await connect({ url: `ws://127.0.0.1:${server.port}`, token })
  try {
    client.send('undo', { count: 1 })
    const error = await client.next('error')
    assert.equal((error.payload as { code: string }).code, 'UNDO_UNAVAILABLE')
  } finally {
    client.close()
    await server.close()
    process.env.KIP_WORKSPACE_ROOT = originalWorkspaceRoot
    fs.rmSync(base, { recursive: true, force: true })
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

// ---- the real TurnLoop, reached end to end (kip#94) ------------------------

function makeIndexedVault (): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-sidecar-loop-'))
  for (const dir of ['nest/concepts', 'nest/entities', 'pages', 'journals', '.roost', '.henhouse']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  const page = [
    '---',
    'type: concept',
    'summary: How the user keeps their sleep on track',
    'created: 2026-01-01',
    'updated: 2026-01-01',
    'tags: []',
    '---',
    '',
    'Consistent bedtime; no screens after 22:00.',
    ''
  ].join('\n')
  fs.writeFileSync(path.join(root, 'nest', 'concepts', 'sleep-hygiene.md'), page)
  rebuildRoost(root)
  return root
}

test('chat.send reaches the real TurnLoop: search_notes runs and turn.delta streams back', async () => {
  const vault = makeIndexedVault()
  const token = generateToken()
  const server = await startSidecarServer({
    token,
    vaultRoot: vault,
    tools: createNoteTools({ vaultRoot: vault }),
    complete: scriptedCompleter([
      { text: `<use_tool name="${SEARCH_NOTES_TOOL_NAME}">{ "query": "sleep" }</use_tool>` },
      { text: 'Your notes say: consistent bedtime.', chunks: ['Your notes say: ', 'consistent bedtime.'] }
    ])
  })
  const client = await connect({ url: `ws://127.0.0.1:${server.port}`, token })
  try {
    client.send('chat.send', { text: 'what do my notes say about sleep?' })
    const end = await client.next('turn.end')
    const endPayload = end.payload as { reason: string, text?: string }
    assert.equal(endPayload.reason, 'complete')
    assert.equal(endPayload.text, 'Your notes say: consistent bedtime.')

    const toolEnd = client.events.find((event) => event.type === 'agent.tool.end')
    assert.ok(toolEnd, 'the client observed the real tool call')
    const toolPayload = toolEnd?.payload as { name: string, ok: boolean, result: string }
    assert.equal(toolPayload.name, SEARCH_NOTES_TOOL_NAME)
    assert.equal(toolPayload.ok, true)
    assert.match(toolPayload.result, /aw:sleep-hygiene/)

    const deltas = client.events
      .filter((event) => event.type === 'turn.delta')
      .map((event) => (event.payload as { text: string }).text)
      .join('')
    assert.equal(deltas, 'Your notes say: consistent bedtime.')
  } finally {
    client.close()
    await server.close()
    fs.rmSync(vault, { recursive: true, force: true })
  }
})

test('turn.end carries the enrichment a real search_notes turn produced (kip#98)', async () => {
  const vault = makeIndexedVault()
  fs.writeFileSync(path.join(vault, '.roost', 'lint.json'), JSON.stringify({
    generated: '2026-01-01T00:00:00.000Z',
    deep: false,
    findings: { 'sleep-hygiene': [{ kind: 'orphan', note: 'nothing links to this page' }] }
  }))
  const token = generateToken()
  const server = await startSidecarServer({
    token,
    vaultRoot: vault,
    tools: createNoteTools({ vaultRoot: vault }),
    complete: scriptedCompleter([
      { text: `<use_tool name="${SEARCH_NOTES_TOOL_NAME}">{ "query": "sleep" }</use_tool>` },
      { text: 'Consistent bedtime; see [[sleep-hygiene]] and [[ghost-note]].', chunks: ['Consistent bedtime; see ', '[[sleep-hygiene]] and [[ghost-note]].'] }
    ])
  })
  const client = await connect({ url: `ws://127.0.0.1:${server.port}`, token })
  try {
    client.send('chat.send', { text: 'what do my notes say about sleep?' })
    const end = await client.next('turn.end')
    const payload = end.payload as {
      reason: string
      candidateSlugs?: string[]
      citedSlugs?: string[]
      deadCitations?: string[]
      lintWarnings?: Array<{ slug: string, kind: string, note: string }>
      sources?: Array<{ slug: string, title: string }>
    }

    assert.equal(payload.reason, 'complete')
    assert.deepEqual(payload.candidateSlugs, ['sleep-hygiene'])
    assert.deepEqual(payload.citedSlugs, ['sleep-hygiene'])
    assert.deepEqual(payload.deadCitations, ['ghost-note'])
    assert.deepEqual(payload.lintWarnings, [
      { slug: 'sleep-hygiene', kind: 'orphan', note: 'nothing links to this page' }
    ])
    assert.deepEqual(payload.sources, [{ slug: 'sleep-hygiene', title: 'sleep hygiene' }])
  } finally {
    client.close()
    await server.close()
    fs.rmSync(vault, { recursive: true, force: true })
  }
})

test('turn.end reports a filed fact as a learned statement, not an empty answer (kip#98)', async () => {
  const vault = makeIndexedVault()
  const base = TMP()
  const originalWorkspaceRoot = process.env.KIP_WORKSPACE_ROOT
  process.env.KIP_WORKSPACE_ROOT = path.join(base, 'workspace')
  const token = generateToken()
  const server = await startSidecarServer({
    token,
    vaultRoot: vault,
    tools: createWriteTools({ vaultRoot: vault }),
    complete: scriptedCompleter([
      { text: `<use_tool name="${WRITE_AGENT_NOTE_TOOL_NAME}">{ "title": "Acme moved", "body": "Acme moved to Berlin." }</use_tool>` },
      { text: 'Saved "Acme moved".', chunks: ['Saved "Acme moved".'] }
    ])
  })
  const client = await connect({ url: `ws://127.0.0.1:${server.port}`, token })
  try {
    client.send('chat.send', { text: 'Acme moved to Berlin.' })
    const end = await client.next('turn.end')
    const payload = end.payload as {
      reason: string
      intent?: string
      learned?: boolean
      note?: string
      pages?: Array<{ action: string, slug: string }>
    }

    assert.equal(payload.reason, 'complete')
    assert.equal(payload.intent, 'statement')
    assert.equal(payload.learned, true)
    assert.equal(payload.note, 'Saved "Acme moved".')
    assert.deepEqual(payload.pages, [{ action: 'create', slug: 'acme-moved' }])
  } finally {
    client.close()
    await server.close()
    process.env.KIP_WORKSPACE_ROOT = originalWorkspaceRoot
    fs.rmSync(base, { recursive: true, force: true })
    fs.rmSync(vault, { recursive: true, force: true })
  }
})

test('chat.respond resumes the loop\'s real ask_user over the socket', async () => {
  const token = generateToken()
  const server = await startSidecarServer({
    token,
    complete: scriptedCompleter([
      { text: '<use_tool name="ask_user">{ "question": "Which one?", "options": ["a", "b"] }</use_tool>' },
      { text: 'Got it: b.' }
    ])
  })
  const client = await connect({ url: `ws://127.0.0.1:${server.port}`, token })
  try {
    client.send('chat.send', { text: 'pick one' })
    const ask = await client.next('ask_user')
    const askPayload = ask.payload as { toolCallId: string, question: string, options?: string[] }
    assert.equal(askPayload.question, 'Which one?')
    assert.deepEqual(askPayload.options, ['a', 'b'])

    client.send('chat.respond', { toolCallId: askPayload.toolCallId, value: 'b' })
    const end = await client.next('turn.end')
    assert.equal((end.payload as { reason: string }).reason, 'complete')
  } finally {
    client.close()
    await server.close()
  }
})

test('chat.cancel aborts a real in-flight turn within 1s', async () => {
  const token = generateToken()
  const hanging: CompleteFn = (request) => new Promise((_resolve, reject) => {
    request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
  const server = await startSidecarServer({ token, complete: hanging })
  const client = await connect({ url: `ws://127.0.0.1:${server.port}`, token })
  try {
    client.send('chat.send', { text: 'a long question' })
    await client.next('turn.start')

    const started = Date.now()
    client.send('chat.cancel', {})
    const end = await client.next('turn.end')
    const elapsed = Date.now() - started

    assert.equal((end.payload as { reason: string }).reason, 'cancelled')
    assert.ok(elapsed < 1000, `cancel took ${elapsed}ms`)
  } finally {
    client.close()
    await server.close()
  }
})

test('chat.send folds client-sent history so a follow-up resolves (kip#97)', async () => {
  const token = generateToken()
  const prompts: string[] = []
  const complete: CompleteFn = async (request) => {
    prompts.push(request.prompt)
    // The answer depends on the replayed history: with it, "that" resolves.
    const hasContext = request.prompt.includes('what is the coop?')
    const text = hasContext ? 'It is the vault you open.' : 'I have no earlier context.'
    request.onDelta?.(text)
    return { text, usage: { input: 1, output: 1 } }
  }
  const server = await startSidecarServer({ token, complete })
  const client = await connect({ url: `ws://127.0.0.1:${server.port}`, token })
  try {
    client.send('chat.send', {
      text: 'expand on that',
      history: [
        { role: 'user', text: 'what is the coop?' },
        { role: 'assistant', text: 'The coop is the folder you open.' }
      ]
    })
    const end = await client.next('turn.end')
    const payload = end.payload as { reason: string, text?: string }

    assert.equal(payload.reason, 'complete')
    assert.equal(payload.text, 'It is the vault you open.')
    assert.match(prompts[0], /User: what is the coop\?/)
    assert.match(prompts[0], /Assistant: The coop is the folder you open\./)
    assert.match(prompts[0], /User: expand on that/)
  } finally {
    client.close()
    await server.close()
  }
})

test('depth: quick offers only the nest tools; full offers the skills too', async () => {
  const noteTool: Tool = {
    spec: { name: 'note_tool', description: 'a nest tool', parameters: { type: 'object' } },
    run: () => 'note'
  }
  const skillTool: Tool = {
    kind: 'skill',
    spec: { name: 'skill_tool', description: 'a skill', parameters: { type: 'object' } },
    run: () => 'skill'
  }

  async function systemPromptFor (depth: 'quick' | 'full'): Promise<string> {
    const token = generateToken()
    let system = ''
    const complete: CompleteFn = async (request) => {
      system = request.system
      return { text: 'ok', usage: { input: 1, output: 1 } }
    }
    const server = await startSidecarServer({ token, complete, tools: [noteTool, skillTool] })
    const client = await connect({ url: `ws://127.0.0.1:${server.port}`, token })
    try {
      client.send('chat.send', { text: 'a question', depth })
      await client.next('turn.end')
    } finally {
      client.close()
      await server.close()
    }
    return system
  }

  const quick = await systemPromptFor('quick')
  const full = await systemPromptFor('full')

  assert.match(quick, /note_tool/)
  assert.doesNotMatch(quick, /skill_tool/)
  assert.match(full, /note_tool/)
  assert.match(full, /skill_tool/)
})

test('skill.progress streams to the client for a real skill tool call', async () => {
  const token = generateToken()
  const skillTool: Tool = {
    kind: 'skill',
    spec: { name: 'demo-skill', description: 'A demo skill.', parameters: { type: 'object', properties: {} } },
    run: (_args, ctx) => {
      ctx.progress({ phase: 'working', message: 'halfway there', pct: 50 })
      return 'skill finished'
    }
  }
  const server = await startSidecarServer({
    token,
    tools: [skillTool],
    complete: scriptedCompleter([
      { text: '<use_tool name="demo-skill">{}</use_tool>' },
      { text: 'All done.' }
    ])
  })
  const client = await connect({ url: `ws://127.0.0.1:${server.port}`, token })
  try {
    client.send('chat.send', { text: 'run the demo skill' })
    await client.next('turn.end')

    const progress = client.events
      .filter((event) => event.type === 'skill.progress')
      .map((event) => event.payload as { skill: string, phase: string, pct?: number })
    assert.ok(progress.length >= 3, `expected start/working/done, saw ${progress.length}`)
    assert.deepEqual(progress.map((p) => p.phase), ['start', 'working', 'done'])
    assert.equal(progress[0].skill, 'demo-skill')
    assert.equal(progress[1].pct, 50)
  } finally {
    client.close()
    await server.close()
  }
})
