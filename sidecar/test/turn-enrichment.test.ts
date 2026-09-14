// Answer enrichment (kip#98): the server-side step that turns the loop's raw
// per-turn accounting plus the final answer text into the evidence/citation/
// statement shape kip-app consumes. These tests exercise it directly, against a
// real vault, so the extractors stay wired to the same behavior peck.js had.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTurnEnricher } from '../server/turn-enrichment.ts'

function makeTempVault (): string {
  const root = mkdtempSync(join(tmpdir(), 'kip-turn-enrichment-'))
  for (const dir of ['nest/concepts', '.roost', '.henhouse']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  writeFileSync(join(root, 'nest', 'concepts', 'sleep-hygiene.md'), [
    '---',
    'type: concept',
    'summary: How the user keeps sleep on track',
    'created: 2026-01-01',
    'updated: 2026-01-01',
    'tags: []',
    '---',
    '',
    'Consistent bedtime.',
    ''
  ].join('\n'))
  writeFileSync(join(root, '.roost', 'lint.json'), JSON.stringify({
    generated: '2026-01-01T00:00:00.000Z',
    deep: false,
    findings: {
      'sleep-hygiene': [{ kind: 'orphan', note: 'nothing links to this page' }]
    }
  }))
  return root
}

test('a search-driven answer gets citedSlugs, deadCitations, lintWarnings and sources', (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const enrich = createTurnEnricher(root)

  const result = enrich({
    text: 'Consistent bedtime; see [[sleep-hygiene]] and [[ghost-note]].',
    accounting: { candidateSlugs: ['sleep-hygiene', 'beta'], writes: [] }
  })

  assert.deepEqual(result.candidateSlugs, ['sleep-hygiene', 'beta'])
  assert.deepEqual(result.citedSlugs, ['sleep-hygiene'])
  assert.deepEqual(result.deadCitations, ['ghost-note'])
  assert.deepEqual(result.lintWarnings, [
    { slug: 'sleep-hygiene', kind: 'orphan', note: 'nothing links to this page' }
  ])
  assert.deepEqual(result.sources, [{ slug: 'sleep-hygiene', title: 'sleep hygiene' }])
  assert.equal(result.intent, undefined, 'a cited answer is not a statement')
})

test('a write-only turn becomes the learned-fact card with a synthesized note', (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const enrich = createTurnEnricher(root)

  const result = enrich({
    text: '',
    accounting: { candidateSlugs: [], writes: [{ action: 'create', slug: 'acme-moved' }] }
  })

  assert.equal(result.intent, 'statement')
  assert.equal(result.learned, true)
  assert.deepEqual(result.pages, [{ action: 'create', slug: 'acme-moved' }])
  assert.equal(result.note, 'Saved to the nest: acme moved.')
  assert.deepEqual(result.citedSlugs, [])
})

test('a filing turn keeps the model\'s confirmation as the card text', (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const enrich = createTurnEnricher(root)

  const result = enrich({
    text: 'Saved "Acme moved".',
    accounting: { candidateSlugs: [], writes: [{ action: 'update', slug: 'acme' }] }
  })

  assert.equal(result.intent, 'statement')
  assert.equal(result.note, 'Saved "Acme moved".')
  assert.deepEqual(result.pages, [{ action: 'update', slug: 'acme' }])
})

test('a turn that cited pages stays an answer even if it also wrote a note', (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const enrich = createTurnEnricher(root)

  const result = enrich({
    text: 'Per [[sleep-hygiene]], yes.',
    accounting: { candidateSlugs: ['sleep-hygiene'], writes: [{ action: 'create', slug: 'filed-answer' }] }
  })

  assert.equal(result.intent, undefined, 'an answer with citations is not a statement')
  assert.deepEqual(result.citedSlugs, ['sleep-hygiene'])
})

test('without a vault the pure evidence still comes through', () => {
  const enrich = createTurnEnricher()
  const result = enrich({
    text: 'See [[sleep-hygiene]].',
    accounting: { candidateSlugs: ['sleep-hygiene'], writes: [] }
  })
  assert.deepEqual(result.citedSlugs, ['sleep-hygiene'])
  assert.deepEqual(result.sources, [{ slug: 'sleep-hygiene', title: 'sleep hygiene' }])
  assert.deepEqual(result.deadCitations, [])
  assert.deepEqual(result.lintWarnings, [])
})
