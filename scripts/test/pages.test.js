const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { rebuildRoost } = require('../rebuild-roost')
const { resolvePage } = require('../lib/pages')

function makeTempVault () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-pages-test-'))
  for (const dir of ['nest/entities', 'nest/concepts', 'nest/sources', 'clucks', '.roost']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  return root
}

function writePage (root, dir, slug, { type, tags = [], body = '' }) {
  const frontmatter = ['---', `type: ${type}`, 'created: 2026-01-01', 'updated: 2026-01-01', `tags: [${tags.join(', ')}]`, '---', ''].join('\n')
  fs.writeFileSync(path.join(root, 'nest', dir, `${slug}.md`), frontmatter + body + '\n')
}

test('resolvePage', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  writePage(root, 'concepts', 'sleep-hygiene', {
    type: 'concept',
    tags: ['health'],
    body: 'Notes on sleep hygiene: consistent bedtime, no screens before bed.'
  })
  rebuildRoost(root)

  await t.test('creates a new page when nothing similar exists', () => {
    const result = resolvePage({
      type: 'concept',
      title: 'Quarterly Tax Filing',
      body: 'Filed Q1 estimated taxes on this date.',
      tags: ['finance'],
      vaultRoot: root
    })
    assert.equal(result.action, 'create')
    assert.equal(result.slug, 'quarterly-tax-filing')
    assert.equal(result.path, 'nest/concepts/quarterly-tax-filing.md')

    const raw = fs.readFileSync(path.join(root, result.path), 'utf8')
    assert.ok(raw.includes('Filed Q1 estimated taxes'))
    assert.ok(raw.includes('type: concept'))
  })

  await t.test('updates the existing page for an obvious near-duplicate title', () => {
    const result = resolvePage({
      type: 'concept',
      title: 'sleep-quality',
      body: 'New note: quality matters as much as duration.',
      tags: ['health'],
      vaultRoot: root
    })
    assert.equal(result.action, 'update')
    assert.equal(result.slug, 'sleep-hygiene')
    assert.equal(result.path, 'nest/concepts/sleep-hygiene.md')

    const raw = fs.readFileSync(path.join(root, result.path), 'utf8')
    assert.ok(raw.includes('consistent bedtime'), 'original content should be preserved')
    assert.ok(raw.includes('quality matters as much as duration'), 'new content should be appended')
  })

  await t.test('does not create a second file for the near-duplicate', () => {
    assert.equal(fs.existsSync(path.join(root, 'nest', 'concepts', 'sleep-quality.md')), false)
  })
})

test('resolvePage provenance (kip-app#113)', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  writePage(root, 'concepts', 'sleep-hygiene', {
    type: 'concept',
    tags: ['health'],
    body: 'Notes on sleep hygiene: consistent bedtime, no screens before bed.'
  })
  rebuildRoost(root)

  await t.test('create writes source, source_hatched and summary into the frontmatter', () => {
    const result = resolvePage({
      type: 'source',
      title: 'Clinic Visit Notes',
      body: 'Visit notes from the sleep clinic.',
      tags: ['health'],
      vaultRoot: root,
      source: 'pages/clinic-visit.md',
      summary: 'One LLM one-liner about the visit'
    })
    assert.equal(result.action, 'create')
    const raw = fs.readFileSync(path.join(root, result.path), 'utf8')
    assert.match(raw, /source: pages\/clinic-visit\.md/)
    assert.match(raw, /source_hatched: '?\d{4}-\d{2}-\d{2}'?/)
    assert.match(raw, /summary: One LLM one-liner about the visit/)
  })

  await t.test('update refreshes the source stamp and MERGES tags only on request', () => {
    const result = resolvePage({
      type: 'concept',
      title: 'sleep-quality',
      body: 'New note: quality matters as much as duration.',
      tags: ['from-peck'],
      vaultRoot: root,
      source: 'pages/clinic-visit.md',
      mergeTags: true
    })
    assert.equal(result.action, 'update')
    assert.equal(result.slug, 'sleep-hygiene')
    assert.ok(result.tags.includes('health'), 'existing tag kept')
    assert.ok(result.tags.includes('from-peck'), 'incoming tag merged in')
    const raw = fs.readFileSync(path.join(root, result.path), 'utf8')
    assert.match(raw, /source_hatched: '?\d{4}-\d{2}-\d{2}'?/)
    const fm = require('gray-matter')(raw).data
    assert.ok(fm.tags.includes('health') && fm.tags.includes('from-peck'), 'merged tags in frontmatter')
  })

  await t.test('no source given -> frontmatter stays clean of provenance keys', () => {
    const result = resolvePage({
      type: 'concept',
      title: 'Quarterly Tax Filing',
      body: 'Filed Q1 estimated taxes on this date.',
      tags: ['finance'],
      vaultRoot: root
    })
    assert.equal(result.action, 'create')
    const raw = fs.readFileSync(path.join(root, result.path), 'utf8')
    assert.ok(!raw.includes('source:'), 'no source key')
    assert.ok(!raw.includes('summary:'), 'no summary key')
  })
})

test('person pages: schema frontmatter, email dedupe, aliases indexed (kip-app#125)', async (t) => {
  const { searchPages } = require('../lib/roost')

  await t.test('creates a person page with the contact schema', () => {
    const root = makeTempVault()
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))

    const result = resolvePage({
      type: 'person',
      title: 'Joeri De Deckere',
      body: 'Met at the CDO roundtable.',
      tags: ['work'],
      vaultRoot: root,
      person: { email: 'joeri@example.com', org: 'Acme', role: 'Chief Digital Officer', phone: '+32 000', aliases: ['CDO'] }
    })
    assert.equal(result.action, 'create')
    assert.equal(result.path, 'nest/people/joeri-de-deckere.md')
    const fm = require('gray-matter')(fs.readFileSync(path.join(root, result.path), 'utf8')).data
    assert.equal(fm.type, 'person')
    assert.equal(fm.name, 'Joeri De Deckere')
    assert.equal(fm.email, 'joeri@example.com')
    assert.equal(fm.role, 'Chief Digital Officer')
    assert.deepEqual(fm.aliases, ['CDO'])
  })

  await t.test('dedupes by canonical email across name variants', () => {
    const root = makeTempVault()
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))

    resolvePage({
      type: 'person',
      title: 'Joeri De Deckere',
      body: 'First note.',
      vaultRoot: root,
      person: { email: 'joeri@example.com', aliases: ['CDO'] }
    })
    const again = resolvePage({
      type: 'person',
      title: 'Joeri D. Deckere',
      body: 'Second note.',
      vaultRoot: root,
      person: { email: 'Joeri@Example.com', aliases: ['JDD'] }
    })
    assert.equal(again.action, 'update')
    assert.equal(again.slug, 'joeri-de-deckere')
  })

  await t.test('aliases are folded into the FTS index so Peck matches acronyms', () => {
    const root = makeTempVault()
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))

    resolvePage({
      type: 'person',
      title: 'Joeri De Deckere',
      body: 'Met at the roundtable.',
      vaultRoot: root,
      person: { email: 'joeri@example.com', role: 'Chief Digital Officer', aliases: ['CDO'] }
    })
    rebuildRoost(root)
    const hits = searchPages('CDO', { type: 'person' }, root)
    assert.equal(hits.length, 1)
    assert.equal(hits[0].slug, 'joeri-de-deckere')
  })
})
