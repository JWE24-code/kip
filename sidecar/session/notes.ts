// The read path (SPEC-1 FR-7/FR-8): `search_notes` and `read_note` as real
// tool-calling-loop tools, plus the context-assembly logic they feed.
//
// The point of this module is not to re-derive retrieval from the harness
// design's prose — it is to port Peck's hard-won fixes (`search_notes` returns
// the index, the model chooses what to read, multi-hop [[link]] expansion,
// dead-citation detection, groom-conflict injection; kip-app#106/#116/#117)
// into the model-driven loop unchanged in behavior. The refinement functions
// below are deliberate line-for-line ports of `scripts/lib/peck.js`, tested
// against the same scenarios `scripts/test/peck.test.js` treats as the spec.
//
// Retrieval itself is the P2 index: hybrid FTS5+vector when
// `scripts/lib/hybrid.js` is present (kip#71), falling back to roost's FTS5
// `searchPages` otherwise, so this module degrades instead of failing while P2
// lands. The user's own notes (`pages/`/`journals/`) are the `kb:` namespace;
// the agent's nest is `aw:` (FR-8).

import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type { Tool, ToolContext } from './loop.ts'
import type { ToolOutput } from '../protocol.ts'
// The roost index now lives in the sidecar (kip#70): reads come from the
// ported reader connection instead of requiring the retrieval-layer script.
import { searchPages, getPage, getPageSections } from '../roost/reader.ts'
import { extractWikilinkSlugs } from '../roost/query.ts'

const require = createRequire(import.meta.url)

interface RoostHit {
  slug: string
  path: string
  summary: string
  snippet: string
  score?: number
  sources?: string[]
}

interface RoostModule {
  searchPages: (
    query: string,
    options?: { type?: string | null, tags?: string[] | null, limit?: number },
    vaultRoot?: string
  ) => RoostHit[]
  getPage: (slug: string, vaultRoot?: string) => { slug: string, path: string, type?: string, summary?: string } | null
  getPageSections: (slug: string, vaultRoot?: string) => Array<{ heading: string, summary: string }>
  extractWikilinkSlugs: (text: string) => string[]
}

interface HybridModule {
  hybridSearch: (
    query: string,
    options?: { limit?: number, type?: string | null, tags?: string[] | null, vaultRoot?: string }
  ) => RoostHit[]
}

const roost: RoostModule = { searchPages, getPage, getPageSections, extractWikilinkSlugs }
const matter = require('gray-matter') as (raw: string) => { data: Record<string, unknown>, content: string }

function optionalRequire<T> (id: string): T | null {
  try {
    return require(id) as T
  } catch {
    return null
  }
}

const hybrid = optionalRequire<HybridModule>('../../scripts/lib/hybrid.js')

export const NAMESPACE = { KB: 'kb', AW: 'aw' } as const
export type Namespace = (typeof NAMESPACE)[keyof typeof NAMESPACE]
export const NOTE_NAMESPACES: Namespace[] = [NAMESPACE.KB, NAMESPACE.AW]

/** A note's fully-qualified id, `namespace:slug` (SPEC-1 FR-8). */
export function noteId (namespace: Namespace, slug: string): string {
  return `${namespace}:${slug}`
}

/** Splits `kb:foo` / `aw:foo`; a bare slug defaults to the agent workspace
 *  (`aw`) since that is where the ported nest refinements live. Returns null
 *  for an empty id or an unrecognised namespace prefix. */
export function parseNoteId (
  id: string,
  fallback: Namespace = NAMESPACE.AW
): { namespace: Namespace, slug: string } | null {
  const raw = String(id ?? '').trim()
  if (!raw) return null
  const match = raw.match(/^([A-Za-z]{2,}):(.+)$/)
  if (match) {
    const namespace = match[1].toLowerCase()
    if (namespace !== NAMESPACE.KB && namespace !== NAMESPACE.AW) return null
    return { namespace, slug: match[2].trim() }
  }
  return { namespace: fallback, slug: raw }
}

