const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createHashedEmbedder } = require('../lib/embeddings')
const {
  isVectorAvailable,
  indexPage,
  removePageVectors,
  countVectors,
  hasVectors,
  vectorSearch,
  reconcileVectors
} = require('../lib/vector-index')

const skip = !isVectorAvailable()

function makeTempVault () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-vec-'))
  for (const dir of ['nest/entities', 'nest/concepts', 'nest/sources', 'pages', 'journals', '.roost']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  return root
}

function writePage (root, dir, slug, body) {
  fs.writeFileSync(path.join(root, 'nest', dir, `${slug}.md`), `---\ntype: concept\n---\n\n${body}\n`)
}

test('vector index: indexes blocks and only re-embeds changed ones (AD-16)', { skip }, async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const embedder = createHashedEmbedder({ dimensions: 128 })
  const slug = 'sleep'
  const file = 'nest/concepts/sleep.md'

  const body = '- Consistent bedtime\n- No screens before bed\n- Cool dark room'
  const first = indexPage(slug, file, body, { vaultRoot: root, embedder })
  assert.deepEqual(first, { total: 3, embedded: 3, deleted: 0 })
  assert.equal(countVectors({ vaultRoot: root, embedder }), 3)
  assert.equal(hasVectors({ vaultRoot: root, embedder }), true)

  await t.test('an unchanged re-save embeds zero blocks', () => {
    const again = indexPage(slug, file, body, { vaultRoot: root, embedder })
    assert.deepEqual(again, { total: 3, embedded: 0, deleted: 0 })
  })

  await t.test('editing one block embeds exactly that block', () => {
    const edited = '- Consistent bedtime\n- No screens after 22:00\n- Cool dark room'
    const result = indexPage(slug, file, edited, { vaultRoot: root, embedder })
    assert.deepEqual(result, { total: 3, embedded: 1, deleted: 0 })
  })

  await t.test('removing a block deletes its vector', () => {
    const result = indexPage(slug, file, '- Consistent bedtime', { vaultRoot: root, embedder })
    assert.deepEqual(result, { total: 1, embedded: 0, deleted: 2 })
    assert.equal(countVectors({ vaultRoot: root, embedder }), 1)
  })

  await t.test('a whole page removal drops every block', () => {
    const n = removePageVectors(slug, { vaultRoot: root, embedder })
    assert.equal(n, 1)
    assert.equal(countVectors({ vaultRoot: root, embedder }), 0)
  })
})

test('vector index: KNN returns the nearest block', { skip }, async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const embedder = createHashedEmbedder({ dimensions: 512 })
  indexPage('sleep', 'nest/concepts/sleep.md', '- sleep hygiene and a consistent bedtime', { vaultRoot: root, embedder })
  indexPage('tax', 'nest/concepts/tax.md', '- quarterly tax filing and capital gains', { vaultRoot: root, embedder })

  const [query] = embedder.embed(['consistent bedtime sleep routine'])
  const hits = vectorSearch(query, { vaultRoot: root, embedder, limit: 2 })
  assert.ok(hits.length >= 1)
  assert.equal(hits[0].slug, 'sleep')
  assert.ok(hits[0].distance < hits[hits.length - 1].distance)
})

test('vector index: reconcile indexes disk state and prunes vanished pages', { skip }, async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const embedder = createHashedEmbedder({ dimensions: 128 })
  writePage(root, 'concepts', 'sleep', '- Consistent bedtime')
  writePage(root, 'entities', 'dr-smith', '- Discussed sleep issues')

  const first = reconcileVectors(root, { embedder })
  assert.equal(first.pages, 2)
  assert.equal(first.embedded, 2)
  assert.equal(countVectors({ vaultRoot: root, embedder }), 2)

  // Re-running is a no-op (no phantom deletes, no duplicate upserts).
  const second = reconcileVectors(root, { embedder })
  assert.equal(second.pages, 2)
  assert.equal(second.embedded, 0)
  assert.equal(second.deleted, 0)

  fs.rmSync(path.join(root, 'nest', 'entities', 'dr-smith.md'))
  const third = reconcileVectors(root, { embedder })
  assert.equal(third.pages, 1)
  assert.equal(third.deleted, 1)
  assert.equal(countVectors({ vaultRoot: root, embedder }), 1)
})

test('vector index: changing the embedding model resets the store', { skip }, async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const wide = createHashedEmbedder({ dimensions: 256 })
  const narrow = createHashedEmbedder({ dimensions: 64 })

  indexPage('sleep', 'nest/concepts/sleep.md', '- Consistent bedtime', { vaultRoot: root, embedder: wide })
  assert.equal(countVectors({ vaultRoot: root, embedder: wide }), 1)

  // Opening with a different dimension drops the old vectors rather than
  // mixing vector spaces.
  assert.equal(countVectors({ vaultRoot: root, embedder: narrow }), 0)
  assert.equal(countVectors({ vaultRoot: root, embedder: wide }), 0)
})
