// The write path (P4, kip#73): `write_agent_note` and `update_agent_note` as
// real tool-calling-loop tools, wrapping the ported `resolvePage` create-vs-
// update semantics and the commit-per-action git workspace.
//
// The safety rules ported here unchanged from `scripts/lib/pages.js`
// (`resolvePage`) and `scripts/lib/peck.js` (`fileAnswerToNest`):
//   - create-vs-update is resolved by `findSimilarSlug` (AD-10): a near-
//     duplicate title updates the existing page instead of creating a second
//     one, so old filed answers keep resolving to the same slug.
//   - an update appends under a dated `_Update YYYY-MM-DD:_` section rather
//     than overwriting (valid Logseq output, never a raw clobber).
//   - retrieved-but-uncited pages are appended as a `## Sources` footer
//     (kip-app#117), and the one-line summary is mirrored into frontmatter so
//     a rebuild keeps it (kip-app#115).
//
// The vault boundary (SPEC-1 Acceptance D) is enforced at the schema and
// dispatch layer, not by convention: neither schema has a filesystem-path
// field (both are `.strict()`, so an unexpected `path` is rejected outright),
// and an update target is resolved from the index by id — the raw string is
// never turned into a path. `pages/` (the user's own notes) is read-only and
// no tool here can name it.

import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Tool, ToolContext } from './loop.ts'
import type { ToolOutput } from '../protocol.ts'
import { commitAction } from '../workspace/git.ts'

const require = createRequire(import.meta.url)

interface ResolvePageArgs {
  type: string
  title: string
  body: string
  tags?: string[]
  vaultRoot?: string
  summary?: string | null
  mergeTags?: boolean
}

interface ResolvePageResult {
  action: 'create' | 'update'
  slug: string
  path: string
  type: string
  tags: string[]
}

interface PageRow {
  slug: string
  path: string
  type: string
  tags: string[]
  summary: string
}

interface PagesModule {
  resolvePage: (args: ResolvePageArgs) => ResolvePageResult
}

interface RoostModule {
  getPage: (slug: string, vaultRoot?: string) => PageRow | null
  upsertPage: (
    slug: string,
    filePath: string,
    type: string,
    tags: string[],
    summary: string,
    body: string,
    vaultRoot?: string
  ) => void
  regenerateIndexMd: (vaultRoot?: string) => void
  extractWikilinkSlugs: (text: string) => string[]
  slugify: (title: string) => string
}

const pages = require('../../scripts/lib/pages.js') as PagesModule
const roost = require('../../scripts/lib/roost.js') as RoostModule
const matter = require('gray-matter') as {
  (raw: string): { data: Record<string, unknown>, content: string }
  stringify: (content: string, data?: Record<string, unknown>) => string
}

export const WRITE_AGENT_NOTE_TOOL_NAME = 'write_agent_note'
export const UPDATE_AGENT_NOTE_TOOL_NAME = 'update_agent_note'

const NOTE_TYPES = ['concept', 'entity', 'source', 'person'] as const

// A note body is prose plus optional `sources` — never a path. `.strict()`
// rejects any unexpected key (a caller trying to smuggle `path`, `file`, or a
// `pages/`-rooted target fails validation instead of being ignored).
export const writeNoteSchema = z.object({
  title: z.string().min(1).describe('The note title. A near-duplicate title updates the existing note instead of creating a second one.'),
  body: z.string().min(1).describe('The note body, as Logseq markdown.'),
  type: z.enum(NOTE_TYPES).optional().describe('Page type (default concept).'),
  tags: z.array(z.string()).optional().describe('Tags to add; on an update they merge with the existing tags.'),
  summary: z.string().optional().describe('A one-line summary, mirrored into the note frontmatter.'),
  sources: z.array(z.string()).optional().describe('Retrieved-but-uncited note slugs, appended as a ## Sources footer.')
}).strict()

export const updateNoteSchema = z.object({
  id: z.string().min(1).describe('The note to update, e.g. "aw:sleep-hygiene" or "sleep-hygiene" (agent workspace only).'),
  body: z.string().min(1).describe('The new content, appended under a dated _Update_ section.'),
  tags: z.array(z.string()).optional().describe('Tags to merge into the note.'),
  summary: z.string().optional().describe('A replacement one-line summary (omit to keep the existing one).'),
  sources: z.array(z.string()).optional().describe('Retrieved-but-uncited note slugs, appended as a ## Sources footer.')
}).strict()

export type WriteNoteArgs = z.infer<typeof writeNoteSchema>
export type UpdateNoteArgs = z.infer<typeof updateNoteSchema>