/** Resolves a slug the way roost stores it (lowercased, whitespace collapsed). */
function normalizeLookupSlug (slug: string): string {
  return String(slug).trim().toLowerCase().replace(/\s+/g, '-')
}

export interface NoteSection {
  heading: string
  summary: string
}

export interface Candidate {
  id: string
  namespace: Namespace
  slug: string
  path: string
  summary: string
  snippet: string
  sections: NoteSection[]
  score?: number
  sources?: string[]
}

export interface NoteBody {
  id: string
  namespace: Namespace
  slug: string
  type: string
  content: string
  summary: string
  sections: NoteSection[]
}

export interface SearchOptions {
  namespace?: Namespace | 'all'
  limit?: number
  vaultRoot?: string
}

export interface ReadOptions {
  vaultRoot?: string
}

export const DEFAULT_SEARCH_LIMIT = 10

// ---- Agent-workspace (nest) retrieval --------------------------------------

/** The P2 index seam: hybrid FTS5+vector when available, FTS5 otherwise. */
function searchAgentNotes (query: string, { limit, vaultRoot }: { limit: number, vaultRoot: string }): RoostHit[] {
  if (hybrid) {
    try {
      return hybrid.hybridSearch(query, { limit, vaultRoot })
    } catch (err) {
      console.error(`Warning: hybrid search failed (${(err as Error).message}); using FTS5 only.`)
    }
  }
  return roost.searchPages(query, { limit }, vaultRoot)
}

function agentCandidates (query: string, limit: number, vaultRoot: string): Candidate[] {
  return searchAgentNotes(query, { limit, vaultRoot }).map((hit) => ({
    id: noteId(NAMESPACE.AW, hit.slug),
    namespace: NAMESPACE.AW,
    slug: hit.slug,
    path: hit.path,
    summary: hit.summary || '',
    snippet: hit.snippet || '',
    sections: roost.getPageSections(hit.slug, vaultRoot),
    ...(typeof hit.score === 'number' ? { score: hit.score } : {}),
    ...(hit.sources ? { sources: hit.sources } : {})
  }))
}

// ---- User-vault (knowledge base) retrieval ---------------------------------
// P2's index is nest-only so far, so `kb:` is served by a bounded filesystem
// scan over pages/ + journals/. It returns the same Candidate shape and is
// replaced wholesale once the index covers the vault.

interface VaultNote {
  slug: string
  path: string
  title: string
  content: string
}

