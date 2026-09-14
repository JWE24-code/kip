// Acceptance tests for the P5 enrichment pipeline (#75). Every behavior here
// is Hatch's, re-used through the sidecar: the one-call propose+draft, the
// synthesized per-document trace hub, `source::`/`source_hatched::` provenance,
// and the content-hash gate. On top of that, P5 owns two contracts:
//   - the template output is a golden file that still parses as valid Logseq
//     markdown (SPEC-1 Acceptance C), and
//   - an enrichment run is exactly one commit, while an unchanged re-run
//     touches nothing (no LLM call, no commit, no byte change).

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LlmMessage, LlmStreamEvent, LlmStreamRequest, Tool } from '../session/loop.ts'
import { TurnLoop } from '../session/loop.ts'
import {
  ENRICH_SOURCE_TOOL_NAME,
  createEnrichTools,
  enrichSource,
  enrichSourceSchema
} from '../session/enrichment.ts'
import { history, workspacePaths } from '../workspace/git.ts'

const require = createRequire(import.meta.url)
const { saveLLMConfig } = require('../../scripts/lib/llm.js') as {
  saveLLMConfig: (config: unknown, vaultRoot: string) => void
}
const { rebuildRoost } = require('../../scripts/rebuild-roost.js') as {
  rebuildRoost: (vaultRoot: string) => unknown
}
const matter = require('gray-matter') as {
  (raw: string): { data: Record<string, unknown>, content: string }
}

const FIXTURE = join(import.meta.dirname, 'fixtures', 'enrichment', 'source-page.md')
const SOURCE_TEXT = 'Saw Dr. Alvarez on 2026-08-20 about sleep. Resting heart rate is trending down.'

function makeTempVault (): string {
  const root = mkdtempSync(join(tmpdir(), 'coop-enrich-test-'))
  for (const dir of ['nest/entities', 'nest/concepts', 'nest/sources', 'nest/people', 'pages', 'journals', '.roost', '.henhouse']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  return root
}

/** Point the shared lib/llm.js at a local OpenAI-compatible provider + build
 *  the FTS index, so the ported propose/draft path runs with no API key. */
function useLocalProvider (root: string): void {
  rebuildRoost(root)
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)
}

function modelResponse (pages: unknown[]): string {
  return JSON.stringify({ pages })
}

/** Stub global.fetch (the local provider's transport) and record the bodies. */
function stubLLM (content: string | ((body: Record<string, unknown>, call: number) => string)): {
  calls: Array<Record<string, unknown>>
  restore: () => void
} {
  const calls: Array<Record<string, unknown>> = []
  const original = global.fetch
  global.fetch = (async (_url: unknown, init: { body?: string }) => {
    const body = JSON.parse(String(init && init.body)) as Record<string, unknown>
    calls.push(body)
    const out = typeof content === 'function' ? content(body, calls.length) : content
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: out }, finish_reason: 'stop' }] })
    }
  }) as unknown as typeof fetch
  return { calls, restore: () => { global.fetch = original } }
}

