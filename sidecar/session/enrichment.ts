// The enrichment pipeline (P5, kip#75): Hatch's propose → draft → dedup →
// write → one-commit → report flow behind one tool the turn loop can call for
// pasted text or a fetched URL.
//
// This is a wiring job, not a rewrite. Everything that made Hatch correct is
// reused unchanged from `scripts/lib/hatch.js` / `scripts/lib/pages.js`:
//   - `proposePlan` is the one-call `proposeAndDraftPages` path (propose the
//     pages a source touches AND draft every body), plus the synthesized
//     per-document trace hub and `findSimilarSlug`-based create-vs-update
//     resolution.
//   - `commitHatchPlan` writes every page via `resolvePage`, so `source::` and
//     `source_hatched::` provenance frontmatter and the dated `_Update_` append
//     are byte-identical to the CLI's output.
//   - `hatchedSourceHashes`/`recordHatchedSource` gate re-runs unchanged: the
//     same source at the same content hash touches nothing.
//
// The one thing that is new is the commit boundary. `write_agent_note` commits
// per note (one user-visible write = one commit, kip#73); an enrichment run is
// one user-visible action that usually writes several pages, so every page is
// written first and `commitAction` is called exactly once at the end — one
// commit per run, no more, no fewer.

import { createRequire } from 'node:module'
import { z } from 'zod'
import type { Tool, ToolContext } from './loop.ts'
import { knownConflictsFor } from './notes.ts'
import {
  findContradictionsInPlay,
  writeConflictReports,
  type ConflictFinding,
  type ConflictReport,
  type FlagContradictionsFn
} from './groom.ts'
import { commitAction } from '../workspace/git.ts'

const require = createRequire(import.meta.url)

interface PlanCandidate {
  type: string
  title: string
  action: 'create' | 'update'
  slug: string
  body?: string
  tags?: string[]
  summary?: string | null
  similarity?: number
  sections?: Array<{ heading: string, summary: string }>
  [key: string]: unknown
}

interface HatchModule {
  proposePlan: (
    input: { sourceTitle: string, sourceContent: string, sourceRelPath?: string | null, sourceOriginal?: string | null },
    vaultRoot: string,
    opts?: { combined?: boolean }
  ) => Promise<{ plan: PlanCandidate[], candidates: unknown[] }>
  commitHatchPlan: (
    input: {
      plan: PlanCandidate[]
      sourceTitle: string
      sourceContent: string
      sourceRelPath?: string | null
      sourceHash?: string | null
      sourceOriginal?: string | null
    },
    vaultRoot: string,
    opts?: { regenIndex?: boolean }
  ) => Promise<{ results: Array<{ action: 'create' | 'update', slug: string, path: string }>, skipped: string[] }>
}

interface RoostModule {
  hashContent: (text: string) => string
  hatchedSourceHashes: (vaultRoot?: string) => Map<string, string>
  recordHatchedSource: (relPath: string, hash: string, vaultRoot?: string) => void
  slugify: (title: string) => string
}

const hatch = require('../../scripts/lib/hatch.js') as HatchModule
const roost = require('../../scripts/lib/roost.js') as RoostModule

// ---- Source resolution (paste or fetched URL) ------------------------------

export interface EnrichInput {
  /** Raw source text to ingest (mutually exclusive with `url`). */
  text?: string
  /** A URL to fetch and ingest (mutually exclusive with `text`). */
  url?: string
  /** Optional source title; derived from the text/URL when omitted. */
  title?: string
}

export interface EnrichOptions {
  vaultRoot: string
  /** Test seam for the URL fetch; defaults to the runtime's `fetch`. */
  fetchImpl?: typeof fetch
  /** Test seam for the FR-15 contradiction check; defaults to groom's LLM fn. */
  flagFn?: FlagContradictionsFn
}

interface ResolvedSource {
  content: string
  title: string
  /** The value written as `source::` — the document's stable identity. */
  source: string
  sourceOriginal: string | null
}

