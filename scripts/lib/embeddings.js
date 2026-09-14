// Local, CPU-only text embeddings (AD-8, AD-16). There is no per-query cost
// and no network call: an embedder is a pure function text -> Float32Array.
//
// The default embedder is a deterministic feature-hashing vectorizer (word
// unigrams + bigrams + character trigrams, L2-normalized). It needs no model
// download and is fast enough to run synchronously at index time, which keeps
// the whole vector pipeline testable and the app's boot reconcile cheap. A
// neural bge/nomic-class model is the intended production embedder; it plugs
// in through the same `{ id, dimensions, embed(texts) }` contract (see
// getEmbedder) and a model with a different id/dimension triggers a clean
// full re-embed rather than mixing vector spaces in one table.
const crypto = require('node:crypto')

const DEFAULT_DIMENSIONS = 256
const WORD_RE = /[\p{L}\p{N}]+/gu

/** FNV-1a 32-bit — a fast, dependency-free string hash for feature hashing. */
function fnv1a (str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Lowercased word tokens; Unicode-aware so a nest in any language survives. */
function tokenize (text) {
  return String(text == null ? '' : text).toLowerCase().match(WORD_RE) || []
}

function addFeature (vec, feature, weight) {
  const h = fnv1a(feature)
  const idx = h % vec.length
  // Sign the contribution from the top hash bit — the standard hashing-trick
  // trick that keeps unrelated collisions from systematically reinforcing.
  vec[idx] += (h & 0x80000000) ? -weight : weight
}

function l2normalize (vec) {
  let sum = 0
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i]
  if (sum === 0) return vec
  const inv = 1 / Math.sqrt(sum)
  for (let i = 0; i < vec.length; i++) vec[i] *= inv
  return vec
}

function embedText (text, dimensions) {
  const vec = new Float32Array(dimensions)
  const words = tokenize(text)
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    addFeature(vec, 'w:' + w, 1)
    if (i + 1 < words.length) addFeature(vec, 'b:' + w + '_' + words[i + 1], 0.7)
    if (w.length >= 3) {
      for (let j = 0; j <= w.length - 3; j++) addFeature(vec, 'c:' + w.slice(j, j + 3), 0.4)
    }
  }
  return l2normalize(vec)
}

/**
 * The default local embedder. `dimensions` controls the hashed vector width;
 * the id folds it in so changing the width is a model change.
 */
function createHashedEmbedder ({ dimensions = DEFAULT_DIMENSIONS } = {}) {
  const dims = Math.max(16, Math.floor(dimensions))
  return {
    id: `hash-${dims}`,
    dimensions: dims,
    embed (texts) {
      return (Array.isArray(texts) ? texts : [texts]).map((t) => embedText(t, dims))
    }
  }
}

/**
 * Resolves an embedder by name. `hash-<n>` selects the built-in local
 * vectorizer; a `<name>` that isn't built in throws a clear error naming the
 * seam to implement it. The name defaults to the KIP_EMBEDDING_MODEL env var
 * so a deployment can switch models without a code change.
 */
function getEmbedder (model) {
  const name = String(model || process.env.KIP_EMBEDDING_MODEL || `hash-${DEFAULT_DIMENSIONS}`).trim()
  const hashed = /^hash-(\d+)$/.exec(name)
  if (hashed) return createHashedEmbedder({ dimensions: Number(hashed[1]) })
  throw new Error(
    `Unknown embedding model "${name}". Built-in: hash-<dimensions>. ` +
    'To add a neural model, return it from getEmbedder with the { id, dimensions, embed(texts) } contract.'
  )
}

/** True when two Float32Array vectors are close enough to be the same point. */
function sameVector (a, b) {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return false
  return true
}

/** sha1 of an embedder's identity — handy for cache keys / tests. */
function embedderKey (embedder) {
  return crypto.createHash('sha1').update(`${embedder.id}:${embedder.dimensions}`).digest('hex').slice(0, 12)
}

module.exports = {
  DEFAULT_DIMENSIONS,
  createHashedEmbedder,
  getEmbedder,
  tokenize,
  sameVector,
  embedderKey
}
