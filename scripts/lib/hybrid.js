// Hybrid retrieval (AD-8): FTS5 lexical hits and block-vector hits are merged
// by Reciprocal Rank Fusion. RRF needs only the *rank order* of each list and
// its own scale-free constant, so it fuses bm25 rank and cosine distance
// without any score calibration. When the vector store is empty or sqlite-vec
// is unavailable the result is exactly the FTS ranking — hybrid retrieval
// degrades to the old behaviour rather than failing.
const { searchPages, getPage } = require('./roost')
const { getEmbedder } = require('./embeddings')
const { isVectorAvailable, hasVectors, vectorSearch } = require('./vector-index')
const { DEFAULT_VAULT_ROOT } = require('./paths')

// RRF's rank constant. 60 is the value from the original Cormack et al. paper
// and the one sqlite/vector-search folklore converges on; it flattens the
// influence of the very top ranks enough that a #1 hit in one list can't
// dominate a #1+#2 agreement in the other.
const RRF_K = 60

/**
 * Reciprocal Rank Fusion over ordered id lists. `rankings` is an array of
 * arrays, each best-first. Returns `[{ id, score }]` sorted by fused score
 * (ties broken deterministically by id).
 */
function reciprocalRankFusion (rankings, { k = RRF_K, limit } = {}) {
  const scores = new Map()
  for (const ranking of rankings) {
    if (!Array.isArray(ranking)) continue
    ranking.forEach((id, idx) => {
      if (id == null) return
      scores.set(id, (scores.get(id) || 0) + 1 / (k + idx + 1))
    })
  }
  let out = [...scores.entries()].map(([id, score]) => ({ id, score }))
  out.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
  if (limit) out = out.slice(0, limit)
  return out
}

/** Trims a block's text into a one-line snippet for a vector-only hit. */
function blockSnippet (hit) {
  if (!hit) return ''
  const source = hit.heading ? `${hit.heading}: ${hit.text}` : hit.text
  const line = String(source || '').replace(/\s+/g, ' ').trim()
  return line.length > 200 ? line.slice(0, 197) + '...' : line
}

/**
 * Hybrid page search: FTS5 ranking + vector ranking, fused by RRF. Returns the
 * same `{ slug, path, summary, snippet }` candidate shape as searchPages, plus
 * `score` and `sources` for callers that want to know why a page surfaced.
 *
 * `limit` is the result count; FTS and KNN each fetch a wider pool so the
 * fusion has something to work with. Vector-only pages are filtered by the
 * same type/tags predicates as the FTS pass.
 */
function hybridSearch (query, {
  limit = 10,
  type = null,
  tags = null,
  vaultRoot = DEFAULT_VAULT_ROOT,
  embedder = getEmbedder(),
  poolSize = 50
} = {}) {
  const text = String(query == null ? '' : query).trim()
  const fts = text ? searchPages(text, { type, tags, limit: Math.max(poolSize, limit) }, vaultRoot) : []
  const ftsRanking = fts.map((r) => r.slug)

  let vecRanking = []
  const vecBySlug = new Map()
  if (text && isVectorAvailable()) {
    let vectorHits = []
    try {
      if (hasVectors({ vaultRoot, embedder })) {
        const embedding = embedder.embed([text])[0]
        vectorHits = vectorSearch(embedding, { vaultRoot, embedder, limit: poolSize })
      }
    } catch (err) {
      console.error(`Warning: vector search failed (${err.message}); using FTS only.`)
      vectorHits = []
    }
    for (const hit of vectorHits) {
      if (!vecBySlug.has(hit.slug)) {
        vecBySlug.set(hit.slug, hit)
        vecRanking.push(hit.slug)
      }
    }
  }

  const rankings = vecRanking.length ? [ftsRanking, vecRanking] : [ftsRanking]
  const fused = reciprocalRankFusion(rankings, { limit: Math.max(limit, 1) * 2 })

  const ftsBySlug = new Map(fts.map((r) => [r.slug, r]))
  const results = []
  for (const { id, score } of fused) {
    const fromFts = ftsBySlug.get(id)
    if (fromFts) {
      results.push({ ...fromFts, score, sources: vecBySlug.has(id) ? ['fts', 'vector'] : ['fts'] })
      continue
    }
    const page = getPage(id, vaultRoot)
    if (!page) continue
    if (type && page.type !== type) continue
    if (Array.isArray(tags) && tags.length && !tags.some((t) => page.tags.includes(t))) continue
    results.push({
      slug: id,
      path: page.path,
      summary: page.summary,
      snippet: blockSnippet(vecBySlug.get(id)),
      score,
      sources: ['vector']
    })
  }
  return results.slice(0, limit)
}

module.exports = {
  RRF_K,
  reciprocalRankFusion,
  hybridSearch
}
