const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { rebuildRoost } = require('../rebuild-roost')
const { searchPages, findSimilarSlug, getPage, appendLog, recentClucks, regenerateIndexMd, slugify } = require('../lib/roost')

function makeTempVault () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-test-'))
  for (const dir of ['nest/entities', 'nest/concepts', 'nest/sources', 'clucks', '.roost']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  return root
}

function writePage (root, dir, slug, { type, tags = [], body = '' }) {
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
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

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

  const result = rebuildRoost(root)
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
    assert.equal(page.slug, 'sleep-hygiene')
    assert.equal(page.path, 'nest/concepts/sleep-hygiene.md')
    assert.equal(page.type, 'concept')
    assert.deepEqual(page.tags, ['health', 'sleep'])
    assert.equal(getPage('does-not-exist', root), null)
  })

  await t.test('appendLog writes to the log table and the month file', () => {
    appendLog('hatch', 'Test hatch', ['sleep-hygiene'], root)
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

  await t.test('regenerateIndexMd writes a readable, grouped index', () => {
    regenerateIndexMd(root)
    const contents = fs.readFileSync(path.join(root, 'nest', 'index.md'), 'utf8')
    assert.ok(contents.includes('title:: The Nest'))
    assert.ok(contents.includes('## Concepts'))
    assert.ok(contents.includes('Sleep Hygiene'))
    assert.ok(contents.includes('## Entities'))
    assert.ok(contents.includes('Dr Smith'))
  })

  await t.test('rebuildRoost is safely re-runnable and drops stale pages', () => {
    fs.rmSync(path.join(root, 'nest', 'concepts', 'morning-routine.md'))
    const second = rebuildRoost(root)
    assert.equal(second.indexed, 2)
    const results = searchPages('routine', {}, root)
    assert.equal(results.length, 0, 'deleted page should no longer be searchable')
  })
})