function listMarkdownFiles (dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listMarkdownFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

function titleOf (data: Record<string, unknown>, content: string, file: string): string {
  if (typeof data.title === 'string' && data.title.trim()) return data.title.trim()
  const heading = content.split(/\r?\n/).find((line) => /^#\s+/.test(line))
  if (heading) return heading.replace(/^#\s+/, '').trim()
  return basename(file, '.md')
}

function vaultNotes (vaultRoot: string): VaultNote[] {
  const dirs = [join(vaultRoot, 'pages'), join(vaultRoot, 'journals')]
  const notes: VaultNote[] = []
  for (const file of dirs.flatMap(listMarkdownFiles)) {
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const { data, content } = matter(raw)
    notes.push({ slug: basename(file, '.md'), path: file, title: titleOf(data, content, file), content })
  }
  return notes
}

function snippetAround (text: string, term: string): string {
  const idx = text.toLowerCase().indexOf(term.toLowerCase())
  const start = idx <= 0 ? 0 : Math.max(0, idx - 40)
  const slice = text.slice(start, start + 200).replace(/\s+/g, ' ').trim()
  return slice.length >= 200 ? `${slice.slice(0, 197)}...` : slice
}

function vaultCandidates (query: string, limit: number, vaultRoot: string): Candidate[] {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  const scored: Array<{ score: number, candidate: Candidate }> = []
  for (const note of vaultNotes(vaultRoot)) {
    const haystack = `${note.title}\n${note.content}`.toLowerCase()
    const hits = terms.filter((term) => haystack.includes(term))
    if (!hits.length) continue
    scored.push({
      score: hits.length,
      candidate: {
        id: noteId(NAMESPACE.KB, note.slug),
        namespace: NAMESPACE.KB,
        slug: note.slug,
        path: note.path,
        summary: note.title,
        snippet: snippetAround(note.content, hits[0]),
        sections: []
      }
    })
  }
  scored.sort((a, b) => b.score - a.score || a.candidate.slug.localeCompare(b.candidate.slug))
  return scored.slice(0, limit).map((entry) => {
    const candidate = entry.candidate
    return { ...candidate, score: entry.score }
  })
}

/**
 * `search_notes`: ranked candidate index across the vault (`kb:`) and the
 * agent workspace (`aw:`), each with its section index so the model can judge
 * sub-page relevance (kip-app#106). Snippets are included; the model reads
 * whichever ids look relevant with `read_note`.
 */
export function searchNotes (
  query: string,
  { namespace = 'all', limit = DEFAULT_SEARCH_LIMIT, vaultRoot = '' }: SearchOptions = {}
): Candidate[] {
  const scope = namespace || 'all'
  const out: Candidate[] = []
  if (scope === NAMESPACE.AW || scope === 'all') out.push(...agentCandidates(query, limit, vaultRoot))
  if (scope === NAMESPACE.KB || scope === 'all') out.push(...vaultCandidates(query, limit, vaultRoot))
  return out
}

// ---- Full note read --------------------------------------------------------

/** Reads one page body with its summary + section index, or null when the
 *  file is gone (a stale index row must not take the turn down — the same
 *  resilience readPageBody gives Peck). */
export function readNote (id: string, { vaultRoot = '' }: ReadOptions = {}): NoteBody | null {
  const parsed = parseNoteId(id)
  if (!parsed) return null

  if (parsed.namespace === NAMESPACE.KB) {
    const note = vaultNotes(vaultRoot).find((n) => n.slug === parsed.slug || n.slug.toLowerCase() === parsed.slug.toLowerCase())
    if (!note) return null
    return {
      id: noteId(NAMESPACE.KB, note.slug),
      namespace: NAMESPACE.KB,
      slug: note.slug,
      type: 'source',
      content: note.content.trim(),
      summary: note.title,
      sections: []
    }
  }

  let page = roost.getPage(parsed.slug, vaultRoot)
  if (!page) page = roost.getPage(normalizeLookupSlug(parsed.slug), vaultRoot)
  if (!page) return null

  let raw: string
  try {
    raw = readFileSync(join(vaultRoot, page.path), 'utf8')
  } catch (err) {
    console.error(`Warning: note ${page.path} is in the index but not on disk (${(err as Error).message}); skipping. Run rebuild-roost.`)
    return null
  }
  const { data, content } = matter(raw)
  return {
    id: noteId(NAMESPACE.AW, page.slug),
    namespace: NAMESPACE.AW,
    slug: page.slug,
    type: typeof data.type === 'string' ? data.type : (page.type || 'concept'),
    content: content.trim(),
    summary: page.summary || '',
    sections: roost.getPageSections(page.slug, vaultRoot)
  }
}

/** Reads a set of ids in order, dropping the ones that no longer resolve. */
export function readNotes (ids: string[], { vaultRoot = '' }: ReadOptions = {}): NoteBody[] {
  return ids.map((id) => readNote(id, { vaultRoot })).filter((note): note is NoteBody => note !== null)
}

// ---- Index-first selection, ported -----------------------------------------
// peck's selectCandidates handed the model the index and let it choose; here
// the model chooses by calling read_note. The safety property is identical:
// an empty or malformed selection falls back to the full candidate set, so a
// bad choice never costs recall (kip-app#106).

/** Resolves the model's chosen ids against the candidate set. Anything empty,
 *  malformed, or entirely unknown falls back to every candidate. */
export function applySelection (selectedIds: unknown, candidates: Candidate[]): Candidate[] {
  if (!Array.isArray(selectedIds) || selectedIds.length === 0) return candidates
  const bySlug = new Map(candidates.map((candidate) => [candidate.slug, candidate]))
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
  const chosen: Candidate[] = []
  const seen = new Set<string>()
  for (const raw of selectedIds) {
    if (typeof raw !== 'string') continue
    const parsed = parseNoteId(raw)
    const match = byId.get(raw) || bySlug.get(raw) || (parsed ? bySlug.get(normalizeLookupSlug(parsed.slug)) : undefined)
    if (!match || seen.has(match.id)) continue
    seen.add(match.id)
    chosen.push(match)
  }
  return chosen.length ? chosen : candidates
}

// ---- Multi-hop outbound-link expansion, ported -----------------------------
// kip-app#106 synthesis-3: follow each retrieved page's outbound [[wikilinks]]
// one hop, adding any linked page that exists and isn't already in the set.
// Deterministic and bounded; the model never drives it.

export function expandByOutboundLinks (
  pages: NoteBody[],
  vaultRoot: string,
  { limit = 10 }: { limit?: number } = {}
): NoteBody[] {
  const included = new Set(pages.map((page) => page.slug))
  const linked = new Set<string>()
  for (const page of pages) {
    for (const slug of roost.extractWikilinkSlugs(page.content || '')) {
      if (!included.has(slug)) linked.add(slug)
    }
  }
  if (!linked.size) return pages
  const out = [...pages]
  for (const slug of linked) {
    if (out.length - pages.length >= limit) break
    const note = readNote(noteId(NAMESPACE.AW, slug), { vaultRoot })
    if (!note) continue
    out.push(note)
    included.add(slug)
  }
  return out
}

// ---- Citation/evidence helpers, ported -------------------------------------

/** Which of the candidate pages the answer actually cited via [[wikilink]]. */
export function extractCitedSlugs (answerText: string, candidateSlugs: string[]): string[] {
  const linked = new Set(roost.extractWikilinkSlugs(answerText || ''))
  return candidateSlugs.filter((slug) => linked.has(slug))
}

/** A human-readable title from a slug: "sleep-hygiene" -> "sleep hygiene".
 *  Ported from peck.js `humanizeSlug` (the `sources` list's `title`). */
export function humanizeSlug (slug: string): string {
  return String(slug).replace(/-+/g, ' ').trim()
}

/** date-shaped ([[2026-08-26]]) is a valid Logseq journal ref, not a nest slug. */
const DATE_SLUG_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * [[wikilink]] targets in the answer that resolve to no page at all
 * (kip-app#117): not a candidate and not in the index. Journal date refs are
 * excluded. A dead citation is reported, never rendered as a silent broken
 * link.
 */
export function deadCitationSlugs (
  answerText: string,
  candidateSlugs: string[],
  vaultRoot: string
): string[] {
  const candidates = new Set(candidateSlugs)
  return [...new Set(roost.extractWikilinkSlugs(answerText || ''))]
    .filter((slug) => slug && !candidates.has(slug) && !DATE_SLUG_RE.test(slug) && !roost.getPage(slug, vaultRoot))
}

/** Groom's findings map (`.roost/lint.json`, written by every groom run,
 *  kip-app#116). Read-only: the read path consults it, never writes it. */
export function readLintIndex (vaultRoot: string): Record<string, Array<{ kind: string, note: string, slugs?: string[] }>> {
  try {
    const parsed = JSON.parse(readFileSync(join(vaultRoot, '.roost', 'lint.json'), 'utf8'))
    return parsed && typeof parsed.findings === 'object' && parsed.findings ? parsed.findings : {}
  } catch {
    return {}
  }
}

/** groom findings for the pages an answer cited — [{slug, kind, note}]. */
export function lintWarningsFor (
  vaultRoot: string,
  citedSlugs: string[]
): Array<{ slug: string, kind: string, note: string }> {
  if (!citedSlugs || !citedSlugs.length) return []
  const idx = readLintIndex(vaultRoot)
  const out: Array<{ slug: string, kind: string, note: string }> = []
  for (const slug of citedSlugs) {
    for (const finding of idx[slug] || []) {
      if (finding && finding.kind && finding.note) out.push({ slug, kind: finding.kind, note: finding.note })
    }
  }
  return out
}

/** groom's stored contradiction findings where BOTH pages are in the candidate
 *  set — injected into the answer context so a contested claim isn't presented
 *  as settled (kip-app#116). No LLM call: groom's already-computed output. */
export function knownConflictsFor (
  vaultRoot: string,
  candidateSlugs: string[]
): Array<{ slugs: string[], note: string }> {
  const inPlay = new Set(candidateSlugs)
  if (inPlay.size < 2) return []
  const idx = readLintIndex(vaultRoot)
  const seen = new Set<string>()
  const out: Array<{ slugs: string[], note: string }> = []
  for (const slug of candidateSlugs) {
    for (const finding of idx[slug] || []) {
      if (finding.kind !== 'contradiction' || !Array.isArray(finding.slugs) || finding.slugs.length < 2) continue
      if (!finding.slugs.every((s) => inPlay.has(s))) continue
      const key = finding.slugs.slice().sort().join('|') + '::' + finding.note
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ slugs: finding.slugs, note: finding.note })
    }
  }
  return out
}

// ---- Context assembly ------------------------------------------------------

export interface ReadContext {
  candidates: Candidate[]
  selected: Candidate[]
  pages: NoteBody[]
  candidateSlugs: string[]
  knownConflicts: Array<{ slugs: string[], note: string }>
}

export interface AssembleOptions extends SearchOptions {
  chosenIds?: unknown
  expand?: boolean
}

/**
 * The read path end to end: retrieve the candidate index, resolve the model's
 * chosen ids (falling back to the whole set), read those pages, follow their
 * outbound links one hop, and surface groom's known conflicts. This is the
 * ported `retrieveCandidates -> selectCandidates -> readPageBodies ->
 * expandByOutboundLinks -> knownConflictsFor` chain, with the LLM selection
 * replaced by the model's own read_note choices.
 */
export function assembleReadContext (query: string, options: AssembleOptions = {}): ReadContext {
  const vaultRoot = options.vaultRoot ?? ''
  const candidates = searchNotes(query, options)
  const selected = applySelection(options.chosenIds, candidates)
  const read = readNotes(selected.map((candidate) => candidate.id), { vaultRoot })
  const pages = options.expand === false ? read : expandByOutboundLinks(read, vaultRoot)
  const candidateSlugs = pages.map((page) => page.slug)
  return {
    candidates,
    selected,
    pages,
    candidateSlugs,
    knownConflicts: knownConflictsFor(vaultRoot, candidateSlugs)
  }
}

/** Answer-time evidence: which candidates were cited, which links are dead,
 *  and groom's warnings for the cited pages. */
export function answerEvidence (
  answerText: string,
  candidateSlugs: string[],
  vaultRoot: string
): {
    citedSlugs: string[]
    deadCitations: string[]
    lintWarnings: Array<{ slug: string, kind: string, note: string }>
  } {
  const citedSlugs = extractCitedSlugs(answerText, candidateSlugs)
  return {
    citedSlugs,
    deadCitations: deadCitationSlugs(answerText, candidateSlugs, vaultRoot),
    lintWarnings: lintWarningsFor(vaultRoot, citedSlugs)
  }
}

// ---- The tools -------------------------------------------------------------

export const SEARCH_NOTES_TOOL_NAME = 'search_notes'
export const READ_NOTE_TOOL_NAME = 'read_note'

export const searchNotesSchema = z.object({
  query: z.string().min(1).describe('The natural-language search query.'),
  namespace: z.enum(['all', 'kb', 'aw']).optional()
    .describe('Where to search: kb = the user\'s own notes, aw = the agent workspace (default all).'),
  limit: z.number().int().positive().max(50).optional().describe('Maximum notes to return.')
})

export const readNoteSchema = z.object({
  id: z.string().min(1).describe('A note id from search_notes, e.g. "aw:sleep-hygiene" or "kb:meeting notes".')
})

export type SearchNotesArgs = z.infer<typeof searchNotesSchema>
export type ReadNoteArgs = z.infer<typeof readNoteSchema>

function formatSearchIndex (query: string, candidates: Candidate[]): string {
  if (!candidates.length) return `No notes matched "${query}".`
  const lines = [`${candidates.length} note(s) matched "${query}":`]
  for (const candidate of candidates) {
    const sections = candidate.sections.length
      ? ` sections: ${candidate.sections.map((s) => s.heading || '(intro)').join(', ')}`
      : ''
    lines.push(`- ${candidate.id} (${candidate.summary || 'no summary'})${sections}`)
    if (candidate.snippet) lines.push(`  ${candidate.snippet.replace(/\s+/g, ' ').trim()}`)
  }
  lines.push(`Read the ones that look relevant with ${READ_NOTE_TOOL_NAME}.`)
  return lines.join('\n')
}

function formatNote (note: NoteBody): string {
  const head = [`### ${note.id} (type: ${note.type})`]
  if (note.summary) head.push(`Summary: ${note.summary}`)
  if (note.sections.length) {
    head.push(`Sections:\n${note.sections.map((s) => `- ${s.heading || '(intro)'} — ${s.summary}`).join('\n')}`)
  }
  return `${head.join('\n')}\n\n${note.content}`
}

export const SEARCH_NOTES_SPEC = {
  name: SEARCH_NOTES_TOOL_NAME,
  description: 'Search the knowledge base and the agent workspace. Returns a ranked index of notes (id, summary, section headings, snippet); read the relevant ones with read_note.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The natural-language search query.' },
      namespace: { type: 'string', enum: ['all', 'kb', 'aw'], description: 'kb = user notes, aw = agent workspace.' },
      limit: { type: 'integer', description: 'Maximum notes to return.' }
    },
    required: ['query']
  }
}