function readNest (root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

async function commitCount (root: string): Promise<number> {
  return (await history(workspacePaths(root))).length
}

test('enrichment writes a golden source page and commits exactly once', async (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  useLocalProvider(root)

  // The model proposes a person page but no `source` page — the trace hub is
  // synthesized by the shared Hatch logic, which is what makes the golden
  // deterministic.
  const llm = stubLLM(modelResponse([
    { title: 'Dr. Alvarez', type: 'person', tags: ['doctor'], summary: 'A physician the user sees.', body: 'Met at the clinic. See [[clinic-visit]].' }
  ]))

  let result: Awaited<ReturnType<typeof enrichSource>>
  try {
    result = await enrichSource({ text: SOURCE_TEXT, title: 'Clinic Visit' }, { vaultRoot: root })
  } finally {
    llm.restore()
  }

  assert.equal(result.status, 'enriched')
  assert.equal(result.source, 'paste/clinic-visit.md')
  assert.deepEqual([...result.created].sort(), ['clinic-visit', 'dr-alvarez'])
  assert.equal(result.commit, (await history(workspacePaths(root)))[0].sha, 'the report names the commit')
  assert.equal(await commitCount(root), 1, 'exactly one commit for the whole run')

  const page = readNest(root, 'nest/sources/clinic-visit.md')
  const canonical = page
    .replaceAll(result.hash.slice(0, 12), '{{HASH12}}')
    .replace(/\d{4}-\d{2}-\d{2}/g, '{{DATE}}')
  assert.equal(canonical, readFileSync(FIXTURE, 'utf8'), 'the template output matches the golden file')

  // and it still parses as valid Logseq markdown (SPEC-1 Acceptance C)
  const parsed = matter(page)
  assert.equal(parsed.data.type, 'source')
  assert.equal(parsed.data.source, 'paste/clinic-visit.md')
  assert.match(String(parsed.data.source_hatched), /^\d{4}-\d{2}-\d{2}$/)
  assert.match(parsed.content, /^## Source$/m, 'the trace hub names the source file')

  // provenance frontmatter lands on every page the run touched (FR-14/FR-21)
  const person = matter(readNest(root, 'nest/people/dr-alvarez.md'))
  assert.equal(person.data.source, 'paste/clinic-visit.md')
  assert.match(String(person.data.source_hatched), /^\d{4}-\d{2}-\d{2}$/)
})

test('a re-run over an unchanged source touches nothing (content-hash gate)', async (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  useLocalProvider(root)

  const text = 'A stable source document about the Alpha project.'
  const first = stubLLM(modelResponse([
    { title: 'Alpha Project', type: 'concept', tags: [], summary: 'Alpha', body: 'Alpha is a project.' }
  ]))
  try {
    await enrichSource({ text, title: 'Alpha Project' }, { vaultRoot: root })
  } finally {
    first.restore()
  }
  const before = readNest(root, 'nest/concepts/alpha-project.md')
  assert.equal(await commitCount(root), 1)

  const second = stubLLM(() => { throw new Error('the LLM must not be called on an unchanged re-run') })
  let rerun: Awaited<ReturnType<typeof enrichSource>>
  try {
    rerun = await enrichSource({ text, title: 'Alpha Project' }, { vaultRoot: root })
  } finally {
    second.restore()
  }

  assert.equal(rerun.status, 'unchanged')
  assert.equal(second.calls.length, 0, 'the gate short-circuits before any LLM call')
  assert.equal(await commitCount(root), 1, 'no new commit on an unchanged re-run')
  assert.equal(readNest(root, 'nest/concepts/alpha-project.md'), before, 'the page is byte-for-byte unchanged')
})

test('two enrichment runs are two commits — one per run, never one per page', async (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  useLocalProvider(root)

  const first = stubLLM(modelResponse([
    { title: 'Alpha', type: 'concept', tags: [], summary: 'A', body: 'Alpha.' },
    { title: 'Beta', type: 'concept', tags: [], summary: 'B', body: 'Beta.' }
  ]))
  try {
    await enrichSource({ text: 'Alpha and Beta are two projects.', title: 'Projects' }, { vaultRoot: root })
  } finally {
    first.restore()
  }
  assert.equal(await commitCount(root), 1, 'two pages written, still one commit')

  const second = stubLLM(modelResponse([
    { title: 'Gamma', type: 'concept', tags: [], summary: 'G', body: 'Gamma.' }
  ]))
  try {
    await enrichSource({ text: 'Gamma is a third project.', title: 'Gamma Notes' }, { vaultRoot: root })
  } finally {
    second.restore()
  }
  assert.equal(await commitCount(root), 2, 'the second run is exactly one more commit')
})

test('a fetched URL is ingested with the URL as its provenance', async (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  useLocalProvider(root)

  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/html' },
    text: async () => '<html><body><h1>Sleep</h1><p>Sleep hygiene matters for recovery.</p></body></html>'
  })) as unknown as typeof fetch

  const llm = stubLLM(modelResponse([
    { title: 'Sleep Hygiene', type: 'concept', tags: ['sleep'], summary: 'Sleep', body: 'Sleep hygiene matters.' }
  ]))
  let result: Awaited<ReturnType<typeof enrichSource>>
  try {
    result = await enrichSource({ url: 'https://example.com/notes/sleep-hygiene.html' }, { vaultRoot: root, fetchImpl })
  } finally {
    llm.restore()
  }

  assert.equal(result.source, 'https://example.com/notes/sleep-hygiene.html')
  assert.equal(result.title, 'Sleep Hygiene', 'the title is derived from the URL path')
  const page = readNest(root, 'nest/concepts/sleep-hygiene.md')
  assert.match(page, /^source: '?https:\/\/example\.com\/notes\/sleep-hygiene\.html'?$/m)

  // the fetched page text (HTML stripped) reached the model, not the markup
  const prompt = llm.calls[0].messages
    ? (llm.calls[0].messages as Array<{ content: string }>).map((message) => message.content).join('\n')
    : ''
  assert.match(prompt, /Sleep hygiene matters for recovery\./)
  assert.doesNotMatch(prompt, /<html>/)
})

