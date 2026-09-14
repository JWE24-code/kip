// Acceptance tests for the P3 read path (#72). Every behavior here mirrors a
// scenario `scripts/test/peck.test.js` treats as the spec: index-first
// selection with a recall-safe fallback, multi-hop outbound-link expansion,
// dead-citation detection, and groom-conflict injection. The tests drive the
// tools both directly and through the model-driven TurnLoop, so the behavior
// is verified against the loop that actually calls them, not just the helpers.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LlmStreamEvent, LlmStreamRequest } from '../session/loop.ts'
import { TurnLoop } from '../session/loop.ts'
import {
  SEARCH_NOTES_TOOL_NAME,
  READ_NOTE_TOOL_NAME,
  answerEvidence,
  applySelection,
  assembleReadContext,
  createNoteTools,
  deadCitationSlugs,
  expandByOutboundLinks,
  knownConflictsFor,
  lintWarningsFor,
  readNote,
  searchNotes
} from '../session/notes.ts'

const require = createRequire(import.meta.url)
const { rebuildRoost } = require('../../scripts/rebuild-roost.js') as {
  rebuildRoost: (vaultRoot: string) => { indexed: number }
}

function makeTempVault (): string {
  const root = mkdtempSync(join(tmpdir(), 'coop-notes-test-'))
  for (const dir of ['nest/entities', 'nest/concepts', 'nest/sources', 'pages', 'journals', '.roost', '.henhouse']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  return root
}

interface PageOptions {
  type: string
  tags?: string[]
  body?: string
  summary?: string
}

function writePage (root: string, dir: string, slug: string, { type, tags = [], body = '', summary }: PageOptions): void {
  const frontmatter = [
    '---',
    `type: ${type}`,
    ...(summary ? [`summary: ${summary}`] : []),
    'created: 2026-01-01',
    'updated: 2026-01-01',
    `tags: [${tags.join(', ')}]`,
    '---',
    ''
  ].join('\n')
  writeFileSync(join(root, 'nest', dir, `${slug}.md`), frontmatter + body + '\n')
}

function writeVaultNote (root: string, relPath: string, body: string, title?: string): void {
  const file = join(root, relPath)
  mkdirSync(join(file, '..'), { recursive: true })
  const frontmatter = title ? `---\ntitle: ${title}\n---\n` : ''
  writeFileSync(file, `${frontmatter}${body}\n`)
}

function writeLint (root: string, findings: unknown): void {
  writeFileSync(
    join(root, '.roost', 'lint.json'),
    JSON.stringify({ generated: new Date().toISOString(), deep: false, findings })
  )
}

test('search_notes returns a namespaced index with summary, sections, and snippet', (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writePage(root, 'concepts', 'sleep-hygiene', {
    type: 'concept',
    summary: 'How the user keeps their sleep on track',
    body: 'Consistent bedtime; no screens after 22:00.\n\n## Hygiene\nKeep a consistent bedtime.\n\n## Screens\nNo screens after 22:00.'
  })
  writePage(root, 'concepts', 'sleep-quality', { type: 'concept', body: 'Deeper, more restful sleep.' })
  rebuildRoost(root)

  const results = searchNotes('sleep', { namespace: 'aw', vaultRoot: root })
  const ids = results.map((r) => r.id)
  assert.ok(ids.includes('aw:sleep-hygiene') && ids.includes('aw:sleep-quality'), 'ids are aw:-prefixed')

  const hygiene = results.find((r) => r.slug === 'sleep-hygiene')
  assert.ok(hygiene)
  assert.equal(hygiene.summary, 'How the user keeps their sleep on track')
  assert.ok(hygiene.snippet.length > 0, 'a snippet is included')
  assert.deepEqual(
    hygiene.sections.map((s) => s.heading),
    ['', 'Hygiene', 'Screens'],
    'the section index travels with the candidate'
  )
})

test('search_notes spans the user vault (kb:) and the agent workspace (aw:)', (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writePage(root, 'concepts', 'sleep-hygiene', { type: 'concept', body: 'Consistent bedtime.' })
  writeVaultNote(root, 'pages/sailing-notes.md', 'About sailing the North Sea and knots.', 'Sailing notes')
  rebuildRoost(root)

  const results = searchNotes('sailing sleep', { namespace: 'all', vaultRoot: root })
  const byNamespace = new Map(results.map((r) => [r.namespace, r]))
  assert.equal(byNamespace.get('kb')?.id, 'kb:sailing-notes')
  assert.equal(byNamespace.get('aw')?.id, 'aw:sleep-hygiene')

  // a namespace filter narrows the search
  assert.deepEqual(searchNotes('sailing sleep', { namespace: 'kb', vaultRoot: root }).map((r) => r.id), ['kb:sailing-notes'])
})

test('read_note returns full content by id, and resolves both namespaces', (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writePage(root, 'concepts', 'sleep-hygiene', { type: 'concept', body: 'Consistent bedtime; no screens.' })
  writeVaultNote(root, 'pages/sailing-notes.md', 'About sailing the North Sea.', 'Sailing notes')
  rebuildRoost(root)

  const aw = readNote('aw:sleep-hygiene', { vaultRoot: root })
  assert.ok(aw)
  assert.equal(aw.type, 'concept')
  assert.match(aw.content, /Consistent bedtime/)
  assert.equal(aw.id, 'aw:sleep-hygiene')

  const kb = readNote('kb:sailing-notes', { vaultRoot: root })
  assert.ok(kb)
  assert.equal(kb.summary, 'Sailing notes')
  assert.match(kb.content, /North Sea/)

  assert.equal(readNote('aw:ghost-page', { vaultRoot: root }), null)
})

test('an empty or unusable selection falls back to the full candidate set (kip-app#106)', (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writePage(root, 'concepts', 'sleep-hygiene', { type: 'concept', body: 'Consistent bedtime.' })
  writePage(root, 'concepts', 'sleep-quality', { type: 'concept', body: 'Deeper sleep.' })
  rebuildRoost(root)

  const candidates = searchNotes('sleep', { namespace: 'aw', vaultRoot: root })
  assert.equal(candidates.length, 2)

  assert.deepEqual(applySelection([], candidates), candidates, 'empty selection keeps every candidate')
  assert.deepEqual(applySelection(null, candidates), candidates, 'malformed selection keeps every candidate')
  assert.deepEqual(applySelection(['aw:not-a-page'], candidates), candidates, 'all-unknown selection keeps every candidate')

  const chosen = applySelection(['aw:sleep-hygiene'], candidates)
  assert.deepEqual(chosen.map((c) => c.id), ['aw:sleep-hygiene'], 'a valid selection narrows the set')
})

test('multi-hop: an outbound [[link]] reaches a page the question never matched (kip-app#106)', (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writePage(root, 'concepts', 'sleep', { type: 'concept', body: 'Sleep notes. My doctor is [[dr-alvarez]].' })
  writePage(root, 'entities', 'dr-alvarez', { type: 'entity', body: 'Dr Alvarez recommends no screens before bed.' })
  rebuildRoost(root)

  const first = readNote('aw:sleep', { vaultRoot: root })
  assert.ok(first)
  const expanded = expandByOutboundLinks([first], root)
  assert.ok(expanded.some((page) => page.slug === 'dr-alvarez'), 'the linked page was pulled in one hop')
  assert.match(expanded.find((p) => p.slug === 'dr-alvarez')?.content ?? '', /no screens/)
})

test('dead citations are flagged, not rendered as silent broken links (kip-app#117)', (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writePage(root, 'concepts', 'sleep-hygiene', { type: 'concept', body: 'notes' })
  rebuildRoost(root)

  const answer = 'Per [[sleep-hygiene]] and [[ghost-page]], and on [[2026-08-26]] you noted [[another-ghost]].'
  assert.deepEqual(
    deadCitationSlugs(answer, ['sleep-hygiene'], root).sort(),
    ['another-ghost', 'ghost-page']
  )
  assert.deepEqual(deadCitationSlugs('see [[sleep-hygiene]]', ['sleep-hygiene'], root), [])

  const evidence = answerEvidence(answer, ['sleep-hygiene'], root)
  assert.deepEqual(evidence.citedSlugs, ['sleep-hygiene'])
  assert.deepEqual(evidence.deadCitations.sort(), ['another-ghost', 'ghost-page'])
})

test('groom findings are injected read-only (kip-app#116)', (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  assert.deepEqual(lintWarningsFor(root, ['a']), [], 'no lint.json yet -> no warnings, no throw')

  writeLint(root, {
    'sleep-hygiene': [{ kind: 'orphan', note: 'nothing links to this page' }],
    'salary-2025': [{ kind: 'contradiction', note: '90k vs 110k', slugs: ['salary-2025', 'salary-2026'] }],
    'salary-2026': [{ kind: 'contradiction', note: '90k vs 110k', slugs: ['salary-2025', 'salary-2026'] }]
  })
  const before = readFileSync(join(root, '.roost', 'lint.json'), 'utf8')

  assert.deepEqual(lintWarningsFor(root, ['sleep-hygiene', 'unflagged']), [
    { slug: 'sleep-hygiene', kind: 'orphan', note: 'nothing links to this page' }
  ])
  assert.deepEqual(lintWarningsFor(root, ['unflagged']), [])

  assert.deepEqual(knownConflictsFor(root, ['salary-2025', 'salary-2026']), [
    { slugs: ['salary-2025', 'salary-2026'], note: '90k vs 110k' }
  ])
  assert.deepEqual(knownConflictsFor(root, ['salary-2025', 'something-else']), [], 'one side only -> no conflict')

  assert.equal(readFileSync(join(root, '.roost', 'lint.json'), 'utf8'), before, 'lint.json is never written')
})

test('assembleReadContext reads the selection, expands links, and surfaces conflicts', (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writePage(root, 'concepts', 'sleep', { type: 'concept', body: 'Sleep notes. My doctor is [[dr-alvarez]].' })
  writePage(root, 'entities', 'dr-alvarez', { type: 'entity', body: 'No screens before bed.' })
  rebuildRoost(root)
  writeLint(root, {
    sleep: [{ kind: 'contradiction', note: 'bedtime varies', slugs: ['sleep', 'dr-alvarez'] }]
  })

  const chosen = assembleReadContext('sleep', { namespace: 'aw', chosenIds: ['aw:sleep'], vaultRoot: root })
  assert.deepEqual(chosen.pages.map((p) => p.slug), ['sleep', 'dr-alvarez'])
  assert.deepEqual(chosen.knownConflicts, [{ slugs: ['sleep', 'dr-alvarez'], note: 'bedtime varies' }])

  const fallback = assembleReadContext('sleep', { namespace: 'aw', chosenIds: [], vaultRoot: root })
  assert.deepEqual(fallback.pages.map((p) => p.slug).sort(), ['dr-alvarez', 'sleep'], 'empty selection keeps every candidate')
})

// ---- Through the model-driven loop -----------------------------------------

type Step = (request: LlmStreamRequest) => AsyncIterable<LlmStreamEvent>

class ScriptedLlm {
  steps: Step[]
  requests: LlmStreamRequest[] = []

  constructor (steps: Step[]) {
    this.steps = steps
  }

  async *stream (request: LlmStreamRequest): AsyncIterable<LlmStreamEvent> {
    this.requests.push(request)
    const step = this.steps.shift()
    if (!step) {
      yield { type: 'done' }
      return
    }
    yield* step(request)
  }
}

test('search_notes runs as a real tool in the TurnLoop and feeds the next completion', async (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writePage(root, 'concepts', 'sleep-hygiene', {
    type: 'concept',
    summary: 'How the user keeps their sleep on track',
    body: 'Consistent bedtime; no screens after 22:00.'
  })
  rebuildRoost(root)

  const seen: string[] = []
  const llm = new ScriptedLlm([
    async function * () {
      yield { type: 'tool-call', call: { id: 'c1', name: SEARCH_NOTES_TOOL_NAME, arguments: { query: 'sleep' } } }
    },
    async function * (request) {
      for (const message of request.messages) if (message.role === 'tool') seen.push(message.content)
      yield { type: 'text', text: 'rest more' }
    }
  ])

  const events: string[] = []
  const loop = new TurnLoop({
    llm,
    tools: createNoteTools({ vaultRoot: root }),
    emit: (event) => events.push(event.type)
  })
  const result = await loop.start('sess-1', 'what about sleep?')

  assert.equal(result.reason, 'completed')
  const toolResult = seen.join('\n')
  assert.match(toolResult, /aw:sleep-hygiene/, 'the search index reached the next completion')
  assert.match(toolResult, /Hygiene|Consistent bedtime/)
  assert.ok(events.includes('agent.tool.start') && events.includes('agent.tool.end'))
})

test('read_note feeds full note content back into the loop', async (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writePage(root, 'concepts', 'sleep-hygiene', {
    type: 'concept',
    body: 'Consistent bedtime; no screens after 22:00.'
  })
  rebuildRoost(root)

  const seen: string[] = []
  const llm = new ScriptedLlm([
    async function * () {
      yield { type: 'tool-call', call: { id: 'c1', name: SEARCH_NOTES_TOOL_NAME, arguments: { query: 'sleep' } } }
    },
    async function * () {
      yield { type: 'tool-call', call: { id: 'c2', name: READ_NOTE_TOOL_NAME, arguments: { id: 'aw:sleep-hygiene' } } }
    },
    async function * (request) {
      for (const message of request.messages) if (message.role === 'tool') seen.push(message.content)
      yield { type: 'text', text: 'done' }
    }
  ])

  const loop = new TurnLoop({ llm, tools: createNoteTools({ vaultRoot: root }), emit: () => {} })
  const result = await loop.start('sess-1', 'what about sleep?')

  assert.equal(result.reason, 'completed')
  assert.match(seen.join('\n'), /### aw:sleep-hygiene \(type: concept\)/)
  assert.match(seen.join('\n'), /Consistent bedtime; no screens after 22:00\./)
})