/** `aw:foo` or a bare `foo` -> `foo`; a `kb:` (user vault) id is refused. */
export function resolveAgentNoteSlug (id: string): string {
  const raw = String(id ?? '').trim()
  if (!raw) throw new Error('update_agent_note requires a non-empty note id')
  const match = raw.match(/^([A-Za-z]{2,}):(.+)$/)
  if (match) {
    const namespace = match[1].toLowerCase()
    if (namespace !== 'aw') {
      throw new Error(`update_agent_note only writes the agent workspace (aw:), not "${namespace}:"`)
    }
    return match[2].trim()
  }
  return raw
}

function today (): string {
  return new Date().toISOString().slice(0, 10)
}

function trimmedLines (text: string): string[] {
  return String(text || '').split(/\r?\n/).map((line) => line.trim())
}

/** First meaningful body line as a one-line summary, capped like peck's. */
function deriveSummary (body: string): string {
  const line = trimmedLines(body).find((l) => l.length > 0 && !l.startsWith('#'))
  if (!line) return ''
  const clean = line.replace(/^\*\*Q:\*\*\s*/, '')
  return clean.length > 200 ? clean.slice(0, 197) + '...' : clean
}

/** The `## Sources` footer for retrieved pages the body didn't cite inline
 *  (kip-app#117). Ported from fileAnswerToNest unchanged. */
function sourcesFooter (body: string, sources: string[] | undefined): string {
  const cited = new Set(roost.extractWikilinkSlugs(body))
  const alsoRetrieved = (sources || []).filter((slug) => slug && !cited.has(roost.slugify(slug)))
  if (!alsoRetrieved.length) return ''
  return `\n\n## Sources\n\nAlso retrieved, not cited: ${alsoRetrieved.map((s) => `[[${s}]]`).join(', ')}`
}

/** Refresh the index row for a just-written file and rewrite the catalog, the
 *  same post-write sync fileAnswerToNest does. Returns the file's body without
 *  frontmatter (what `upsertPage` indexes). */
function syncIndex (result: ResolvePageResult, summary: string, vaultRoot: string): void {
  const filePath = join(vaultRoot, result.path)
  const { content } = matter(readFileSync(filePath, 'utf8'))
  roost.upsertPage(result.slug, result.path, result.type, result.tags, summary, content, vaultRoot)
  roost.regenerateIndexMd(vaultRoot)
}

/** Writes the curated summary back into frontmatter so a rebuild-roost reads
 *  it instead of degrading it to the first body line (kip-app#115). */
function mirrorSummary (relPath: string, summary: string, vaultRoot: string): void {
  if (!summary) return
  const filePath = join(vaultRoot, relPath)
  const { data, content } = matter(readFileSync(filePath, 'utf8'))
  if (data.summary === summary) return
  data.summary = summary
  writeFileSync(filePath, matter.stringify(content, data))
}

export interface WriteResult {
  action: 'create' | 'update'
  slug: string
  id: string
  path: string
  commit: string | null
  committed: boolean
}

/**
 * `write_agent_note`: create a note, or update the near-duplicate the title
 * resolves to (resolvePage's AD-10 rule), then commit exactly once.
 */
export async function writeAgentNote (args: unknown, vaultRoot: string): Promise<WriteResult> {
  const parsed = writeNoteSchema.parse(args)
  const body = `${parsed.body.trim()}${sourcesFooter(parsed.body, parsed.sources)}`

  const result = pages.resolvePage({
    type: parsed.type ?? 'concept',
    title: parsed.title,
    body,
    tags: parsed.tags ?? [],
    mergeTags: true,
    vaultRoot
  })

  // Keep an existing page's curated summary on update; derive one from the
  // body on create or when the caller gave none (fileAnswerToNest's rule).
  const existing = result.action === 'update' ? roost.getPage(result.slug, vaultRoot) : null
  const summary = parsed.summary
    ?? (existing && existing.summary ? existing.summary : deriveSummary(parsed.body))

  mirrorSummary(result.path, summary, vaultRoot)
  syncIndex(result, summary, vaultRoot)

  const committed = await commitAction({
    vaultRoot,
    message: `${WRITE_AGENT_NOTE_TOOL_NAME}: ${result.action} ${result.slug}`
  })
  return {
    action: result.action,
    slug: result.slug,
    id: `aw:${result.slug}`,
    path: result.path,
    commit: committed.sha,
    committed: committed.committed
  }
}

/**
 * `update_agent_note`: append a dated section to one existing note, resolved
 * by id from the index — never a raw path. Commits exactly once.
 */