test('enrich_source runs as a real tool in the TurnLoop and reports in plain language', async (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  useLocalProvider(root)

  type Step = (request: LlmStreamRequest) => AsyncIterable<LlmStreamEvent>
  class ScriptedLlm {
    steps: Step[]
    requests: LlmStreamRequest[] = []
    constructor (steps: Step[]) { this.steps = steps }
    async * stream (request: LlmStreamRequest): AsyncIterable<LlmStreamEvent> {
      this.requests.push(request)
      const step = this.steps.shift()
      if (!step) { yield { type: 'done' }; return }
      yield * step(request)
    }
  }

  const llm = stubLLM(modelResponse([
    { title: 'Atlas Deadline', type: 'concept', tags: [], summary: 'Atlas', body: 'Atlas ships 2026-11-01.' }
  ]))

  const loopLlm = new ScriptedLlm([
    async function * () {
      yield {
        type: 'tool-call',
        call: {
          id: 'c1',
          name: ENRICH_SOURCE_TOOL_NAME,
          arguments: { text: 'The Atlas deadline is 2026-11-01.', title: 'Atlas Deadline' }
        }
      }
    },
    async function * () {
      yield { type: 'text', text: 'Noted the Atlas deadline.' }
    }
  ])

  const tools: Tool[] = createEnrichTools({ vaultRoot: root })
  const loop = new TurnLoop({ llm: loopLlm, tools, emit: () => {} })
  let result: Awaited<ReturnType<typeof loop.start>>
  try {
    result = await loop.start('sess-1', 'remember the Atlas deadline')
  } finally {
    llm.restore()
  }

  assert.equal(result.reason, 'completed')
  assert.equal(await commitCount(root), 1, 'the tool committed the run exactly once')

  const last = loopLlm.requests.at(-1)
  const toolMessages = (last?.messages ?? []).filter(
    (message): message is Extract<LlmMessage, { role: 'tool' }> => message.role === 'tool'
  )
  const report = toolMessages.map((message) => message.content).join('\n')
  assert.match(report, /Enriched "Atlas Deadline"/)
  assert.match(report, /created \[\[atlas-deadline\]\]/)
  assert.match(report, /one commit/i)
})

test('enrich_source validates its arguments: one of text/url, and no path-shaped keys', () => {
  assert.throws(() => enrichSourceSchema.parse({ text: 'a', url: 'https://example.com' }), /exactly one/)
  assert.throws(() => enrichSourceSchema.parse({}))
  assert.throws(() => enrichSourceSchema.parse({ text: 'a', path: 'pages/leak.md' }))
})