/** Title from a URL: the last meaningful path segment, else the host. */
function titleFromUrl (url: string): string {
  try {
    const parsed = new URL(url)
    const segment = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '')
    const base = segment.replace(/\.(md|markdown|html?|txt)$/i, '').replace(/[-_]+/g, ' ').trim()
    if (base) return base.replace(/\b\w/g, (char) => char.toUpperCase())
    return parsed.hostname || url
  } catch {
    return url
  }
}

/** First meaningful line as a title, capped like Hatch's derived titles. */
function titleFromText (text: string): string {
  const line = String(text || '').split(/\r?\n/).map((row) => row.trim()).find((row) => row.length > 0)
  if (!line) return 'Pasted note'
  const clean = line.replace(/^#+\s*/, '')
  return clean.length > 80 ? clean.slice(0, 77) + '...' : clean
}

/** Minimal HTML → text: drop script/style, keep block breaks, strip tags and
 *  the common entities. Enough for an article body; not a browser. */
function htmlToText (html: string): string {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function resolveSource (input: EnrichInput, fetchImpl?: typeof fetch): Promise<ResolvedSource> {
  if (input.url) {
    const doFetch = fetchImpl ?? fetch
    const response = await doFetch(input.url, { redirect: 'follow' })
    if (!response || !response.ok) {
      throw new Error(`Could not fetch ${input.url}: HTTP ${response ? response.status : 'no response'}`)
    }
    const body = await response.text()
    const contentType = response.headers && typeof response.headers.get === 'function'
      ? (response.headers.get('content-type') || '')
      : ''
    const content = /html/i.test(contentType) || /^\s*</.test(body) ? htmlToText(body) : body.trim()
    if (!content) throw new Error(`Fetched ${input.url} but found no readable text`)
    return {
      content,
      title: input.title || titleFromUrl(input.url),
      source: input.url,
      sourceOriginal: input.url
    }
  }

  const text = String(input.text || '').trim()
  if (!text) throw new Error('enrich_source needs source text or a URL')
  const title = input.title || titleFromText(text)
  return {
    content: text,
    title,
    // A paste has no filename, so its stable identity is a synthetic
    // `paste/<slug>.md` path — the same value re-used as `source::`. The
    // content hash, not the path, decides whether it changed.
    source: `paste/${roost.slugify(title)}.md`,
    sourceOriginal: null
  }
}

// ---- The pipeline ----------------------------------------------------------

export interface EnrichConflict {
  slugs: string[]
  note: string
}

export interface EnrichResult {
  status: 'enriched' | 'unchanged' | 'empty'
  /** The `source::` value this run was keyed on. */
  source: string
  title: string
  hash: string
  created: string[]
  updated: string[]
  skipped: string[]
  conflicts: EnrichConflict[]
  /** The `nest/conflicts/` report pages written for the conflicts above. */
  conflictReports: ConflictReport[]
  commit: string | null
  committed: boolean
  /** The plain-language summary the turn loop hands back in chat. */
  report: string
}

function summarize (result: Omit<EnrichResult, 'report'>): string {
  if (result.status === 'unchanged') {
    return `Already enriched "${result.title}" from ${result.source} — unchanged since the last run, nothing to do.`
  }
  if (result.status === 'empty') {
    return `Tried to enrich "${result.title}" from ${result.source}, but no usable pages came back — nothing written. Re-run to retry.`
  }

  const counts: string[] = []
  if (result.created.length) counts.push(`created ${result.created.length} page${result.created.length === 1 ? '' : 's'}`)
  if (result.updated.length) counts.push(`updated ${result.updated.length} page${result.updated.length === 1 ? '' : 's'}`)
  if (result.skipped.length) counts.push(`skipped ${result.skipped.length} empty page${result.skipped.length === 1 ? '' : 's'}`)

  const lines = [`Enriched "${result.title}" from ${result.source}: ${counts.join(', ') || 'nothing new'}.`]
  for (const slug of result.created) lines.push(`- created [[${slug}]]`)
  for (const slug of result.updated) lines.push(`- updated [[${slug}]]`)
  for (const slug of result.skipped) lines.push(`- skipped [[${slug}]] (the model returned an empty body)`)
  for (const conflict of result.conflicts) {
    lines.push(`- possible conflict between ${conflict.slugs.map((slug) => `[[${slug}]]`).join(' and ')}: ${conflict.note}`)
  }
  for (const report of result.conflictReports) {
    lines.push(`- wrote [[${report.slug}]] linking ${report.slugs.map((slug) => `[[${slug}]]`).join(' and ')}`)
  }
  lines.push(result.committed
    ? `Committed the whole run as ${String(result.commit).slice(0, 12)} (one commit).`
    : 'Nothing to commit.')
  return lines.join('\n')
}

/**
 * The enrichment entry point: turn a paste or a fetched URL into nest pages,
 * committing the whole run exactly once. Re-running an unchanged source is a
 * no-op (the content-hash gate), and provenance frontmatter is written by the
 * ported `resolvePage` unchanged.
 */
export async function enrichSource (input: EnrichInput, { vaultRoot, fetchImpl, flagFn }: EnrichOptions): Promise<EnrichResult> {
  const source = await resolveSource(input, fetchImpl)
  const hash = roost.hashContent(source.content)

  // Content-hash gate, unchanged from Hatch: the same source at the same hash
  // is already in the nest — touch nothing.
  if (roost.hatchedSourceHashes(vaultRoot).get(source.source) === hash) {
    const base = {
      status: 'unchanged' as const,
      source: source.source,
      title: source.title,
      hash,
      created: [],
      updated: [],
      skipped: [],
      conflicts: [] as EnrichConflict[],
      conflictReports: [] as ConflictReport[],
      commit: null,
      committed: false
    }
    return { ...base, report: summarize(base) }
  }

  const { plan } = await hatch.proposePlan({
    sourceTitle: source.title,
    sourceContent: source.content,
    sourceRelPath: source.source,
    sourceOriginal: source.sourceOriginal
  }, vaultRoot)

  if (!plan.length) {
    const base = {
      status: 'empty' as const,
      source: source.source,
      title: source.title,
      hash,
      created: [],
      updated: [],
      skipped: [],
      conflicts: [] as EnrichConflict[],
      conflictReports: [] as ConflictReport[],
      commit: null,
      committed: false
    }
    return { ...base, report: summarize(base) }
  }

  // Writes every page + regenerates the index, but touches no git.
  const { results, skipped } = await hatch.commitHatchPlan({
    plan,
    sourceTitle: source.title,
    sourceContent: source.content,
    sourceRelPath: source.source,
    sourceHash: hash,
    sourceOriginal: source.sourceOriginal
  }, vaultRoot)

  if (!results.length) {
    const base = {
      status: 'empty' as const,
      source: source.source,
      title: source.title,
      hash,
      created: [],
      updated: [],
      skipped,
      conflicts: [] as EnrichConflict[],
      conflictReports: [] as ConflictReport[],
      commit: null,
      committed: false
    }
    return { ...base, report: summarize(base) }
  }

  // Record the source as handled only once it produced pages, so a failed run
  // retries instead of being silently marked done (same rule as Hatch).
  roost.recordHatchedSource(source.source, hash, vaultRoot)

  const touched = [...new Set(results.map((result) => result.slug))]

  // FR-13/FR-15 contradiction-check step, now live (kip#76): run Groom's
  // batch-scoped pass over the pages this run put in play — AD-9's ≤6 ceiling,
  // unchanged — and fold in whatever the last full groom already recorded in
  // `.roost/lint.json` (read-only). Detected contradictions become
  // `nest/conflicts/` reports, written before the single commit so the whole
  // run, reports included, is one user-visible action.
  const detected = await findContradictionsInPlay(vaultRoot, touched, flagFn ? { flagFn } : {})
  const conflicts = mergeConflicts(detected, knownConflictsFor(vaultRoot, touched))
  const conflictReports = writeConflictReports(vaultRoot, conflicts)

  // The single commit boundary for the whole run (kip#73's git wiring).
  const commit = await commitAction({ vaultRoot, message: `enrich_source: ${source.title}` })

  const base = {
    status: 'enriched' as const,
    source: source.source,
    title: source.title,
    hash,
    created: results.filter((result) => result.action === 'create').map((result) => result.slug),
    updated: results.filter((result) => result.action === 'update').map((result) => result.slug),
    skipped,
    conflicts,
    conflictReports,
    commit: commit.sha,
    committed: commit.committed
  }
  return { ...base, report: summarize(base) }
}

/**
 * Folds the live batch check and the last groom's stored findings into one
 * de-duplicated, `{ slugs, note }` list, keyed on the pair. The live description
 * wins when both sources name the same pair.
 */
function mergeConflicts (live: ConflictFinding[], stored: ConflictFinding[]): EnrichConflict[] {
  const seen = new Set<string>()
  const out: EnrichConflict[] = []
  for (const conflict of [...live, ...stored]) {
    const slugs = [...new Set((conflict.slugs || []).filter((slug) => typeof slug === 'string' && slug.length > 0))]
    if (slugs.length < 2) continue
    const key = slugs.slice().sort().join('|')
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ slugs, note: String(conflict.note ?? conflict.description ?? '') })
  }
  return out
}

