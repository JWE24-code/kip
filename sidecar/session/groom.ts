// Groom's batch contradiction check, ported into context assembly (P5, kip#76).
//
// Groom's contradiction detection is already correctly scoped: candidate pages
// are batched (≤6, primarily by type, sub-split by shared tags) and each batch
// goes through one LLM call. Full-vault pairwise detection is unrealistic
// (ADD-1 AD-9), and this module keeps that ceiling — only the integration point
// is new. The algorithm itself is not re-derived here; it is the same functions
// `scripts/groom.js` exports, invoked live from the sidecar's context assembly
// and enrichment paths instead of only from the standalone CLI health check.
//
// Two entry points:
//   - `runQuickGroom` — the whole quick pass (orphans, drift, near-duplicate
//     slugs, stale-since-hatch sources, batched contradictions), writing
//     `.roost/lint.json` exactly as the CLI does. The read path's
//     `knownConflictsFor`/`lintWarningsFor` then consume that read-only.
//   - `findContradictionsInPlay` — the batch pass scoped to the pages a turn or
//     an enrichment run actually has in play, run live so a contested claim is
//     caught as soon as the pages are written rather than at the next groom.
//
// A detected contradiction is written to `nest/conflicts/<a>-<b>.md` — a report
// page whose `[[a]]`/`[[b]]` links resolve to the two pages (FR-15). Groom
// itself still never edits a `nest/` page; the report is *new* content produced
// by the enrichment path, not a mutation of the contradicted pages.

import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

interface PromptsModule {
  flagContradictions: (
    pages: Array<{ slug: string, type: string, content: string }>,
    vaultRoot: string
  ) => Promise<Array<{ slugs?: unknown, description?: unknown }>>
}

interface GroomModule {
  runGroom: (
    vaultRoot: string,
    options: { deep: boolean, flagFn: FlagContradictionsFn }
  ) => Promise<QuickGroomReport>
  writeLintJson: (vaultRoot: string, report: QuickGroomReport) => string
  buildContradictionGroups: <T extends { type: string, tags: string[] }>(pages: T[], maxSize?: number) => T[][]
}

interface RoostModule {
  getPage: (slug: string, vaultRoot?: string) => { slug: string, path: string } | null
}

interface DbModule {
  openDb: (vaultRoot: string) => {
    prepare: (sql: string) => { all: (...params: unknown[]) => Array<Record<string, unknown>>, get: (...params: unknown[]) => Record<string, unknown> | undefined }
    close: () => void
  }
}

interface PathsModule {
  nestPath: (vaultRoot?: string) => string
}

const groom = require('../../scripts/groom.js') as GroomModule
const prompts = require('../../scripts/lib/prompts.js') as PromptsModule
const roost = require('../../scripts/lib/roost.js') as RoostModule
const { openDb } = require('../../scripts/lib/db.js') as DbModule
const paths = require('../../scripts/lib/paths.js') as PathsModule

/** AD-9's stated ceiling: one LLM call per batch of at most this many pages. */
export const MAX_CONTRADICTION_BATCH = 6

/** A page as the contradiction check reads it: slug + type/tags (for batching)
 *  plus the body that is put in front of the model. */
export interface ContradictionPage {
  slug: string
  type: string
  tags: string[]
  body: string
}

export interface Contradiction {
  slugs: string[]
  description: string
}

/** The LLM call is injectable so tests never touch a provider and the loop can
 *  supply its own routing later (kip#79). Defaults to groom's own prompt fn. */
export type FlagContradictionsFn = (
  pages: Array<{ slug: string, type: string, content: string }>,
  vaultRoot: string
) => Promise<Array<{ slugs?: unknown, description?: unknown, note?: unknown }>> | Array<{ slugs?: unknown, description?: unknown, note?: unknown }>

