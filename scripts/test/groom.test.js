const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { rebuildRoost } = require('../rebuild-roost')
const {
  runGroom,
  findOrphans,
  findDrift,
  findNearDuplicates,
  findBrokenLinks,
  findDeadEnds,
  findMissingLinkCandidates,
  buildContradictionGroups,
  buildMergePairs,
  buildEntitySourceGroups,
  findContradictions,
  writeGroomReport
} = require('../groom')
const { reviewPageCoherence } = require('../lib/prompts')
const { saveLLMConfig } = require('../lib/llm')

function makeTempVault () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-groom-test-'))
  for (const dir of ['nest/entities', 'nest/concepts', 'nest/sources', 'clucks', '.roost']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  return root
}

function writePage (root, dir, slug, { type, tags = [], body = '', summary }) {
  const fm = ['---', `type: ${type}`, 'created: 2026-01-01', 'updated: 2026-01-01', `tags: [${tags.join(', ')}]`]
  if (summary) fm.push(`summary: ${JSON.stringify(summary)}`)
  fm.push('---', '')
  fs.writeFileSync(path.join(root, 'nest', dir, `${slug}.md`), fm.join('\n') + body + '\n')
}

test('findOrphans', () => {
  const pages = [
    { slug: 'a', body: 'links to [[b]] and [[Some Other Page]]' },
    { slug: 'b', body: 'no links here' },
    { slug: 'c', body: 'self-referential only: [[c]]' }
  ]
  const orphans = findOrphans(pages)
  assert.ok(!orphans.includes('b'), 'b is linked from a, should not be orphan')
  assert.ok(orphans.includes('a'), 'a has no inbound links, should be orphan')
  assert.ok(orphans.includes('c'), 'a self-link does not count as inbound from another page')
})

test('findDrift', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  writePage(root, 'concepts', 'tracked', { type: 'concept', body: 'a tracked page' })
  rebuildRoost(root)

  const dbPages = [{ slug: 'tracked', path: 'nest/concepts/tracked.md' }]

  await t.test('clean coop has no drift', () => {
    const drift = findDrift(root, dbPages)
    assert.deepEqual(drift.missingFiles, [])
    assert.deepEqual(drift.untrackedFiles, [])
  })

  await t.test('catches a meta.db row with no file on disk', () => {
    const staleDbPages = [...dbPages, { slug: 'ghost', path: 'nest/concepts/ghost.md' }]
    const drift = findDrift(root, staleDbPages)
    assert.equal(drift.missingFiles.length, 1)
    assert.equal(drift.missingFiles[0].slug, 'ghost')
  })

  await t.test('catches a file on disk with no meta.db row', () => {
    writePage(root, 'concepts', 'untracked', { type: 'concept', body: 'never rebuilt' })
    const drift = findDrift(root, dbPages) // dbPages doesn't know about "untracked"
    assert.equal(drift.untrackedFiles.length, 1)
    assert.ok(drift.untrackedFiles[0].includes('untracked.md'))
  })
})

test('findNearDuplicates catches the schema.md example pair', () => {
  const dbPages = [
    { slug: 'sleep-hygiene' },
    { slug: 'sleep-quality' },
    { slug: 'quarterly-tax-filing' }
  ]
  const dupes = findNearDuplicates(dbPages)
  assert.equal(dupes.length, 1)
  assert.deepEqual(dupes[0].slugs.sort(), ['sleep-hygiene', 'sleep-quality'])
})

test('buildContradictionGroups', async (t) => {
  await t.test('drops singleton types (nothing to compare)', () => {
    const pages = [{ slug: 'only-one', type: 'source', tags: [] }]
    assert.deepEqual(buildContradictionGroups(pages), [])
  })

  await t.test('groups a small type as one batch', () => {
    const pages = [
      { slug: 'a', type: 'concept', tags: [] },
      { slug: 'b', type: 'concept', tags: [] }
    ]
    const groups = buildContradictionGroups(pages)
    assert.equal(groups.length, 1)
    assert.equal(groups[0].length, 2)
  })

  await t.test('sub-splits an oversized type by shared tags, no group over the max', () => {
    const pages = []
    for (let i = 0; i < 8; i++) {
      pages.push({ slug: `p${i}`, type: 'concept', tags: [i < 4 ? 'health' : 'finance'] })
    }
    const groups = buildContradictionGroups(pages)
    const totalPages = groups.reduce((sum, g) => sum + g.length, 0)
    assert.ok(groups.every((g) => g.length <= 6), 'no group should exceed the max batch size')
    assert.equal(totalPages, 8, 'every page should end up in exactly one group')
  })
})

