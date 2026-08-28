const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { openDb } = require('./db')
const { DEFAULT_VAULT_ROOT, nestPath, clucksPath } = require('./paths')

/**
 * Turns free text into a safe, OR-combined FTS5 MATCH expression: any page
 * containing at least one term matches, ranked by bm25 relevance (more/rarer
 * matching terms score higher). OR, not AND — this is a recall-oriented
 * retrieval layer, and callers pass full natural-language questions as well
 * as short keyword lists; ANDing every word together means a real question
 * ("what do I know about sleep?") requires "what", "do", "i", etc. to all
 * appear in the page too, which matches almost nothing.
 */
function toMatchQuery (query) {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => '"' + term.replace(/"/g, '""') + '"')
    .join(' OR ')
}

function slugify (title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function humanize (slug) {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g

/** Extracts every [[wikilink]] target from text, normalized via slugify(). Not deduped. */
function extractWikilinkSlugs (text) {
  const slugs = []
  WIKILINK_RE.lastIndex = 0
  let match
  while ((match = WIKILINK_RE.exec(text)) !== null) {
    slugs.push(slugify(match[1]))
  }
  return slugs
}

function levenshtein (a, b) {
  const m = a.length
  const n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

/** Normalized Levenshtein similarity in [0,1] (1 = identical strings). */
function slugSimilarity (a, b) {
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1)
}

// Below this similarity, two slugs are considered unrelated. Shared by
// findSimilarSlug (new-page duplicate prevention, scripts/lib/pages.js) and
// scripts/groom.js (catching near-duplicates that slipped past that check) —
// calibrated against coop/schema.md's own example: "sleep-quality" vs
// "sleep-hygiene" scores ~0.46; unrelated titles score well under 0.3.
const SIMILARITY_THRESHOLD = 0.45

/** Writes a page's metadata and body into meta.db (pages + pages_fts). */
function upsertPage (slug, filePath, type, tags, summary, body, vaultRoot = DEFAULT_VAULT_ROOT) {
  const now = new Date().toISOString()
  const db = openDb(vaultRoot)
  try {
    const existing = db.prepare('SELECT created FROM pages WHERE slug = ?').get(slug)
    const created = existing ? existing.created : now
    db.prepare(`
      INSERT INTO pages (slug, path, type, tags, summary, created, updated)
      VALUES (@slug, @path, @type, @tags, @summary, @created, @updated)
      ON CONFLICT(slug) DO UPDATE SET
        path = excluded.path,
        type = excluded.type,
        tags = excluded.tags,
        summary = excluded.summary,
        updated = excluded.updated
    `).run({
      slug,
      path: filePath,
      type,
      tags: JSON.stringify(tags || []),
      summary: summary || '',
      created,
      updated: now
    })
    db.prepare('DELETE FROM pages_fts WHERE slug = ?').run(slug)
    db.prepare('INSERT INTO pages_fts (slug, body) VALUES (?, ?)').run(slug, body || '')
  } finally {
    db.close()
  }
}

/**
 * Full-text search over page bodies, with optional type/tag filters.
 * Returns candidates ranked by FTS5 relevance: { slug, path, summary, snippet }.
 */
function searchPages (query, { type = null, tags = null, limit = 10 } = {}, vaultRoot = DEFAULT_VAULT_ROOT) {
  const match = toMatchQuery(query)
  if (!match) return []

  const db = openDb(vaultRoot)
  try {
    const needsJsFilter = Array.isArray(tags) && tags.length > 0
    const sql = `
      SELECT p.slug, p.path, p.summary, p.tags,
             snippet(pages_fts, 1, '[', ']', '...', 10) AS snippet
      FROM pages_fts
      JOIN pages p ON p.slug = pages_fts.slug
      WHERE pages_fts MATCH @match
        AND (@type IS NULL OR p.type = @type)
      ORDER BY rank
      ${needsJsFilter ? '' : 'LIMIT @limit'}
    `
    const rows = db.prepare(sql).all({ match, type, limit })
    let results = rows.map((r) => ({
      slug: r.slug,
      path: r.path,
      summary: r.summary,
      snippet: r.snippet,
      tags: JSON.parse(r.tags)
    }))
    if (needsJsFilter) {
      results = results.filter((r) => tags.some((t) => r.tags.includes(t))).slice(0, limit)
    }
    return results.map(({ slug, path: p, summary, snippet }) => ({ slug, path: p, summary, snippet }))
  } finally {
    db.close()
  }
}

/**
 * Fuzzy-matches a proposed page title against existing slugs, for duplicate
 * prevention. Returns { slug, score } (score in [0,1], 1 = identical) for the
 * closest existing page, or null if the nest has no pages yet.
 */
function findSimilarSlug (candidateTitle, vaultRoot = DEFAULT_VAULT_ROOT) {
  const db = openDb(vaultRoot)
  try {
    const candidate = slugify(candidateTitle)
    const slugs = db.prepare('SELECT slug FROM pages').all().map((r) => r.slug)
    let best = null
    for (const slug of slugs) {
      const score = slugSimilarity(candidate, slug)
      if (!best || score > best.score) best = { slug, score }
    }
    return best
  } finally {
    db.close()
  }
}

/** Returns one page's row by slug ({slug, path, type, tags, summary, created, updated}), or null. */
function getPage (slug, vaultRoot = DEFAULT_VAULT_ROOT) {
  const db = openDb(vaultRoot)
  try {
    const row = db.prepare('SELECT slug, path, type, tags, summary, created, updated FROM pages WHERE slug = ?').get(slug)
    return row ? { ...row, tags: JSON.parse(row.tags) } : null
  } finally {
    db.close()
  }
}

/** Records an event in the `log` table and appends it to coop/clucks/YYYY-MM.md. */
function appendLog (kind, title, pagesTouched = [], vaultRoot = DEFAULT_VAULT_ROOT) {
  const timestamp = new Date().toISOString()

  const db = openDb(vaultRoot)
  try {
    db.prepare('INSERT INTO log (timestamp, kind, title, pages_touched) VALUES (?, ?, ?, ?)')
      .run(timestamp, kind, title, JSON.stringify(pagesTouched))
  } finally {
    db.close()
  }

  const yearMonth = timestamp.slice(0, 7)
  const day = timestamp.slice(0, 10)
  const dir = clucksPath(vaultRoot)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${yearMonth}.md`)
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# Clucks — ${yearMonth}\n\n`)
  }
  let entry = `## [${day}] ${kind} | ${title}\n`
  if (pagesTouched.length) {
    entry += pagesTouched.map((s) => `- ${s}`).join('\n') + '\n'
  }
  fs.appendFileSync(file, entry + '\n')
}

/**
 * Rewrites coop/nest/index.md from the current `pages` table, grouped by
 * type. Human-facing browsing aid only — nothing should read this back in.
 */
function regenerateIndexMd (vaultRoot = DEFAULT_VAULT_ROOT) {
  const db = openDb(vaultRoot)
  let pages
  try {
    pages = db.prepare('SELECT slug, path, type, summary, updated FROM pages ORDER BY type, slug').all()
  } finally {
    db.close()
  }

  const sectionTitles = { entity: 'Entities', concept: 'Concepts', source: 'Sources' }
  const groups = { entity: [], concept: [], source: [] }
  for (const p of pages) {
    if (!groups[p.type]) groups[p.type] = []
    groups[p.type].push(p)
  }

  let out = '# The Nest\n\n'
  out += '_Generated by `scripts/rebuild-roost.js`. Do not hand-edit — this file is a ' +
    'browsing aid for humans in Kip, not read by any script._\n\n'

  for (const type of Object.keys(sectionTitles)) {
    out += `## ${sectionTitles[type]}\n\n`
    const items = groups[type] || []
    if (!items.length) {
      out += '_none yet_\n\n'
      continue
    }
    for (const p of items) {
      const relPath = p.path.replace(/^nest[/\\]/, '')
      const summary = p.summary ? ` — ${p.summary}` : ''
      out += `- [${humanize(p.slug)}](${relPath})${summary} (updated: ${p.updated.slice(0, 10)})\n`
    }
    out += '\n'
  }

  const dir = nestPath(vaultRoot)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.md'), out)
}

/** sha1 hex of a string — used to tell whether a source file changed since last hatch. */
function hashContent (text) {
  return crypto.createHash('sha1').update(text).digest('hex')
}

/** Map of coop-relative path -> content hash at last hatch, from `hatched_sources`. */
function hatchedSourceHashes (vaultRoot = DEFAULT_VAULT_ROOT) {
  const db = openDb(vaultRoot)
  try {
    return new Map(db.prepare('SELECT path, hash FROM hatched_sources').all().map((r) => [r.path, r.hash]))
  } finally {
    db.close()
  }
}

/** Upserts a `hatched_sources` row: this file has now been hatched at this content hash. */
function recordHatchedSource (relPath, hash, vaultRoot = DEFAULT_VAULT_ROOT) {
  const db = openDb(vaultRoot)
  try {
    db.prepare(`
      INSERT INTO hatched_sources (path, hash, hatched) VALUES (@path, @hash, @hatched)
      ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, hatched = excluded.hatched
    `).run({ path: relPath, hash, hatched: new Date().toISOString() })
  } finally {
    db.close()
  }
}

/** Returns the last n rows from the `log` table, most recent first. */
function recentClucks (n = 5, vaultRoot = DEFAULT_VAULT_ROOT) {
  const db = openDb(vaultRoot)
  try {
    return db.prepare('SELECT id, timestamp, kind, title, pages_touched FROM log ORDER BY id DESC LIMIT ?')
      .all(n)
      .map((r) => ({ ...r, pages_touched: JSON.parse(r.pages_touched) }))
  } finally {
    db.close()
  }
}

module.exports = {
  upsertPage,
  searchPages,
  findSimilarSlug,
  getPage,
  appendLog,
  regenerateIndexMd,
  recentClucks,
  hashContent,
  hatchedSourceHashes,
  recordHatchedSource,
  slugify,
  slugSimilarity,
  extractWikilinkSlugs,
  SIMILARITY_THRESHOLD
}
