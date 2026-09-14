// Acceptance tests for P5 #76: Groom's batch contradiction check ported into
// context assembly. The algorithm is `scripts/groom.js` unchanged; these tests
// pin the three contracts of the port:
//   - AD-9's ceiling: a contradiction is surfaced only between pages that shared
//     a batch (≤6, by type/tag) — never across batches;
//   - `conflicts/` reports link both pages and those links resolve;
//   - deep-mode summary drift still updates only the index (meta.db), never a
//     `nest/` markdown file.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  conflictReportSlug,
  findContradictionsInPlay,
  runQuickGroom,
  writeConflictReports
} from '../session/groom.ts'

const require = createRequire(import.meta.url)
const { rebuildRoost } = require('../../scripts/rebuild-roost.js') as {
  rebuildRoost: (vaultRoot: string) => { indexed: number }
}
const { getPage } = require('../../scripts/lib/roost.js') as {
  getPage: (slug: string, vaultRoot?: string) => { slug: string, summary: string } | null
}
const { runGroom } = require('../../scripts/groom.js') as {
  runGroom: (
    vaultRoot: string,
    options: { deep: boolean, flagFn: unknown, deps?: Record<string, unknown> }
  ) => Promise<Record<string, unknown>>
}

function makeTempVault (): string {
  const root = mkdtempSync(join(tmpdir(), 'coop-groom-test-'))
  for (const dir of ['nest/entities', 'nest/concepts', 'nest/sources', 'nest/conflicts', '.roost']) {
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

// ---- AD-9: the batch ceiling -----------------------------------------------

test('the batch check surfaces a pairing inside a batch and none across batches (AD-9)', async (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  // Eight same-type pages split 4/4 by tag, so batching produces two batches;
  // p0..p3 and p4..p7 never share one. An entity is a singleton type and is
  // therefore never batched at all.
  const concepts: string[] = []
  for (let i = 0; i < 8; i += 1) {
    const slug = `p${i}`
    writePage(root, 'concepts', slug, { type: 'concept', tags: [i < 4 ? 'health' : 'finance'], body: `${slug} body.` })
    concepts.push(slug)
  }
  writePage(root, 'entities', 'outside-page', { type: 'entity', body: 'An entity, alone in its type.' })
  rebuildRoost(root)

  const batches: string[][] = []
  const flagFn = async (group: Array<{ slug: string }>): Promise<Array<{ slugs: string[], description: string }>> => {
    batches.push(group.map((page) => page.slug))
    return [
      { slugs: ['p0', 'p1'], description: 'same batch' }, // both in the first batch -> surfaced
      { slugs: ['p0', 'p5'], description: 'across batches' }, // never share a batch -> not
      { slugs: ['p0', 'outside-page'], description: 'outside the batch' } // not in play -> not
    ]
  }

  const found = await findContradictionsInPlay(root, [...concepts, 'outside-page'], { flagFn })

  assert.ok(batches.length >= 2, 'the oversized type was split across batches')
  assert.ok(batches.every((batch) => batch.length <= 6), 'no batch exceeds AD-9\'s ceiling')
  assert.equal(found.length, 1, 'only the in-batch pair is surfaced')
  assert.deepEqual(found[0].slugs.slice().sort(), ['p0', 'p1'])
  assert.ok(!found.some((conflict) => conflict.slugs.includes('outside-page')))
  assert.ok(!found.some((conflict) => conflict.slugs.slice().sort().join() === 'p0,p5'))
})

test('a singleton page set has nothing to compare and makes no call', async (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writePage(root, 'concepts', 'only-one', { type: 'concept', body: 'alone' })
  rebuildRoost(root)

  let calls = 0
  const flagFn = async (): Promise<Array<{ slugs?: unknown, description?: unknown }>> => { calls += 1; return [] }
  assert.deepEqual(await findContradictionsInPlay(root, ['only-one'], { flagFn }), [])
  assert.equal(calls, 0, 'no batch -> no LLM call')
})

// ---- FR-15: conflicts/ reports ---------------------------------------------

test('conflict reports link both pages and every link resolves', (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writePage(root, 'concepts', 'salary-2025', { type: 'concept', body: 'Offered 90k.' })
  writePage(root, 'concepts', 'salary-2026', { type: 'concept', body: 'Offered 110k.' })
  rebuildRoost(root)

  const reports = writeConflictReports(root, [
    { slugs: ['salary-2026', 'salary-2025'], note: 'The 2025 figure says 90k, the 2026 one says 110k.' }
  ])

  assert.equal(reports.length, 1)
  assert.equal(reports[0].path, 'nest/conflicts/conflict-salary-2025-salary-2026.md')
  assert.deepEqual(reports[0].slugs, ['salary-2025', 'salary-2026'])

  const file = join(root, reports[0].path)
  assert.ok(existsSync(file), 'the report was written into nest/conflicts/')
  const markdown = readFileSync(file, 'utf8')
  const links = [...new Set([...markdown.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => match[1]))]
  assert.deepEqual(links.sort(), ['salary-2025', 'salary-2026'])
  for (const slug of links) {
    assert.ok(getPage(slug, root), `[[${slug}]] resolves to a real nest page`)
  }

  // A pair that cannot fully resolve is skipped rather than written with a dead link.
  assert.deepEqual(writeConflictReports(root, [{ slugs: ['salary-2025', 'ghost-page'], note: 'x' }]), [])
})

test('conflictReportSlug is stable regardless of argument order', () => {
  assert.equal(conflictReportSlug(['b', 'a']), 'conflict-a-b')
  assert.equal(conflictReportSlug(['a', 'b']), conflictReportSlug(['b', 'a']))
})

// ---- The quick pass --------------------------------------------------------

test('runQuickGroom runs the quick pass and writes .roost/lint.json for the read path', async (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writePage(root, 'concepts', 'sleep-hygiene', { type: 'concept', tags: ['health'], body: 'Sleep hygiene notes.' })
  writePage(root, 'concepts', 'sleep-quality', { type: 'concept', tags: ['health'], body: 'Links [[sleep-hygiene]].' })
  rebuildRoost(root)

  const report = await runQuickGroom(root, {
    flagFn: async () => [{ slugs: ['sleep-hygiene', 'sleep-quality'], description: 'stubbed contradiction' }]
  })

  assert.equal(report.deep, false)
  assert.ok(report.orphans.includes('sleep-quality'))
  assert.equal(report.contradictions.length, 1)

  const lint = JSON.parse(readFileSync(join(root, '.roost', 'lint.json'), 'utf8'))
  assert.equal(lint.deep, false)
  const finding = (lint.findings['sleep-hygiene'] || []).find((entry: { kind: string }) => entry.kind === 'contradiction')
  assert.equal(finding.note, 'stubbed contradiction')
})

// ---- Deep-mode summary drift stays out of the markdown ---------------------

test('deep-mode summary drift updates the index, never the nest markdown (kip-app#115)', async (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writePage(root, 'concepts', 'sleep', {
    type: 'concept',
    tags: ['health'],
    summary: 'An older summary',
    body: 'x'.repeat(420) + '\n\nSleep tracked over several months.'
  })
  rebuildRoost(root)

  const file = join(root, 'nest', 'concepts', 'sleep.md')
  const before = readFileSync(file, 'utf8')

  const deps = {
    reviewPageCoherence: async () => ({ issues: [], consolidate: false }),
    checkSummaryAccuracy: async () => ({ ok: false, suggested: 'Average sleep dropped from 8h to 6h' }),
    checkSectionSummaries: async () => ({ updates: [] }),
    confirmMissingLinks: async () => [],
    checkPagesSameSubject: async () => ({ same: false, reason: '' })
  }
  const report = await runGroom(root, { deep: true, flagFn: async () => [], deps })
  const drift = (report.summaryDrift as Array<{ slug: string, applied: boolean }>).find((entry) => entry.slug === 'sleep')

  assert.ok(drift && drift.applied, 'the summary was refreshed')
  assert.equal(getPage('sleep', root)?.summary, 'Average sleep dropped from 8h to 6h', 'meta.db carries the new summary')
  assert.equal(readFileSync(file, 'utf8'), before, 'the .md file is byte-for-byte untouched')
})
