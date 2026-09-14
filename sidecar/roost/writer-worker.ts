// The writer worker (kip#70, AD-4). This thread owns the single writable
// better-sqlite3 connection to meta.db. Every mutation in the process is
// funnelled through here, so SQLite's one-writer rule is structurally true
// rather than a convention — and a long batch (a rebuild at boot, a watcher
// burst) runs off the main thread, so a concurrent read never waits on it.
//
// WAL mode (set by `openWriterConnection`) is what makes the read/write split
// safe: the writer's transaction is invisible until commit, and readers
// continue against the last snapshot meanwhile.

import { parentPort, workerData } from 'node:worker_threads'
import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { createRequire } from 'node:module'

import { openWriterConnection, type DatabaseConnection } from './schema.ts'
import {
  splitSections,
  summarizeSection,
  normalizeHeading,
  humanize
} from './query.ts'

const require = createRequire(import.meta.url)
const matter = require('gray-matter') as (raw: string) => { data: Record<string, unknown>, content: string }
const paths = require('../../scripts/lib/paths.js') as {
  nestPath: (vaultRoot?: string) => string
  clucksPath: (vaultRoot?: string) => string
  DIR_TYPES: Record<string, string>
}

interface WriterRequest {
  id: number
  op: string
  args: unknown[]
}

interface WriterResponse {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

const vaultRoot = String((workerData as { vaultRoot?: string } | undefined)?.vaultRoot ?? '')
if (!vaultRoot) throw new Error('roost writer worker requires a vaultRoot')

const db: DatabaseConnection = openWriterConnection(vaultRoot)

const PRUNE_GRACE_MS = 48 * 60 * 60 * 1000

/**
 * Writes a page's metadata and body into meta.db (pages + pages_fts + sections).
 * `aliases` (name variants/acronyms for `person` pages, kip-app#125) are
 * folded into the FTS body so Peck matches them without polluting the page's
 * own summary/snippet source.
 */
function upsertPage (
  slug: string,
  filePath: string,
  type: string,
  tags: string[],
  summary: string,
  body: string,
  aliases: string[] = []
): void {
  const now = new Date().toISOString()
  const existing = db.prepare('SELECT created FROM pages WHERE slug = ?').get(slug) as { created: string } | undefined
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
  const aliasText = (Array.isArray(aliases) ? aliases : []).filter(Boolean).join(' ')
  const searchable = aliasText ? `${body || ''}\n${aliasText}` : (body || '')
  db.prepare('INSERT INTO pages_fts (slug, body) VALUES (?, ?)').run(slug, searchable)
  // The per-section index (kip-app#106): re-derived from the body on every
  // write, so it never drifts from the file. First-line summaries only —
  // hatch/groom can refine them via setSectionSummaries later.
  db.prepare('DELETE FROM sections WHERE slug = ?').run(slug)
  const insertSection = db.prepare('INSERT INTO sections (slug, seq, heading, summary) VALUES (?, ?, ?, ?)')
  splitSections(body).forEach((s, i) => insertSection.run(slug, i, s.heading, summarizeSection(s.body)))
}

/** Removes a page from meta.db entirely (pages + pages_fts + sections). */
function removePage (slug: string): boolean {
  const info = db.prepare('DELETE FROM pages WHERE slug = ?').run(slug)
  db.prepare('DELETE FROM pages_fts WHERE slug = ?').run(slug)
  db.prepare('DELETE FROM sections WHERE slug = ?').run(slug)
  return info.changes > 0
}

/** Updates just the `summary` column for one page (kip-app#115). */
function setPageSummary (slug: string, summary: string): boolean {
  return db.prepare('UPDATE pages SET summary = ?, updated = ? WHERE slug = ?')
    .run(summary || '', new Date().toISOString(), slug).changes > 0
}

/** Overwrites a page's per-section summaries, matched by heading (kip-app#106). */
function setSectionSummaries (slug: string, summaries: Array<{ heading?: unknown, summary?: unknown }>): number {
  if (!Array.isArray(summaries) || !summaries.length) return 0
  const rows = db.prepare('SELECT seq, heading FROM sections WHERE slug = ? ORDER BY seq').all(slug) as Array<{ seq: number, heading: string }>
  const byHeading = new Map(rows.map((r) => [normalizeHeading(r.heading), r]))
  const update = db.prepare('UPDATE sections SET summary = ? WHERE slug = ? AND seq = ?')
  let n = 0
  for (const s of summaries) {
    if (!s || typeof s.heading !== 'string' || typeof s.summary !== 'string') continue
    const summary = s.summary.trim()
    if (!s.heading.trim() || !summary) continue
    const row = byHeading.get(normalizeHeading(s.heading))
    if (row) {
      update.run(summary, slug, row.seq)
      n++
    }
  }
  return n
}

/** Records an event in the `log` table and appends it to coop/clucks/YYYY-MM.md. */
function appendLog (kind: string, title: string, pagesTouched: string[] = []): void {
  const timestamp = new Date().toISOString()
  db.prepare('INSERT INTO log (timestamp, kind, title, pages_touched) VALUES (?, ?, ?, ?)')
    .run(timestamp, kind, title, JSON.stringify(pagesTouched))

  const yearMonth = timestamp.slice(0, 7)
  const day = timestamp.slice(0, 10)
  const dir = paths.clucksPath(vaultRoot)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${yearMonth}.md`)
  if (!existsSync(file)) {
    writeFileSync(file, `# Clucks — ${yearMonth}\n\n`)
  }
  let entry = `## [${day}] ${kind} | ${title}\n`
  if (pagesTouched.length) {
    entry += pagesTouched.map((s) => `- ${s}`).join('\n') + '\n'
  }
  appendFileSync(file, entry + '\n')
}

