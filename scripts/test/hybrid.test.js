const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { rebuildRoost } = require('../rebuild-roost')
const { searchPages } = require('../lib/roost')
const { reciprocalRankFusion, hybridSearch, RRF_K } = require('../lib/hybrid')
const { isVectorAvailable, reconcileVectors } = require('../lib/vector-index')

const skip = !isVectorAvailable()

// A tiny deterministic "semantic" embedder: three category dimensions, by
// keyword. It lets a query ('dog') match a page that FTS cannot ('canine'),
// proving the vector half of the pipeline is actually reached and fused.
function categoryEmbedder () {
  const cats = {
    animal: ['dog', 'puppy', 'canine', 'cat', 'kitten'],
    finance: ['tax', 'capital', 'gains', 'stock', 'price'],
    sleep: ['sleep', 'bedtime', 'hygiene', 'night']
  }
  const keys = Object.keys(cats)
  return {
    id: 'fake-cat-3',
    dimensions: keys.length,
    embed (texts) {
      return (Array.isArray(texts) ? texts : [texts]).map((t) => {
        const v = new Float32Array(keys.length)
        const lower = String(t).toLowerCase()
        keys.forEach((k, i) => { for (const w of cats[k]) if (lower.includes(w)) v[i] += 1 })
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
        for (let i = 0; i < v.length; i++) v[i] /= norm
        return v
      })
    }
  }
}

function makeTempVault () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-hybrid-'))
  for (const dir of ['nest/entities', 'nest/concepts', 'nest/sources', 'clucks', '.roost']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  return root
}

function writePage (root, dir, slug, body) {
  const fm = ['---', 'type: concept', 'tags: [animal]', '---', ''].join('\n')
  fs.writeFileSync(path.join(root, 'nest', dir, `${slug}.md`), `${fm}${body}\n`)
}

test('reciprocalRankFusion: sums 1/(k+rank) and breaks ties by id', () => {
  const fused = reciprocalRankFusion([['a', 'b'], ['b', 'c']], { k: RRF_K })
  const byId = Object.fromEntries(fused.map((r) => [r.id, r.score]))
  assert.ok(Math.abs(byId.a - 1 / 61) < 1e-9)
  assert.ok(Math.abs(byId.b - (1 / 62 + 1 / 61)) < 1e-9)
  assert.equal(fused[0].id, 'b', 'b appears in both lists, so it wins')
  assert.deepEqual(reciprocalRankFusion([['a', 'b'], ['b', 'c']], { k: RRF_K, limit: 1 }), [
    { id: 'b', score: fused[0].score }
  ])
})

test('hybridSearch: falls back to the FTS ranking when there are no vectors', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writePage(root, 'concepts', 'sleep', 'Notes about sleep hygiene and bedtime.')
  rebuildRoost(root)

  const hybrid = hybridSearch('sleep', { vaultRoot: root, embedder: categoryEmbedder() })
  const fts = searchPages('sleep', {}, root)
  assert.deepEqual(hybrid.map((r) => r.slug), fts.map((r) => r.slug))
  assert.deepEqual(hybrid[0].sources, ['fts'])
})

test('hybridSearch: fuses a vector-only hit the FTS pass cannot reach (AD-8)', { skip }, async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const embedder = categoryEmbedder()
  writePage(root, 'concepts', 'pets', 'Our canine companion needs a walk every morning.')
  writePage(root, 'concepts', 'taxes', 'Quarterly capital gains and filing.')
  rebuildRoost(root)
  reconcileVectors(root, { embedder })

  const fts = searchPages('dog', {}, root)
  assert.equal(fts.length, 0, 'FTS cannot match "dog" against "canine"')

  const results = hybridSearch('dog', { vaultRoot: root, embedder })
  assert.equal(results[0].slug, 'pets')
  assert.deepEqual(results[0].sources, ['vector'])
  assert.match(results[0].snippet, /canine/i)

  // A page both halves agree on is marked as such.
  const both = hybridSearch('capital gains', { vaultRoot: root, embedder })
  assert.equal(both[0].slug, 'taxes')
  assert.ok(both[0].sources.includes('fts') || both[0].sources.includes('vector'))
})

test('hybridSearch: vector-only hits still honour type and tag filters', { skip }, async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const embedder = categoryEmbedder()
  writePage(root, 'concepts', 'pets', 'canine companion')
  rebuildRoost(root)
  reconcileVectors(root, { embedder })

  assert.equal(hybridSearch('dog', { vaultRoot: root, embedder, type: 'entity' }).length, 0)
  assert.equal(hybridSearch('dog', { vaultRoot: root, embedder, tags: ['plant'] }).length, 0)
  assert.equal(hybridSearch('dog', { vaultRoot: root, embedder, tags: ['animal'] })[0].slug, 'pets')
})
