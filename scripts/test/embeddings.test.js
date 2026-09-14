const test = require('node:test')
const assert = require('node:assert/strict')

const { createHashedEmbedder, getEmbedder, tokenize } = require('../lib/embeddings')

function cosine (a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

test('hashed embedder: shape, determinism, normalization', async (t) => {
  const embedder = createHashedEmbedder({ dimensions: 64 })
  assert.equal(embedder.id, 'hash-64')
  assert.equal(embedder.dimensions, 64)

  const [v] = embedder.embed(['Sleep hygiene and a consistent bedtime'])
  assert.ok(v instanceof Float32Array)
  assert.equal(v.length, 64)
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  assert.ok(Math.abs(norm - 1) < 1e-5, `expected unit vector, got norm ${norm}`)

  const [again] = embedder.embed(['Sleep hygiene and a consistent bedtime'])
  assert.deepEqual(Array.from(v), Array.from(again), 'same text -> identical vector')

  const [empty] = embedder.embed([''])
  assert.ok(Math.abs(Math.sqrt(empty.reduce((s, x) => s + x * x, 0))) < 1e-6, 'empty text -> zero vector')
})

test('hashed embedder: related text is closer than unrelated text', async () => {
  const embedder = createHashedEmbedder({ dimensions: 512 })
  const [sleep, bedtime, finance] = embedder.embed([
    'sleep hygiene and a consistent bedtime routine',
    'a consistent bedtime helps me sleep',
    'quarterly tax filing and capital gains'
  ])
  assert.ok(cosine(sleep, bedtime) > cosine(sleep, finance),
    `expected sleep~bedtime (${cosine(sleep, bedtime)}) > sleep~finance (${cosine(sleep, finance)})`)
})

test('tokenize keeps Unicode words and lowercases', () => {
  assert.deepEqual(tokenize('Größe 北京会議 foo-bar'), ['größe', '北京会議', 'foo', 'bar'])
})

test('getEmbedder: resolves hash-<n>, honours env, rejects unknown models', () => {
  assert.equal(getEmbedder('hash-128').dimensions, 128)
  assert.equal(getEmbedder().id, 'hash-256')

  const prev = process.env.KIP_EMBEDDING_MODEL
  process.env.KIP_EMBEDDING_MODEL = 'hash-32'
  try {
    assert.equal(getEmbedder().dimensions, 32)
  } finally {
    if (prev === undefined) delete process.env.KIP_EMBEDDING_MODEL
    else process.env.KIP_EMBEDDING_MODEL = prev
  }

  assert.throws(() => getEmbedder('nomic-embed-text'), /Unknown embedding model/)
})
