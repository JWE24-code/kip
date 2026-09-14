// The deterministic, I/O-free half of the roost index, ported verbatim from
// `scripts/lib/roost.js` (kip#70, P2). Everything here is a pure string/
// array transform: query building, slugging, the normalized-Levenshtein
// dedup metric, and the section split. Keeping it pure means both the reader
// connection and the writer worker share exactly one definition of how a
// title becomes a slug and how a body becomes an index — no chance of the
// two connections disagreeing about what a page is called.

import { createHash } from 'node:crypto'

/**
 * Turns free text into a safe, OR-combined FTS5 MATCH expression: any page
 * containing at least one term matches, ranked by bm25 relevance (more/rarer
 * matching terms score higher). OR, not AND — this is a recall-oriented
 * retrieval layer, and callers pass full natural-language questions as well
 * as short keyword lists; ANDing every word together means a real question
 * ("what do I know about sleep?") requires "what", "do", "i", etc. to all
 * appear in the page too, which matches almost nothing.
 */
export function toMatchQuery (query: string): string {
  return String(query ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => '"' + term.replace(/"/g, '""') + '"')
    .join(' OR ')
}

// Keep any Unicode letter or digit — a nest can be in any language, and
// stripping to [a-z0-9] turned "Größe" into "gr-e" and "北京会議" into "" (an
// empty slug, i.e. a broken page). Punctuation and whitespace still collapse
// to a single dash. An all-punctuation / emoji title falls back to a short
// stable hash so the slug is never empty. (kip-app#97)
export function slugify (title: unknown): string {
  const s = String(title == null ? '' : title)
    .normalize('NFC')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  if (s) return s
  return 'page-' + createHash('sha1').update(String(title == null ? '' : title)).digest('hex').slice(0, 8)
}

export function humanize (slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g

/** Extracts every [[wikilink]] target from text, normalized via slugify(). Not deduped. */
export function extractWikilinkSlugs (text: string): string[] {
  const slugs: string[] = []
  WIKILINK_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = WIKILINK_RE.exec(text)) !== null) {
    slugs.push(slugify(match[1]))
  }
  return slugs
}

export function levenshtein (a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
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
export function slugSimilarity (a: string, b: string): number {
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1)
}

// Below this similarity, two slugs are considered unrelated. Shared by
// findSimilarSlug (new-page duplicate prevention, scripts/lib/pages.js) and
// scripts/groom.js (catching near-duplicates that slipped past that check) —
// calibrated against coop/schema.md's own example: "sleep-quality" vs
// "sleep-hygiene" scores ~0.46; unrelated titles score well under 0.3.
// This is the hard rule against near-duplicate pages (kip#70): the threshold
// does not move in the port.
export const SIMILARITY_THRESHOLD = 0.45

export interface Section {
  heading: string
  body: string
}

/** Splits a page body into sections on `##`/`###` headings and `_Update …`_
 *  markers — the deterministic structure that already delimits every Kip page
 *  (kip-app#106 index granularity). Leading content before the first heading
 *  becomes one section with an empty heading. Returns [{heading, body}]. */
export function splitSections (body: string): Section[] {
  const lines = String(body || '').split(/\r?\n/)
  const sections: Section[] = []
  let heading = ''
  let buf: string[] = []
  const flush = (): void => {
    const content = buf.join('\n').trim()
    if (heading || content) sections.push({ heading, body: content })
    buf = []
  }
  for (const line of lines) {
    const h = line.match(/^#{2,4}\s+(.+?)\s*$/)
    const u = line.match(/^_Update\s+\d{4}-\d{2}-\d{2}:_$/)
    if (h || u) {
      flush()
      heading = h ? h[1].trim() : line.trim()
    } else {
      buf.push(line)
    }
  }
  flush()
  return sections
}

/** A one-line first-line summary for a section body (the deterministic
 *  baseline that hatch/groom refine) — mirror of rebuild-roost's deriveSummary,
 *  but per-section. */
export function summarizeSection (body: string): string {
  const line = String(body || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'))
  if (!line) return ''
  return line.length > 120 ? line.slice(0, 117) + '...' : line
}

/** Matches a draft model's section headings to the deterministic split's rows,
 *  normalizing case/whitespace so a heading that drifted slightly still lands. */
export function normalizeHeading (heading: string): string {
  return String(heading || '').trim().toLowerCase()
}

/** sha1 hex of a string — used to tell whether a source file changed since last hatch. */
export function hashContent (text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

export interface SimilarSlug {
  slug: string
  score: number
}

/** Fuzzy-matches a proposed page title against existing slugs, for duplicate
 *  prevention. Returns { slug, score } (score in [0,1], 1 = identical) for the
 *  closest existing page, or null if the nest has no pages yet. */
export function bestSimilarSlug (candidateTitle: string, slugs: string[]): SimilarSlug | null {
  const candidate = slugify(candidateTitle)
  let best: SimilarSlug | null = null
  for (const slug of slugs) {
    const score = slugSimilarity(candidate, slug)
    if (!best || score > best.score) best = { slug, score }
  }
  return best
}