export interface QuickGroomReport {
  deep: boolean
  orphans: string[]
  drift: { missingFiles: Array<{ slug: string, path: string }>, untrackedFiles: string[] }
  nearDuplicates: Array<{ slugs: string[], score: number }>
  changedSources: string[]
  contradictions: Contradiction[]
}

/** A finding that may come either from the live check (`description`) or from a
 *  groom-written lint entry (`note`). */
export interface ConflictFinding {
  slugs: string[]
  note?: string
  description?: string
}

export interface ConflictReport {
  /** The report page's slug, e.g. `conflict-salary-2025-salary-2026`. */
  slug: string
  /** Coop-relative path, `nest/conflicts/<slug>.md`. */
  path: string
  /** The two pages the report links, in canonical (sorted) order. */
  slugs: string[]
  note: string
}

function flagger (flagFn?: FlagContradictionsFn): FlagContradictionsFn {
  return flagFn ?? (prompts.flagContradictions as FlagContradictionsFn)
}

function noteOf (conflict: ConflictFinding): string {
  return String(conflict.note ?? conflict.description ?? '')
}

// ---- The quick pass --------------------------------------------------------

/**
 * Runs Groom's quick-mode structural checks and batch-scoped contradiction pass
 * over the whole nest — the exact algorithm `scripts/groom.js` runs from the
 * CLI — and (by default) writes `.roost/lint.json` so the read path can consult
 * the findings read-only (kip-app#116). Nothing here writes a `nest/` page.
 */
export async function runQuickGroom (
  vaultRoot: string,
  { flagFn, writeLint = true }: { flagFn?: FlagContradictionsFn, writeLint?: boolean } = {}
): Promise<QuickGroomReport> {
  const report = await groom.runGroom(vaultRoot, { deep: false, flagFn: flagger(flagFn) })
  if (writeLint) groom.writeLintJson(vaultRoot, report)
  return report
}

// ---- The live, in-play check -----------------------------------------------

/** The in-play pages as the contradiction check needs them: type/tags from the
 *  index, body from the full-text table. Unknown slugs are dropped (a stale id
 *  must not take the check down). */
function readPagesForContradiction (vaultRoot: string, slugs: string[]): ContradictionPage[] {
  const wanted = [...new Set(slugs.filter((slug) => typeof slug === 'string' && slug.length > 0))]
  if (!wanted.length) return []
  const db = openDb(vaultRoot)
  try {
    const placeholders = wanted.map(() => '?').join(', ')
    const rows = db.prepare(`SELECT slug, type, tags FROM pages WHERE slug IN (${placeholders})`).all(...wanted)
    const bodies = new Map(
      db.prepare('SELECT slug, body FROM pages_fts').all().map((row) => [String(row.slug), String(row.body)])
    )
    return rows.map((row) => ({
      slug: String(row.slug),
      type: String(row.type),
      tags: JSON.parse(String(row.tags || '[]')) as string[],
      body: bodies.get(String(row.slug)) ?? ''
    }))
  } finally {
    db.close()
  }
}

function dedupeContradictions (list: Contradiction[]): Contradiction[] {
  const seen = new Set<string>()
  const out: Contradiction[] = []
  for (const conflict of list) {
    const key = conflict.slugs.slice().sort().join('|') + '::' + conflict.description.slice(0, 40)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(conflict)
  }
  return out
}

/**
 * Runs Groom's batched contradiction pass over exactly the pages in play,
 * returning only contradictions between pages that shared a batch. This is the
 * AD-9 ceiling applied to context assembly: a page outside the batches built
 * from `slugs` is never compared, so nothing outside the turn's scope is
 * surfaced. The batching itself is `scripts/groom.js`'s, unchanged.
 */
