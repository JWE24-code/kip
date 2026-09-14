// Acceptance tests for the capability-limited skill executor (P6, kip#77).
//
// The four SPEC-1 Acceptance D criteria are the spine of this file:
//   1. a `network:none` skill genuinely cannot reach the network
//   2. a skill mount cannot escape to a live vault path
//   3. no secrets appear in a skill process's environment
//   4. aborting a long-running skill kills the process and leaves no artifact
// plus the resource limits (wall/mem/output) that replace skills.js's
// timeout-and-output-cap-only runner.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import {
  createSkillExecutor,
  createRunMounts,
  formatSkillResult,
  readSkillManifest,
  resolveMountPath,
  skillParametersSchema,
  type SkillManifest
} from '../henhouse/index.ts'

const executor = createSkillExecutor()

function makeCoop (): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'henhouse-exec-'))
  for (const dir of ['pages', 'nest', 'exports', '.henhouse/skills']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  fs.writeFileSync(path.join(root, 'nest', 'secret.md'), 'LIVE VAULT SECRET\n')
  return root
}

interface SkillOptions {
  frontmatter?: Record<string, unknown>
  run: string
  body?: string
}

function writeSkill (root: string, name: string, options: SkillOptions): SkillManifest {
  const dir = path.join(root, '.henhouse', 'skills', name)
  fs.mkdirSync(dir, { recursive: true })
  const fm = Object.assign({ name, description: `test skill ${name}`, entry: 'run.js' }, options.frontmatter)
  const yaml = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${yaml}\n---\n${options.body ?? ''}\n`)
  fs.writeFileSync(path.join(dir, 'run.js'), options.run)
  const manifest = readSkillManifest(dir, 'builtin')
  assert.ok(manifest, `manifest for ${name} should parse`)
  return manifest
}

function listen (handler: http.RequestListener): Promise<{ url: string, hits: () => number, close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    hits += 1
    handler(req, res)
  })
  let hits = 0
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        url: `http://127.0.0.1:${port}/`,
        hits: () => hits,
        close: () => new Promise((done) => server.close(() => done()))
      })
    })
  })
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ---- happy path ------------------------------------------------------------

test('runs a skill with the input snapshot and commits its artifacts', async (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const manifest = writeSkill(root, 'worker', {
    run: `
const fs = require('node:fs')
const out = { input: JSON.parse(process.env.SKILL_INPUT) }
out.note = fs.readFileSync(process.env.KIP_INPUT_DIR + '/note.md', 'utf8').trim()
fs.writeFileSync(process.env.KIP_EXPORTS_DIR + '/out.txt', 'artifact')
process.stdout.write(JSON.stringify(out))
`
  })

  const result = await executor.run({
    manifest,
    vaultRoot: root,
    input: { a: 1 },
    snapshot: { 'note.md': 'snapshot body\n' }
  })

  assert.equal(result.ok, true, result.error ?? '')
  assert.equal(result.backend, 'node-inproc')
  assert.deepEqual(JSON.parse(result.output).input, { a: 1 })
  assert.equal(JSON.parse(result.output).note, 'snapshot body')
  assert.deepEqual(result.artifacts, [path.join(root, 'exports', 'out.txt')])
  assert.equal(fs.readFileSync(path.join(root, 'exports', 'out.txt'), 'utf8'), 'artifact')
})

test('a non-zero exit is a clean error with the stderr message', async (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const manifest = writeSkill(root, 'broken', { run: 'console.error("boom"); process.exit(3)' })

  const result = await executor.run({ manifest, vaultRoot: root })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'error')
  assert.match(result.error ?? '', /boom/)
  assert.equal(result.exitCode, 3)
})

test('oversized skill input is refused before anything is spawned', async (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const manifest = writeSkill(root, 'input-cap', { run: 'process.exit(0)' })

  const result = await executor.run({ manifest, vaultRoot: root, input: { blob: 'x'.repeat(64 * 1024) } })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'error')
  assert.match(result.error ?? '', /too large/)
})

// ---- acceptance 1: network:none --------------------------------------------

test('acceptance: a network:none skill cannot reach the network', async (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const server = await listen((_req, res) => res.end('SHOULD NOT BE HIT'))
  t.after(() => server.close())

  const manifest = writeSkill(root, 'eager', {
    frontmatter: { network: 'none' },
    run: `
fetch(process.env.TEST_URL).then(
  () => process.stdout.write('FETCH_OK'),
  (err) => process.stdout.write('FETCH_DENIED:' + ((err.cause && err.cause.code) || err.code || 'error'))
)
`
  })

  const result = await executor.run({ manifest, vaultRoot: root, env: { TEST_URL: server.url } })
  assert.equal(result.ok, true, result.error ?? '')
  assert.match(result.output, /FETCH_DENIED/)
  assert.ok(!result.output.includes('FETCH_OK'))
  assert.equal(server.hits(), 0, 'no request should ever reach the server')
})

