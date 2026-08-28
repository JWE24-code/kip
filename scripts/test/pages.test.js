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