export async function updateAgentNote (args: unknown, vaultRoot: string): Promise<WriteResult> {
  const parsed = updateNoteSchema.parse(args)
  const slug = resolveAgentNoteSlug(parsed.id)
  const page = roost.getPage(slug, vaultRoot) ?? roost.getPage(roost.slugify(slug), vaultRoot)
  if (!page) throw new Error(`No agent note to update: ${parsed.id}`)

  const filePath = join(vaultRoot, page.path)
  const { data, content } = matter(readFileSync(filePath, 'utf8'))

  const date = today()
  const existingTags = Array.isArray(data.tags) ? data.tags : (data.tags ? [data.tags] : [])
  data.updated = date
  if (parsed.tags && parsed.tags.length) data.tags = [...new Set([...existingTags, ...parsed.tags])]
  if (parsed.summary) data.summary = parsed.summary

  const appended = `${content.trimEnd()}\n\n---\n_Update ${date}:_\n\n${parsed.body.trim()}${sourcesFooter(parsed.body, parsed.sources)}\n`
  writeFileSync(filePath, matter.stringify(appended, data))

  const summary = parsed.summary || page.summary || deriveSummary(parsed.body)
  syncIndex(
    { action: 'update', slug: page.slug, path: page.path, type: page.type, tags: Array.isArray(data.tags) ? data.tags : [] },
    summary,
    vaultRoot
  )

  const committed = await commitAction({
    vaultRoot,
    message: `${UPDATE_AGENT_NOTE_TOOL_NAME}: ${page.slug}`
  })
  return {
    action: 'update',
    slug: page.slug,
    id: `aw:${page.slug}`,
    path: page.path,
    commit: committed.sha,
    committed: committed.committed
  }
}

// ---- The tools -------------------------------------------------------------

export const WRITE_AGENT_NOTE_SPEC = {
  name: WRITE_AGENT_NOTE_TOOL_NAME,
  description: 'Write a note into the agent workspace (the nest). A title that matches an existing note updates it with a dated section instead of creating a duplicate. Returns the note id and commit.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The note title.' },
      body: { type: 'string', description: 'The note body, as Logseq markdown.' },
      type: { type: 'string', enum: [...NOTE_TYPES], description: 'Page type (default concept).' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags to add.' },
      summary: { type: 'string', description: 'A one-line summary mirrored into frontmatter.' },
      sources: { type: 'array', items: { type: 'string' }, description: 'Retrieved-but-uncited note slugs for the ## Sources footer.' }
    },
    required: ['title', 'body']
  }
}

export const UPDATE_AGENT_NOTE_SPEC = {
  name: UPDATE_AGENT_NOTE_TOOL_NAME,
  description: 'Append new content under a dated section of an existing agent-workspace note, resolved by its id. Returns the note id and commit.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The note id, e.g. "aw:sleep-hygiene".' },
      body: { type: 'string', description: 'The new content to append.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags to merge into the note.' },
      summary: { type: 'string', description: 'A replacement one-line summary (omit to keep the existing one).' },
      sources: { type: 'array', items: { type: 'string' }, description: 'Retrieved-but-uncited note slugs for the ## Sources footer.' }
    },
    required: ['id', 'body']
  }
}

export interface WriteToolDeps {
  vaultRoot: string
}

/**
 * `write_agent_note` + `update_agent_note` as loop tools. Arguments are
 * validated with the `.strict()` schemas above; a malformed or path-shaped
 * call throws so the loop reports a failed tool call — it can never reach the
 * filesystem as an arbitrary path.
 */
export function createWriteTools ({ vaultRoot }: WriteToolDeps): Tool[] {
  return [
    {
      spec: WRITE_AGENT_NOTE_SPEC,
      run: async (args: unknown, _ctx?: ToolContext): Promise<ToolOutput> => {
        const result = await writeAgentNote(args, vaultRoot)
        return {
          text: `Wrote ${result.id} (${result.action}) at ${result.path}; committed ${result.commit ? result.commit.slice(0, 12) : 'nothing to commit'}.`,
          enrichment: { write: { action: result.action, slug: result.slug } }
        }
      }
    },
    {
      spec: UPDATE_AGENT_NOTE_SPEC,
      run: async (args: unknown, _ctx?: ToolContext): Promise<ToolOutput> => {
        const result = await updateAgentNote(args, vaultRoot)
        return {
          text: `Updated ${result.id} at ${result.path}; committed ${result.commit ? result.commit.slice(0, 12) : 'nothing to commit'}.`,
          enrichment: { write: { action: result.action, slug: result.slug } }
        }
      }
    }
  ]
}

export function writeToolNames (): string[] {
  return [WRITE_AGENT_NOTE_TOOL_NAME, UPDATE_AGENT_NOTE_TOOL_NAME]
}