test('acceptance: a declared fetch_url hostcall honours the network allowlist', async (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const server = await listen((_req, res) => res.end('PONG'))
  t.after(() => server.close())

  const manifest = writeSkill(root, 'fetchy', {
    frontmatter: { network: ['127.0.0.1'], hostcalls: ['fetch_url'] },
    run: `
globalThis.kip.hostcall('fetch_url', { url: process.env.TEST_URL }).then(
  (value) => process.stdout.write('HOSTCALL_OK:' + value.body),
  (err) => process.stdout.write('HOSTCALL_ERR:' + err.message)
)
`
  })

  const result = await executor.run({ manifest, vaultRoot: root, env: { TEST_URL: server.url } })
  assert.equal(result.ok, true, result.error ?? '')
  assert.equal(result.output, 'HOSTCALL_OK:PONG')
  assert.equal(server.hits(), 1)
})

test('hostcalls: network:none denies fetch_url, and an undeclared hostcall is refused', async (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const server = await listen((_req, res) => res.end('NOPE'))
  t.after(() => server.close())

  const denied = writeSkill(root, 'no-net', {
    frontmatter: { hostcalls: ['fetch_url'] },
    run: `
globalThis.kip.hostcall('fetch_url', { url: process.env.TEST_URL }).then(
  (value) => process.stdout.write('OK:' + value.body),
  (err) => process.stdout.write('ERR:' + err.code + ':' + err.message)
)
`
  })
  let result = await executor.run({ manifest: denied, vaultRoot: root, env: { TEST_URL: server.url } })
  assert.match(result.output, /ERR:NETWORK_DENIED/)
  assert.equal(server.hits(), 0)

  const undeclared = writeSkill(root, 'undeclared', {
    run: `
globalThis.kip.hostcall('fetch_url', { url: process.env.TEST_URL }).then(
  (value) => process.stdout.write('OK:' + value.body),
  (err) => process.stdout.write('ERR:' + err.code)
)
`
  })
  result = await executor.run({ manifest: undeclared, vaultRoot: root, env: { TEST_URL: server.url } })
  assert.match(result.output, /ERR:HOSTCALL_DENIED/)
})

test('hostcalls: llm.complete runs in the parent and the key never enters the child', async (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const manifest = writeSkill(root, 'thinker', {
    frontmatter: { hostcalls: ['llm.complete'] },
    run: `
globalThis.kip.hostcall('llm.complete', { prompt: 'ping' }).then(
  (value) => process.stdout.write('LLM:' + value.text),
  (err) => process.stdout.write('LLM_ERR:' + err.message)
)
`
  })
  process.env.KIP_TEST_PROVIDER_KEY = 'sk-live-must-not-leak'
  t.after(() => { delete process.env.KIP_TEST_PROVIDER_KEY })

  const result = await executor.run({
    manifest,
    vaultRoot: root,
    llm: async ({ prompt }) => ({ text: `answer:${prompt}` })
  })
  assert.equal(result.output, 'LLM:answer:ping')
})

// ---- acceptance 2: mounts --------------------------------------------------

test('acceptance: a skill mount cannot escape to a live vault path', async (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const manifest = writeSkill(root, 'nosy', {
    run: `
const fs = require('node:fs')
const out = {}
try { out.vault = fs.readFileSync(process.env.KIP_VAULT + '/nest/secret.md', 'utf8') } catch (err) { out.vault = err.code }
try { out.escape = fs.readFileSync('../secret.md', 'utf8') } catch (err) { out.escape = err.code }
out.input = fs.readFileSync(process.env.KIP_INPUT_DIR + '/note.md', 'utf8').trim()
process.stdout.write(JSON.stringify(out))
`
  })

  const result = await executor.run({
    manifest,
    vaultRoot: root,
    snapshot: { 'note.md': 'allowed' },
    env: { KIP_VAULT: root }
  })
  const parsed = JSON.parse(result.output)
  assert.equal(parsed.vault, 'ERR_ACCESS_DENIED', 'the live vault must not be readable')
  assert.equal(parsed.escape, 'ERR_ACCESS_DENIED', 'a relative escape must not be readable')
  assert.equal(parsed.input, 'allowed', 'the snapshot stays readable')
})

test('resolveMountPath refuses a traversal before any filesystem access', () => {
  const mounts = createRunMounts(path.join(os.tmpdir(), 'henhouse-resolve'))
  assert.throws(() => resolveMountPath(mounts, 'input', '../../etc/passwd'), /escapes the "input" mount/)
})

// ---- acceptance 3: secrets -------------------------------------------------