export async function findContradictionsInPlay (
  vaultRoot: string,
  slugs: string[],
  { flagFn, maxBatchSize = MAX_CONTRADICTION_BATCH }: { flagFn?: FlagContradictionsFn, maxBatchSize?: number } = {}
): Promise<Contradiction[]> {
  const pages = readPagesForContradiction(vaultRoot, slugs)
  if (pages.length < 2) return []

  const flag = flagger(flagFn)
  const groups = groom.buildContradictionGroups(pages, maxBatchSize)
  const out: Contradiction[] = []

  for (const group of groups) {
    const inBatch = new Set(group.map((page) => page.slug))
    const forPrompt = group.map((page) => ({ slug: page.slug, type: page.type, content: page.body }))
    let found: Array<{ slugs?: unknown, description?: unknown, note?: unknown }>
    try {
      found = (await flag(forPrompt, vaultRoot)) || []
    } catch (err) {
      console.error(`Warning: contradiction check failed for a batch of ${group.length} page(s) (${(err as Error).message}); skipping.`)
      continue
    }
    for (const candidate of found) {
      const foundSlugs = Array.isArray(candidate.slugs)
        ? candidate.slugs.filter((slug): slug is string => typeof slug === 'string' && slug.length > 0)
        : []
      // Only a contradiction between pages that were actually batched together
      // counts — the model cannot widen the scope past AD-9's ceiling.
      if (foundSlugs.length < 2 || !foundSlugs.every((slug) => inBatch.has(slug))) continue
      out.push({
        slugs: [...new Set(foundSlugs)],
        description: String(candidate.description ?? candidate.note ?? '')
      })
    }
  }
  return dedupeContradictions(out)
}

// ---- Conflict reports (FR-15) ----------------------------------------------

/** Deterministic report slug for a pair — two pages always map to one report,
 *  no matter which side is named first. */
export function conflictReportSlug (slugs: string[]): string {
  return `conflict-${[...new Set(slugs)].sort().join('-')}`
}

function renderConflictReport (slugs: string[], note: string, date: string): string {
  const links = slugs.map((slug) => `[[${slug}]]`).join(' and ')
  const summary = `Possible contradiction between ${links}`
  return [
    '---',
    'type: concept',
    'tags: [conflict]',
    `created: ${date}`,
    `updated: ${date}`,
    `summary: ${JSON.stringify(summary)}`,
    '---',
    '',
    `# ${summary}`,
    '',
    note || 'These pages appear to state conflicting facts.',
    ''
  ].join('\n')
}

/**
 * Writes one `nest/conflicts/<a>-<b>.md` report per contradiction, linking both
 * pages with `[[slug]]` so the links resolve to the actual nest pages. A
 * contradiction whose pages no longer exist in the index is skipped rather than
 * written with a dead link. Idempotent: the same pair always overwrites the
 * same report path.
 */
export function writeConflictReports (
  vaultRoot: string,
  conflicts: ConflictFinding[],
  { date = new Date().toISOString().slice(0, 10) }: { date?: string } = {}
): ConflictReport[] {
  const dir = join(paths.nestPath(vaultRoot), 'conflicts')
  const seen = new Set<string>()
  const out: ConflictReport[] = []

  for (const conflict of conflicts) {
    const slugs = [...new Set((conflict.slugs || []).filter((slug) => typeof slug === 'string' && slug.length > 0))]
    // Only link pages that exist, so every [[link]] in the report resolves.
    // Sorted so the same pair always renders the same report, whichever side
    // the model named first.
    const resolvable = slugs.filter((slug) => roost.getPage(slug, vaultRoot)).sort()
    if (resolvable.length < 2) continue

    const pair = resolvable.slice(0, 2)
    const slug = conflictReportSlug(pair)
    if (seen.has(slug)) continue
    seen.add(slug)

    mkdirSync(dir, { recursive: true })
    const relPath = `nest/conflicts/${slug}.md`
    writeFileSync(join(vaultRoot, relPath), renderConflictReport(pair, noteOf(conflict), date))
    out.push({ slug, path: relPath, slugs: pair, note: noteOf(conflict) })
  }
  return out
}
