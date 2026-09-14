// The roost module's acceptance tests, ported from scripts/test/roost.test.js
// (kip#70). The intent — and every assertion — is unchanged; the only edits
// are the import path (the module now lives in the sidecar) and awaiting the
// now-worker-backed writes. The CLI-level `delete-person.js` case stays in
// scripts/test/roost.test.js because it exercises that script, not this
// module.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

import {
  appendLog,
  closeAllReaders,
  closeWriters,
  findSimilarSlug,
  getPage,
  getPageSections,
  rebuildRoost,
  recentClucks,
  regenerateIndexMd,
  removePage,
  SCHEMA,
  searchPages,
  setPageSummary,
  setSectionSummaries,
  slugify,
  splitSections,
  summarizeSection
} from '../roost/index.ts'

const require = createRequire(import.meta.url)
const legacyDb = require('../../scripts/lib/db.js') as { SCHEMA: string }
const legacyRoost = require('../../scripts/lib/roost.js') as {
  searchPages: (query: string, options?: Record<string, unknown>, vaultRoot?: string) => unknown
}

function makeTempVault (): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-test-'))
  for (const dir of ['nest/entities', 'nest/concepts', 'nest/sources', 'clucks', '.roost']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  return root
}

function writePage (
  root: string,
  dir: string,
  slug: string,
  { type, tags = [], body = '' }: { type: string, tags?: string[], body?: string }
): void {
  const frontmatter = [
    '---',
    `type: ${type}`,
    'created: 2026-01-01',
    'updated: 2026-01-01',
    `tags: [${tags.join(', ')}]`,
    '---',
    ''
  ].join('\n')
  fs.writeFileSync(path.join(root, 'nest', dir, `${slug}.md`), frontmatter + body + '\n')
}