// ---- The tool --------------------------------------------------------------

export const ENRICH_SOURCE_TOOL_NAME = 'enrich_source'

export const enrichSourceSchema = z.object({
  text: z.string().min(1).optional().describe('Raw source text to ingest (a paste).'),
  url: z.string().min(1).optional().describe('A URL to fetch and ingest.'),
  title: z.string().min(1).optional().describe('Optional source title; derived from the text or URL when omitted.')
}).strict().refine((value) => Boolean(value.text) !== Boolean(value.url), {
  message: 'provide exactly one of text or url'
})

export type EnrichSourceArgs = z.infer<typeof enrichSourceSchema>

export const ENRICH_SOURCE_SPEC = {
  name: ENRICH_SOURCE_TOOL_NAME,
  description: 'Ingest a pasted document or a fetched URL into the agent workspace (the nest): propose the pages it touches, draft each body, write provenance, and commit the whole run once. Returns a plain-language summary.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Raw source text to ingest (mutually exclusive with url).' },
      url: { type: 'string', description: 'A URL to fetch and ingest (mutually exclusive with text).' },
      title: { type: 'string', description: 'Optional source title; derived from the text or URL when omitted.' }
    }
  }
}

export interface EnrichToolDeps {
  vaultRoot: string
  fetchImpl?: typeof fetch
  flagFn?: FlagContradictionsFn
}

/**
 * `enrich_source` as a loop tool. Arguments are validated with the strict
 * paste-or-URL schema; a malformed call throws so the loop reports a failed
 * tool call rather than writing anything.
 */
export function createEnrichTools ({ vaultRoot, fetchImpl, flagFn }: EnrichToolDeps): Tool[] {
  return [
    {
      spec: ENRICH_SOURCE_SPEC,
      run: async (args: unknown, _ctx?: ToolContext): Promise<string> => {
        const parsed = enrichSourceSchema.parse(args)
        const result = await enrichSource(parsed, {
          vaultRoot,
          ...(fetchImpl ? { fetchImpl } : {}),
          ...(flagFn ? { flagFn } : {})
        })
        return result.report
      }
    }
  ]
}

export function enrichToolNames (): string[] {
  return [ENRICH_SOURCE_TOOL_NAME]
}