/** Rewrites coop/nest/index.md from the current `pages` table, grouped by type. */
function regenerateIndexMd (): void {
  const pages = db.prepare('SELECT slug, path, type, summary, updated FROM pages ORDER BY type, slug')
    .all() as Array<{ slug: string, path: string, type: string, summary: string, updated: string }>

  const sectionTitles: Record<string, string> = { entity: 'Entities', concept: 'Concepts', source: 'Sources' }
  const groups: Record<string, typeof pages> = { entity: [], concept: [], source: [] }
  for (const p of pages) {
    if (!groups[p.type]) groups[p.type] = []
    groups[p.type].push(p)
  }

  let out = 'title:: The Nest\n\n'
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

  const dir = paths.nestPath(vaultRoot)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.md'), out)
}

/** A row whose file is missing prunes only after this long (kip-app#113). */
function recordHatchedSource (relPath: string, hash: string): void {
  db.prepare(`
    INSERT INTO hatched_sources (path, hash, hatched) VALUES (@path, @hash, @hatched)
    ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, hatched = excluded.hatched
  `).run({ path: relPath, hash, hatched: new Date().toISOString() })

  const cutoff = Date.now() - PRUNE_GRACE_MS
  const rows = db.prepare('SELECT path, hatched FROM hatched_sources WHERE path != ?').all(relPath) as Array<{ path: string, hatched: string }>
  for (const row of rows) {
    if (Date.parse(row.hatched || '') > cutoff) continue
    const abs = join(vaultRoot, row.path)
    if (existsSync(abs)) continue
    if (!existsSync(dirname(abs))) continue
    db.prepare('DELETE FROM hatched_sources WHERE path = ?').run(row.path)
  }
}

function deriveSummary (content: string): string {
  const paragraph = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'))
  if (!paragraph) return ''
  return paragraph.length > 200 ? paragraph.slice(0, 197) + '...' : paragraph
}

/**
 * Rebuilds meta.db from the markdown under coop/nest/ (the source of truth):
 * upserts every page, drops rows whose file vanished, then regenerates
 * nest/index.md. The ported `rebuildRoost` from scripts/rebuild-roost.js, now
 * running on the writer thread so a boot reconcile never blocks a read.
 */
function rebuild (): { indexed: number } {
  const nest = paths.nestPath(vaultRoot)
  const found = new Set<string>()

  for (const [dirName, defaultType] of Object.entries(paths.DIR_TYPES)) {
    const dir = join(nest, dirName)
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue
      const slug = file.slice(0, -3)
      const filePath = join(dir, file)
      const raw = readFileSync(filePath, 'utf8')
      const { data, content } = matter(raw)
      const relPath = relative(vaultRoot, filePath).split(sep).join('/')
      upsertPage(
        slug,
        relPath,
        (data.type as string) || defaultType,
        (data.tags as string[]) || [],
        (data.summary as string) || deriveSummary(content),
        content,
        (data.aliases as string[]) || []
      )
      found.add(slug)
    }
  }

  const existingSlugs = (db.prepare('SELECT slug FROM pages').all() as Array<{ slug: string }>).map((r) => r.slug)
  const stale = existingSlugs.filter((slug) => !found.has(slug))
  for (const slug of stale) removePage(slug)

  // A bulk rebuild writes thousands of FTS segments; merging them keeps search
  // at the NFR-1 budget on the next query rather than paying the segment cost
  // on every read.
  db.exec("INSERT INTO pages_fts(pages_fts) VALUES('optimize')")

  regenerateIndexMd()
  return { indexed: found.size }
}

const handlers: Record<string, (...args: any[]) => unknown> = {
  upsertPage: (slug: string, filePath: string, type: string, tags: string[], summary: string, body: string, aliases: string[] = []) =>
    upsertPage(slug, filePath, type, tags, summary, body, aliases),
  removePage: (slug: string) => removePage(slug),
  setPageSummary: (slug: string, summary: string) => setPageSummary(slug, summary),
  setSectionSummaries: (slug: string, summaries: Array<{ heading?: unknown, summary?: unknown }>) => setSectionSummaries(slug, summaries),
  appendLog: (kind: string, title: string, pagesTouched: string[] = []) => appendLog(kind, title, pagesTouched),
  regenerateIndexMd: () => regenerateIndexMd(),
  recordHatchedSource: (relPath: string, hash: string) => recordHatchedSource(relPath, hash),
  rebuild: () => rebuild(),
  close: () => {
    db.close()
    return null
  }
}

parentPort?.on('message', (req: WriterRequest) => {
  const respond = (response: WriterResponse): void => parentPort?.postMessage(response)
  try {
    const handler = handlers[req.op]
    if (!handler) throw new Error(`unknown roost writer op: ${req.op}`)
    const result = handler(...req.args)
    respond({ id: req.id, ok: true, result })
  } catch (err) {
    respond({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})