test('findContradictions aggregates across groups using an injected stub', async () => {
  const pages = [
    { slug: 'a', type: 'concept', tags: [], body: 'A says X.' },
    { slug: 'b', type: 'concept', tags: [], body: 'B says not X.' }
  ]
  let callCount = 0
  const stub = async (group) => {
    callCount++
    assert.ok(group.every((p) => 'slug' in p && 'content' in p), 'stub should receive slug/content-shaped pages')
    return [{ slugs: ['a', 'b'], description: 'A and B disagree about X.' }]
  }
  const found = await findContradictions(pages, undefined, stub)
  assert.equal(callCount, 1)
  assert.equal(found.length, 1)
  assert.deepEqual(found[0].slugs, ['a', 'b'])
})

test('findBrokenLinks flags [[targets]] with no page, but not date refs', () => {
  const pages = [
    { slug: 'a', body: 'links [[b]] and [[No Such Page]] and journal [[2026-08-26]]' },
    { slug: 'b', body: 'fine' }
  ]
  const broken = findBrokenLinks(pages)
  assert.equal(broken.length, 1)
  assert.equal(broken[0].slug, 'a')
  assert.deepEqual(broken[0].badTargets, ['no-such-page'])
})

test('findDeadEnds flags pages that link out to nothing existing', () => {
  const pages = [
    { slug: 'hub', body: 'see [[leaf]]' },
    { slug: 'leaf', body: 'no outbound links' },
    { slug: 'stray', body: 'only [[missing-thing]]' }
  ]
  assert.deepEqual(findDeadEnds(pages).sort(), ['leaf', 'stray'])
})

test('findMissingLinkCandidates: prose mention of another page without a wikilink', () => {
  const pages = [
    { slug: 'visit', body: 'Met with Dr Alvarez about the sleep plan.' },
    { slug: 'dr-alvarez', body: 'A physician.' },
    { slug: 'already', body: 'Talked to [[dr-alvarez]] again.' }
  ]
  const cands = findMissingLinkCandidates(pages)
  const visit = cands.find((c) => c.slug === 'visit')
  assert.ok(visit && visit.candidates.includes('dr-alvarez'))
  assert.ok(!cands.some((c) => c.slug === 'already'), 'a page that already links is not a candidate')
})

test('buildMergePairs pairs same-type pages sharing a rare tag, skipping slug near-dups', () => {
  const pages = [
    { slug: 'dr-alvarez', type: 'entity', tags: ['clinic'], body: 'see [[visit-notes]]' },
    { slug: 'alvarez-clinic', type: 'entity', tags: ['clinic'], body: 'see [[visit-notes]]' },
    { slug: 'unrelated', type: 'entity', tags: ['food'], body: '' }
  ]
  const pairs = buildMergePairs(pages, [])
  assert.equal(pairs.length, 1)
  assert.deepEqual(pairs[0].map((p) => p.slug).sort(), ['alvarez-clinic', 'dr-alvarez'])
})

test('buildEntitySourceGroups groups each entity with the sources that cite it', () => {
  const pages = [
    { slug: 'dr-alvarez', type: 'entity', body: '' },
    { slug: 'never-cited', type: 'concept', body: '' },
    { slug: 'visit-1', type: 'source', body: 'saw [[dr-alvarez]]' },
    { slug: 'visit-2', type: 'source', body: 'saw [[dr-alvarez]] again' }
  ]
  const groups = buildEntitySourceGroups(pages)
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].map((p) => p.slug), ['dr-alvarez', 'visit-1', 'visit-2'])
})