test('acceptance: no secrets appear in a skill process environment', async (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  // A parent env var and a skills.json secret — neither may cross the boundary.
  process.env.KIP_TEST_PROVIDER_KEY = 'sk-live-secret'
  t.after(() => { delete process.env.KIP_TEST_PROVIDER_KEY })
  fs.writeFileSync(
    path.join(root, '.henhouse', 'skills.json'),
    JSON.stringify({ secrets: { leaky: { API_TOKEN: 'skills-json-secret' } } })
  )

  const manifest = writeSkill(root, 'leaky', {
    run: 'process.stdout.write(JSON.stringify(process.env))'
  })

  const result = await executor.run({ manifest, vaultRoot: root, env: { EXPLICIT_OK: '1' } })
  const env = JSON.parse(result.output) as Record<string, string>
  const serialized = JSON.stringify(env)

  assert.equal(env.EXPLICIT_OK, '1', 'explicitly-passed non-secret env is honoured')
  assert.ok(!serialized.includes('sk-live-secret'), 'parent env must not be inherited')
  assert.ok(!serialized.includes('skills-json-secret'), 'skills.json secrets must not be read')
  assert.ok(!Object.hasOwn(env, 'KIP_TEST_PROVIDER_KEY'))
  for (const key of Object.keys(env)) {
    assert.ok(
      ['PATH', 'NODE_NO_WARNINGS', 'SKILL_INPUT', 'SKILL_DIR', 'EXPLICIT_OK'].includes(key) || key.startsWith('KIP_'),
      `unexpected env key leaked into the skill: ${key}`
    )
  }
})

// ---- acceptance 4: abort / limits ------------------------------------------

test('acceptance: abort kills a hung skill and removes its partial artifact', async (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const manifest = writeSkill(root, 'hang-abort', {
    run: `
const fs = require('node:fs')
fs.writeFileSync(process.env.KIP_EXPORTS_DIR + '/partial.txt', 'half-written')
setInterval(() => {}, 1000)
`
  })

  const pending = executor.run({ manifest, vaultRoot: root, runId: 'abort-me' })

  const partial = path.join(root, 'exports', 'partial.txt')
  for (let i = 0; i < 200 && !fs.existsSync(partial); i += 1) await sleep(10)
  assert.ok(fs.existsSync(partial), 'the skill should have written its partial artifact')

  assert.equal(executor.abort('abort-me'), true)
  const result = await pending

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'aborted')
  assert.equal(result.aborted, true)
  assert.equal(result.signal, 'SIGKILL', 'the process is actually killed')
  assert.ok(!fs.existsSync(partial), 'abort leaves no partial artifact')
})

test('a wall-clock limit terminates a hung skill', async (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const manifest = writeSkill(root, 'hang-timeout', {
    frontmatter: { limits: { wall: '300ms' } },
    run: 'setInterval(() => {}, 1000)'
  })

  const result = await executor.run({ manifest, vaultRoot: root })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'timeout')
  assert.equal(result.timedOut, true)
})

test('a memory limit terminates an allocating skill', async (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const manifest = writeSkill(root, 'greedy', {
    frontmatter: { limits: { mem: 64, wall: '10s' } },
    run: 'const hoard = []; for (;;) { hoard.push(new Array(20000).fill("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")) }'
  })

  const result = await executor.run({ manifest, vaultRoot: root })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'mem-limit', `expected mem-limit, got ${result.reason} (${result.error})`)
})

test('an output limit caps captured stdout', async (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const manifest = writeSkill(root, 'chatty', {
    frontmatter: { limits: { output: 256 } },
    run: 'process.stdout.write("x".repeat(5000))'
  })

  const result = await executor.run({ manifest, vaultRoot: root })
  assert.equal(result.ok, true)
  assert.ok(result.output.length <= 256, `output was ${result.output.length}`)
  assert.equal(result.truncated, true)
})

// ---- loop bridge -----------------------------------------------------------

test('createSkillTool/schema: manifest parameters become a JSON schema', () => {
  const schema = skillParametersSchema([
    { name: 'query', type: 'string', required: true, description: 'q' },
    { name: 'count', type: 'number', required: false, description: 'n' }
  ])
  assert.deepEqual(schema.required, ['query'])
  assert.deepEqual((schema.properties as Record<string, { type: string }>).count.type, 'number')
})

test('formatSkillResult: reports output, artifacts, and errors', () => {
  const base = {
    skill: 'x', runId: 'r', backend: 'node-inproc' as const, ok: true, reason: 'ok' as const,
    output: 'done', error: null, ms: 1, timedOut: false, aborted: false,
    truncated: false, exitCode: 0, signal: null, artifacts: []
  }
  assert.equal(formatSkillResult({ ...base }), 'done')
  assert.match(formatSkillResult({ ...base, artifacts: ['/coop/exports/a.txt'] }), /Files written/)
  assert.match(
    formatSkillResult({ ...base, ok: false, reason: 'error', error: 'boom' }),
    /Error: boom/
  )
})