export const READ_NOTE_SPEC = {
  name: READ_NOTE_TOOL_NAME,
  description: 'Read one note in full by its id (as returned by search_notes).',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'A note id from search_notes, e.g. "aw:sleep-hygiene".' }
    },
    required: ['id']
  }
}

export interface NoteToolDeps {
  vaultRoot: string
}

/**
 * `search_notes` + `read_note` as loop tools (server/turn.ts `Tool` /
 * session/loop.ts `Tool`). Arguments are validated with the schemas above; a
 * malformed call throws so the loop reports it as a failed tool call rather
 * than silently answering from garbage.
 */
export function createNoteTools ({ vaultRoot }: NoteToolDeps): Tool[] {
  return [
    {
      spec: SEARCH_NOTES_SPEC,
      run: (args: unknown): ToolOutput => {
        const parsed = searchNotesSchema.parse(args)
        const candidates = searchNotes(parsed.query, {
          namespace: parsed.namespace ?? 'all',
          ...(parsed.limit ? { limit: parsed.limit } : {}),
          vaultRoot
        })
        return {
          text: formatSearchIndex(parsed.query, candidates),
          enrichment: { candidates: candidates.map((candidate) => candidate.slug) }
        }
      }
    },
    {
      spec: READ_NOTE_SPEC,
      run: (args: unknown, _ctx?: ToolContext): ToolOutput => {
        const parsed = readNoteSchema.parse(args)
        const note = readNote(parsed.id, { vaultRoot })
        return note
          ? { text: formatNote(note), enrichment: { candidates: [note.slug] } }
          : { text: `Note not found: ${parsed.id}` }
      }
    }
  ]
}

// Re-exported for callers that already have a TurnLoop and want the tools
// registered with their vault in one line.
export function noteToolNames (): string[] {
  return [SEARCH_NOTES_TOOL_NAME, READ_NOTE_TOOL_NAME]
}