test('runGroom --deep runs the extra checks via injected stubs and writeGroomReport builds a checklist', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const longHistory = 'x'.repeat(420) +
    '\n\n_Update 2026-07-01:_\n\nSlept 8h on average.\n\n_Update 2026-08-01:_\n\nNow only 6h on average.'
  writePage(root, 'concepts', 'sleep', { type: 'concept', tags: ['health'], summary: 'A stub about sleep', body: longHistory })
  writePage(root, 'entities', 'dr-alvarez', { type: 'entity', tags: ['clinic'], body: 'Physician. See [[visit-notes]]. Discussed sleep.' })
  writePage(root, 'entities', 'alvarez-clinic', { type: 'entity', tags: ['clinic'], body: 'The practice. See [[visit-notes]].' })
  writePage(root, 'sources', 'visit-notes', { type: 'source', body: 'Saw [[dr-alvarez]] at [[alvarez-clinic]] about [[sleep]]. Also links [[ghost-page]].' })
  rebuildRoost(root)

  const deps = {
    reviewPageCoherence: async (slug) => slug === 'sleep'
      ? { issues: ['the 07 section says 8h, the 08 section says 6h without noting the change'], consolidate: true }
      : { issues: [], consolidate: false },
    checkSummaryAccuracy: async (slug) => slug === 'sleep'
      ? { ok: false, suggested: 'Sleep tracking; average dropped from 8h to 6h over summer 2026' }
      : { ok: true, suggested: '' },
    confirmMissingLinks: async (_slug, _body, candidates) => candidates,
    checkPagesSameSubject: async () => ({ same: true, reason: 'both describe the same practice/physician' })
  }

  const report = await runGroom(root, { deep: true, flagFn: async () => [], deps })

  assert.equal(report.deep, true)
  assert.ok(report.pageCoherence.some((c) => c.slug === 'sleep'))
  assert.ok(report.summaryDrift.some((s) => s.slug === 'sleep'))
  assert.ok(report.mergeCandidates.length >= 1)
  assert.ok(report.brokenLinks.some((b) => b.badTargets.includes('ghost-page')))
  assert.ok(Array.isArray(report.deadEnds))
  assert.ok(Array.isArray(report.missingLinks))

  const file = writeGroomReport(root, report)
  assert.ok(fs.existsSync(file))
  const md = fs.readFileSync(file, 'utf8')
  assert.match(md, /^# Groom report/)
  assert.match(md, /## Page coherence \(1\)/)
  assert.match(md, /- \[ \] \*\*sleep\*\*/)
  assert.match(md, /## Broken links \(1\)/)
})

test('deep-groom prompt fns fall back to a safe default on unusable output', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  const original = global.fetch
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: 'not json at all' }, finish_reason: 'stop' }] })
  })
  try {
    assert.deepEqual(await reviewPageCoherence('x', 'some body', root), { issues: [], consolidate: false })
  } finally {
    global.fetch = original
  }
})

test('runGroom end-to-end with an injected contradiction stub', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  writePage(root, 'concepts', 'sleep-hygiene', { type: 'concept', tags: ['health'], body: 'Sleep hygiene notes.' })
  writePage(root, 'concepts', 'sleep-quality', { type: 'concept', tags: ['health'], body: 'Sleep quality notes, links to [[sleep-hygiene]].' })
  rebuildRoost(root)

  const stub = async () => [{ slugs: ['sleep-hygiene', 'sleep-quality'], description: 'stubbed contradiction' }]
  const report = await runGroom(root, { flagFn: stub })

  assert.ok(report.orphans.includes('sleep-quality'), 'nothing links to sleep-quality')
  assert.ok(!report.orphans.includes('sleep-hygiene'), 'sleep-hygiene is linked from sleep-quality')
  assert.equal(report.drift.missingFiles.length, 0)
  assert.equal(report.drift.untrackedFiles.length, 0)
  assert.equal(report.nearDuplicates.length, 1)
  assert.equal(report.contradictions.length, 1)
})