function cleanup (root: string): () => void {
  return () => {
    closeAllReaders()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('slugify — ASCII unchanged, Unicode letters kept, never empty (kip-app#97)', () => {
  // ASCII behaviour is exactly as before
  assert.equal(slugify('Sleep Hygiene'), 'sleep-hygiene')
  assert.equal(slugify('  Q3 Planning!!  '), 'q3-planning')
  assert.equal(slugify('A/B test'), 'a-b-test')
  // non-English letters and digits survive instead of collapsing to dashes
  assert.equal(slugify('Größe'), 'größe')
  assert.equal(slugify('Café-Notizen'), 'café-notizen')
  assert.equal(slugify('Réunion budget'), 'réunion-budget')
  assert.equal(slugify('北京会議'), '北京会議')
  assert.equal(slugify('Año nuevo'), 'año-nuevo')
  // an all-punctuation / emoji title falls back to a stable non-empty hash
  const h = slugify('🎉🎊')
  assert.match(h, /^page-[0-9a-f]{8}$/)
  assert.equal(slugify('🎉🎊'), h, 'the fallback is deterministic')
  assert.equal(slugify(''), slugify(''))
})

test('rebuildRoost + searchPages + findSimilarSlug + clucks', async (t) => {
  const root = makeTempVault()
  t.after(cleanup(root))
  t.after(() => closeWriters())

  writePage(root, 'concepts', 'sleep-hygiene', {
    type: 'concept',
    tags: ['health', 'sleep'],
    body: 'Notes on sleep hygiene: consistent bedtime, no screens before bed, cool dark room.'
  })
  writePage(root, 'concepts', 'morning-routine', {
    type: 'concept',
    tags: ['habit'],
    body: 'A consistent morning routine helps with focus and energy throughout the day.'
  })
  writePage(root, 'entities', 'dr-smith', {
    type: 'entity',
    tags: ['doctor'],
    body: 'Primary care physician. Discussed sleep issues and a referral to a sleep specialist.'
  })

  const result = await rebuildRoost(root)
  assert.equal(result.indexed, 3, 'rebuildRoost should find all 3 fake pages')

  await t.test('searchPages finds pages by body text, ranked by relevance', () => {
    const results = searchPages('sleep', {}, root)
    const slugs = results.map((r) => r.slug)
    assert.ok(slugs.includes('sleep-hygiene'), 'sleep-hygiene should match "sleep"')
    assert.ok(slugs.includes('dr-smith'), 'dr-smith should match "sleep" (mentions sleep issues)')
    assert.ok(!slugs.includes('morning-routine'), 'morning-routine has no mention of sleep')
    assert.ok(results[0].snippet.length > 0, 'results should include a snippet')
  })

  await t.test('searchPages respects a type filter', () => {
    const results = searchPages('sleep', { type: 'entity' }, root)
    assert.deepEqual(results.map((r) => r.slug), ['dr-smith'])
  })

  await t.test('searchPages respects a tags filter', () => {
    const results = searchPages('sleep', { tags: ['doctor'] }, root)
    assert.deepEqual(results.map((r) => r.slug), ['dr-smith'])
  })

  await t.test('findSimilarSlug catches an obvious near-duplicate title', () => {
    const match = findSimilarSlug('sleep-quality', root)
    assert.ok(match)
    assert.equal(match.slug, 'sleep-hygiene', 'sleep-quality should be closest to sleep-hygiene')
    // "sleep-quality" vs "sleep-hygiene": normalized Levenshtein similarity ~0.46 —
    // well clear of an unrelated title's score (checked below), which is what
    // duplicate-prevention actually needs: the closest existing page ranks first.
    assert.ok(match.score > 0.3, `expected a meaningfully high similarity score, got ${match.score}`)
  })

  await t.test('findSimilarSlug does not falsely flag an unrelated title', () => {
    const match = findSimilarSlug('quarterly-tax-filing', root)
    assert.ok(!match || match.score < 0.3, `expected a low similarity score, got ${match && match.score}`)
  })

  await t.test('getPage returns a page row by slug, or null', () => {
    const page = getPage('sleep-hygiene', root)
    assert.ok(page)
    assert.equal(page.slug, 'sleep-hygiene')
    assert.equal(page.path, 'nest/concepts/sleep-hygiene.md')
    assert.equal(page.type, 'concept')
    assert.deepEqual(page.tags, ['health', 'sleep'])
    assert.equal(getPage('does-not-exist', root), null)
  })

  await t.test('appendLog writes to the log table and the month file', async () => {
    await appendLog('hatch', 'Test hatch', ['sleep-hygiene'], root)
    const recent = recentClucks(1, root)
    assert.equal(recent.length, 1)
    assert.equal(recent[0].kind, 'hatch')
    assert.deepEqual(recent[0].pages_touched, ['sleep-hygiene'])

    const month = new Date().toISOString().slice(0, 7)
    const logFile = path.join(root, 'clucks', `${month}.md`)
    assert.ok(fs.existsSync(logFile), 'month clucks file should be created')
    const contents = fs.readFileSync(logFile, 'utf8')
    assert.ok(contents.includes('hatch | Test hatch'))
    assert.ok(contents.includes('- sleep-hygiene'))
  })

  await t.test('regenerateIndexMd writes a readable, grouped index', async () => {
    await regenerateIndexMd(root)
    const contents = fs.readFileSync(path.join(root, 'nest', 'index.md'), 'utf8')
    assert.ok(contents.includes('title:: The Nest'))
    assert.ok(contents.includes('## Concepts'))
    assert.ok(contents.includes('Sleep Hygiene'))
    assert.ok(contents.includes('## Entities'))
    assert.ok(contents.includes('Dr Smith'))
  })

  await t.test('rebuildRoost is safely re-runnable and drops stale pages', async () => {
    fs.rmSync(path.join(root, 'nest', 'concepts', 'morning-routine.md'))
    const second = await rebuildRoost(root)
    assert.equal(second.indexed, 2)
    const results = searchPages('routine', {}, root)
    assert.equal(results.length, 0, 'deleted page should no longer be searchable')
  })
})

test('setPageSummary updates only the summary column (kip-app#115)', async (t) => {
  const root = makeTempVault()
  t.after(cleanup(root))
  t.after(() => closeWriters())

  writePage(root, 'concepts', 'sleep', { type: 'concept', body: 'Notes on sleep. Averaging 6h.' })
  await rebuildRoost(root)
  const before = getPage('sleep', root)
  assert.ok(before)

  assert.equal(await setPageSummary('sleep', 'Sleep tracking — average dropped to ~6h', root), true)
  const after = getPage('sleep', root)
  assert.ok(after)
  assert.equal(after.summary, 'Sleep tracking — average dropped to ~6h')
  assert.equal(after.path, before.path, 'path untouched')
  assert.equal(after.type, before.type, 'type untouched')
  // body FTS is unchanged — still searchable by its text
  assert.equal(searchPages('averaging', {}, root)[0].slug, 'sleep')

  assert.equal(await setPageSummary('no-such-page', 'x', root), false, 'no row -> false')
})

test('removePage drops a page from pages + pages_fts + sections (kip-app#126)', async (t) => {
  const root = makeTempVault()
  t.after(cleanup(root))
  t.after(() => closeWriters())

  writePage(root, 'concepts', 'keep-me', { type: 'concept', body: 'Notes worth keeping.' })
  writePage(root, 'concepts', 'drop-me', { type: 'concept', body: 'Ephemeral notes about widgets.\n\n## A section\n\nmore.' })
  await rebuildRoost(root)
  assert.ok(getPage('drop-me', root))
  assert.equal(searchPages('widgets', {}, root)[0].slug, 'drop-me')

  assert.equal(await removePage('drop-me', root), true, 'a deleted row -> true')
  assert.equal(getPage('drop-me', root), null, 'pages row gone')
  assert.equal(searchPages('widgets', {}, root).length, 0, 'pages_fts row gone')
  assert.ok(getPage('keep-me', root), 'other pages untouched')

  assert.equal(await removePage('never-existed', root), false, 'nothing to delete -> false')
})

test('the per-section index — splitSections + summarizeSection (kip-app#106)', async (t) => {
  await t.test('splitSections splits on ## headings and _Update markers, keeping the lead', () => {
    const body = 'Leading paragraph.\n\n## Sleep hygiene\nConsistent bedtime.\n\n### Screens\nNo screens after 22:00.\n\n---\n_Update 2026-09-04:_\n\nStarted tracking duration.\n'
    const sections = splitSections(body)
    assert.deepEqual(sections.map((s) => s.heading), ['', 'Sleep hygiene', 'Screens', '_Update 2026-09-04:_'])
    assert.match(sections[0].body, /Leading paragraph/)
    assert.match(sections[1].body, /Consistent bedtime/)
    assert.match(sections[3].body, /Started tracking duration/)
  })

  await t.test('summarizeSection takes the first non-heading line, truncated', () => {
    assert.equal(summarizeSection('The user averages 6 hours.\n\nMore detail here.'), 'The user averages 6 hours.')
    assert.equal(summarizeSection('# Heading\n\nFirst real line.'), 'First real line.')
    assert.equal(summarizeSection(''), '')
  })

  await t.test('upsertPage writes sections; getPageSections reads them in order', async () => {
    const root = makeTempVault()
    t.after(cleanup(root))
    t.after(() => closeWriters())
    writePage(root, 'concepts', 'sleep', {
      type: 'concept',
      body: 'Intro.\n\n## Hygiene\nKeep a consistent bedtime.\n\n## Screens\nNo screens late.'
    })
    await rebuildRoost(root)
    const sections = getPageSections('sleep', root)
    assert.deepEqual(sections.map((s) => s.heading), ['', 'Hygiene', 'Screens'])
    assert.equal(sections[1].summary, 'Keep a consistent bedtime.')
  })

  await t.test('setSectionSummaries matches LLM one-liners by heading and leaves the rest', async () => {
    const root = makeTempVault()
    t.after(cleanup(root))
    t.after(() => closeWriters())
    writePage(root, 'concepts', 'sleep', {
      type: 'concept',
      body: 'Intro.\n\n## Hygiene\nKeep a consistent bedtime.\n\n## Screens\nNo screens late.'
    })
    await rebuildRoost(root)

    const n = await setSectionSummaries('sleep', [
      { heading: 'hygiene', summary: 'The user keeps a fixed bedtime and wake time.' },
      { heading: 'no-such-section', summary: 'ignored' }
    ], root)
    assert.equal(n, 1, 'only the heading that matched was updated')
    const sections = getPageSections('sleep', root)
    assert.equal(sections[1].summary, 'The user keeps a fixed bedtime and wake time.')
    assert.equal(sections[2].summary, 'No screens late.', 'unmatched section keeps its first-line summary')
  })
})

test('the ported schema is byte-identical to the legacy one (kip#70)', () => {
  assert.equal(SCHEMA, legacyDb.SCHEMA, 'the sidecar schema and scripts/lib/db.js schema must not drift')
})

test('searchPages returns the same hits as the legacy roost on the same index (kip#70)', async (t) => {
  const root = makeTempVault()
  t.after(cleanup(root))
  t.after(() => closeWriters())

  writePage(root, 'concepts', 'sleep-hygiene', {
    type: 'concept',
    tags: ['health'],
    body: 'Consistent bedtime and no screens before bed.\n\n## Hygiene\nKeep a fixed schedule.'
  })
  writePage(root, 'entities', 'dr-smith', {
    type: 'entity',
    tags: ['doctor'],
    body: 'Discussed sleep issues and a referral to a sleep specialist.'
  })
  writePage(root, 'concepts', 'morning-routine', {
    type: 'concept',
    tags: ['habit'],
    body: 'A consistent morning routine helps with focus.'
  })
  await rebuildRoost(root)

  for (const query of ['sleep', 'sleep hygiene', 'routine', 'no match here']) {
    const ported = searchPages(query, {}, root)
    const legacy = legacyRoost.searchPages(query, {}, root)
    assert.deepEqual(ported, legacy, `"${query}" must rank identically to the legacy module`)
  }
  assert.deepEqual(
    searchPages('sleep', { type: 'entity' }, root),
    legacyRoost.searchPages('sleep', { type: 'entity' }, root),
    'the type filter must match too'
  )
  assert.deepEqual(
    searchPages('sleep', { tags: ['doctor'] }, root),
    legacyRoost.searchPages('sleep', { tags: ['doctor'] }, root),
    'the tag filter must match too'
  )
})
