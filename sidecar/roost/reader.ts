// The roost read path (kip#70, AD-4): a separate, long-lived connection that
// serves every read — search, page fetch, sections, clucks — while the writer
// worker holds the write connection. Read-only and WAL-backed, so a read is
// always a consistent snapshot and never waits on an in-flight write.
//
// The function signatures and return shapes are the ones `scripts/lib/roost.js`
// exposes, so `sidecar/session/notes.ts` and the ported tests call the
// reader with the same arguments they always did.

import { openReaderConnection, DEFAULT_VAULT_ROOT, type DatabaseConnection } from './schema.ts'
import { bestSimilarSlug, toMatchQuery, type SimilarSlug } from './query.ts'

export interface SearchHit {
  slug: string
  path: string
  summary: string
  snippet: string
}

export interface SearchOptions {
  type?: string | null
  tags?: string[] | null
  limit?: number
}

export interface PageRow {
  slug: string
  path: string
  type: string
  tags: string[]
  summary: string
  created: string
  updated: string
}

export interface PageSection {
  heading: string
  summary: string
}

export interface LogRow {
  id: number
  timestamp: string
  kind: string
  title: string
  pages_touched: string[]
}

// One connection per database file, reused across calls. The reader is
// deliberately not closed after every query: opening SQLite in a hot loop is
// the difference between single-digit-ms search and tens of ms (NFR-1).
const connections = new Map<string, DatabaseConnection>()

function readerFor (vaultRoot: string): DatabaseConnection | null {
  const key = String(vaultRoot)
  const cached = connections.get(key)
  if (cached) return cached
  const db = openReaderConnection(vaultRoot)
  if (db) connections.set(key, db)
  return db
}

/** Closes the cached reader for one coop (test/teardown use). */
export function closeReader (vaultRoot: string = DEFAULT_VAULT_ROOT): void {
  const key = String(vaultRoot)
  const db = connections.get(key)
  if (!db) return
  connections.delete(key)
  try {
    db.close()
  } catch {
    // already closed
  }
}

/** Closes every cached reader connection (test/teardown use). */
export function closeAllReaders (): void {
  for (const db of connections.values()) {
    try {
      db.close()
    } catch {
      // already closed
    }
  }
  connections.clear()
}

/**
 * Full-text search over page bodies, with optional type/tag filters.
 * Returns candidates ranked by FTS5 relevance: { slug, path, summary, snippet }.
 */
export function searchPages (
  query: string,
  { type = null, tags = null, limit = 10 }: SearchOptions = {},
  vaultRoot: string = DEFAULT_VAULT_ROOT
): SearchHit[] {
  const match = toMatchQuery(query)
  if (!match) return []
  const db = readerFor(vaultRoot)
  if (!db) return []

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
  const rows = db.prepare(sql).all({ match, type, limit }) as Array<{
    slug: string
    path: string
    summary: string
    tags: string
    snippet: string
  }>
  let results: Array<SearchHit & { tags: string[] }> = rows.map((r) => ({
    slug: r.slug,
    path: r.path,
    summary: r.summary,
    snippet: r.snippet,
    tags: JSON.parse(r.tags) as string[]
  }))
  if (needsJsFilter) {
    results = results.filter((r) => (tags as string[]).some((t) => r.tags.includes(t))).slice(0, limit)
  }
  return results.map(({ slug, path: p, summary, snippet }) => ({ slug, path: p, summary, snippet }))
}

/**
 * Fuzzy-matches a proposed page title against existing slugs, for duplicate
 * prevention. Returns { slug, score } (score in [0,1], 1 = identical) for the
 * closest existing page, or null if the nest has no pages yet. The normalized-
 * Levenshtein threshold is untouched (kip#70): the closest page always wins,
 * and callers compare its score against SIMILARITY_THRESHOLD.
 */
export function findSimilarSlug (
  candidateTitle: string,
  vaultRoot: string = DEFAULT_VAULT_ROOT
): SimilarSlug | null {
  const db = readerFor(vaultRoot)
  if (!db) return null
  const slugs = (db.prepare('SELECT slug FROM pages').all() as Array<{ slug: string }>).map((r) => r.slug)
  return bestSimilarSlug(candidateTitle, slugs)
}

/** Returns one page's row by slug, or null. */
export function getPage (
  slug: string,
  vaultRoot: string = DEFAULT_VAULT_ROOT
): PageRow | null {
  const db = readerFor(vaultRoot)
  if (!db) return null
  const row = db.prepare(
    'SELECT slug, path, type, tags, summary, created, updated FROM pages WHERE slug = ?'
  ).get(slug) as (Omit<PageRow, 'tags'> & { tags: string }) | undefined
  return row ? { ...row, tags: JSON.parse(row.tags) as string[] } : null
}

/** One page's section index — [{heading, summary}] in body order (kip-app#106). */
export function getPageSections (
  slug: string,
  vaultRoot: string = DEFAULT_VAULT_ROOT
): PageSection[] {
  const db = readerFor(vaultRoot)
  if (!db) return []
  return db.prepare(
    'SELECT heading, summary FROM sections WHERE slug = ? ORDER BY seq'
  ).all(slug) as PageSection[]
}

/** Map of coop-relative path -> content hash at last hatch, from `hatched_sources`. */
export function hatchedSourceHashes (
  vaultRoot: string = DEFAULT_VAULT_ROOT
): Map<string, string> {
  const db = readerFor(vaultRoot)
  if (!db) return new Map()
  return new Map(
    (db.prepare('SELECT path, hash FROM hatched_sources').all() as Array<{ path: string, hash: string }>)
      .map((r) => [r.path, r.hash])
  )
}

/** Returns the last n rows from the `log` table, most recent first. */
export function recentClucks (
  n = 5,
  vaultRoot: string = DEFAULT_VAULT_ROOT
): LogRow[] {
  const db = readerFor(vaultRoot)
  if (!db) return []
  return (db.prepare(
    'SELECT id, timestamp, kind, title, pages_touched FROM log ORDER BY id DESC LIMIT ?'
  ).all(n) as Array<Omit<LogRow, 'pages_touched'> & { pages_touched: string }>)
    .map((r) => ({ ...r, pages_touched: JSON.parse(r.pages_touched) as string[] }))
}
