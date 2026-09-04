// Core logic for the "Hatch" workflow (coop/schema.md), extracted out of
// scripts/hatch.js so both the CLI (interactive, confirm-before-writing)
// and other callers (e.g. the Kip app with its own UI for that
// decision) can use it without duplicating the propose -> plan -> generate
// -> write steps. Mirrors how scripts/lib/peck.js relates to peck.js.
const fs = require('node:fs')
const path = require('node:path')
const matter = require('gray-matter')

const {
  findSimilarSlug, slugify, getPage, upsertPage, regenerateIndexMd, appendLog,
  hashContent, hatchedSourceHashes, recordHatchedSource, searchPages, setSectionSummaries, SIMILARITY_THRESHOLD
} = require('./roost')
const { resolvePage, nextFreeSlug, sourceHubMustCreate, findSourceHubByPath, hatchedSourcePaths } = require('./pages')
const { proposeCandidatePages, generatePageContent, proposeAndDraftPages, describeWhiteboard } = require('./prompts')
const { parseWhiteboard, whiteboardToOutline } = require('./whiteboard')
const { convertFile: convertOfficeFile, markdownNameFor, toStubSource, UnsupportedFormatError } = require('./office')
const { DEFAULT_VAULT_ROOT, pagesPath, nestPath, TYPE_DIRS } = require('./paths')

const VALID_TYPES = new Set(Object.keys(TYPE_DIRS))

// The coop subdirs "Hatch sources" scans, in order. pages/ is the unified
// source folder — Logseq's own markdown notes live here, and Office/PDF
// dropped here are converted to Markdown siblings at hatch time (see
// prepareSources). journals/ is Logseq's dated daily notes, read in place;
// whiteboards/ holds Logseq's .edn boards, turned into an outline page
// (deterministic) with an LLM-written Context section on top — see
// hatchWhiteboard.
const SOURCE_ROOTS = ['pages', 'journals', 'whiteboards']
// Backstop only: a file this large can't fit the model's context window in
// one piece, so it's skipped and reported rather than burning a slow, doomed
// call. Everything short of this is sent whole (chunking large-but-viable
// sources is a follow-up).
const MAX_SOURCE_BYTES = 1024 * 1024
// Below this many characters of real prose (frontmatter + list/markdown
// punctuation stripped) a file is treated as empty and skipped — Logseq
// creates stub journal/page files just by navigating to them.
const MIN_CONTENT_CHARS = 25
// Default per-click batch size, so one run over a large coop stays bounded.
const DEFAULT_BATCH_SIZE = 10
// Max concurrent LLM calls when generating a single source's pages. Cheap
// speedup — the calls are independent and read-only — capped to stay under
// provider rate limits.
const GENERATE_CONCURRENCY = 6
// Max concurrent files hatched at once. Each file's propose/draft is one LLM
// call and independent of the others, so batching them cuts wall-clock time by
// ~this factor; capped to stay under provider rate limits.
const HATCH_FILE_CONCURRENCY = 4
// Max concurrent Office/PDF conversions in prepareSources().
const OFFICE_CONCURRENCY = 4

/** Promise.all with a concurrency cap; preserves input order in the result. */
async function mapLimit (items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker () {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function humanizeFilename (filePath) {
  const base = path.basename(filePath, path.extname(filePath))
  return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Copies sourcePath into coop/pages/ unless it's already there; returns the pages/-relative path used from then on. */
function ensureInSources (sourcePath, vaultRoot) {
  const sourcesDir = pagesPath(vaultRoot)
  fs.mkdirSync(sourcesDir, { recursive: true })
  const targetPath = path.join(sourcesDir, path.basename(sourcePath))
  if (path.resolve(sourcePath) !== path.resolve(targetPath)) {
    fs.copyFileSync(sourcePath, targetPath)
  }
  return targetPath
}

/** Resolves create-vs-update for each LLM-proposed candidate. No writes —
 *  findSimilarSlug()/getPage() only. Mirrors resolvePage's source-hub rules
 *  (a source page never updates a non-source page; a document's own hub is
 *  found by source path, not title), so the plan a human reviews describes
 *  what the write will actually do. */
function planCandidates (candidates, vaultRoot, { sourceRelPath = null } = {}) {
  return candidates.map((candidate) => {
    // A document's own hub resolves by source path first — same as resolvePage.
    if (candidate.type === 'source' && sourceRelPath) {
      const hub = findSourceHubByPath(sourceRelPath, vaultRoot)
      if (hub) return { ...candidate, action: 'update', slug: hub.slug }
    }
    const similar = findSimilarSlug(candidate.title, vaultRoot)
    if (similar && similar.score >= SIMILARITY_THRESHOLD) {
      const matched = getPage(similar.slug, vaultRoot)
      if (matched && sourceHubMustCreate(matched.type, candidate.type)) {
        return { ...candidate, action: 'create', slug: nextFreeSlug(similar.slug, candidate.type, vaultRoot) }
      }
      return { ...candidate, action: 'update', slug: similar.slug, similarity: similar.score }
    }
    return { ...candidate, action: 'create', slug: slugify(candidate.title) }
  })
}

/**
 * Steps 1-3 of the Hatch workflow: (optionally) copy the source into
 * coop/pages/, ask the LLM which pages it likely touches, and resolve
 * create-vs-update for each — without writing anything to coop/nest/ yet.
 * The caller is expected to show `plan` to a human and confirm before
 * calling commitHatchPlan().
 *
 * copyToSources defaults true (the single-file CLI / "add this document" path).
 * "Hatch sources" passes false for journals/ and pages/ files — they're
 * already in the coop and copying them into pages/ would just duplicate them.
 *
 * combined (default true) proposes the pages AND drafts each body in one LLM
 * call (proposeAndDraftPages) — plan entries then carry `body`, and
 * commitHatchPlan skips the per-page generate call. combined:false is the
 * classic path: propose only, one generate call per page at commit time.
 *
 * @returns {{sourceTitle: string, sourceContent: string, sourceFilePath: string, plan: Array}}
 */
async function proposeHatchPlan (sourcePath, vaultRoot = DEFAULT_VAULT_ROOT, { copyToSources = true, combined = true } = {}) {
  const sourceFilePath = copyToSources ? ensureInSources(sourcePath, vaultRoot) : path.resolve(sourcePath)
  const sourceContent = fs.readFileSync(sourceFilePath, 'utf8')
  const sourceTitle = humanizeFilename(sourceFilePath)

  // An Office-converted sibling (report.docx -> report.md) carries the
  // original file's name in its own frontmatter (`source:`, written by
  // lib/office.js "so a hatched page can be traced back") — read it through,
  // so the trace names the .docx, not just the .md we generated from it.
  let sourceOriginal = null
  try {
    const sourceMeta = matter(sourceContent).data
    if (sourceMeta && typeof sourceMeta.source === 'string' && sourceMeta.source.trim()) sourceOriginal = sourceMeta.source.trim()
  } catch { /* not frontmatter'd — fine */ }

  const proposed = combined
    ? await proposeAndDraftPages(sourceTitle, sourceContent, vaultRoot)
    : await proposeCandidatePages(sourceTitle, sourceContent, vaultRoot)
  const candidates = proposed.filter((c) =>
    c && typeof c.title === 'string' && c.title.trim() && VALID_TYPES.has(c.type) &&
    (!combined || (typeof c.body === 'string' && c.body.trim())))

  // The per-document trace hub (kip-app#113). The prompt asks for a
  // type:'source' page but nothing enforced it, so a plan could hatch a whole
  // document with nothing linking back to it. Synthesize the hub into the
  // plan HERE — the human reviewing the plan sees it and can deselect it.
  const sourceRelPath = path.relative(vaultRoot, sourceFilePath).split(path.sep).join('/')
  if (!candidates.some((c) => c.type === 'source')) {
    const hash = hashContent(sourceContent)
    candidates.push({
      type: 'source',
      title: sourceTitle,
      body: `## Source\n\n- Source file: \`${sourceRelPath}\`${sourceOriginal ? `\n- Original document: \`${sourceOriginal}\`` : ''}\n- Content hash at hatch: \`${hash.slice(0, 12)}…\`\n- Hatched: ${new Date().toISOString().slice(0, 10)}\n\nThis page is the document's trace hub: the pages hatched from it carry \`source: ${sourceRelPath}\` in their frontmatter.`,
      tags: [],
      summary: `Hatched from ${sourceRelPath}`
    })
  }
  const plan = planCandidates(candidates, vaultRoot, { sourceRelPath })

  return { sourceTitle, sourceContent, sourceFilePath, sourceRelPath, sourceOriginal, plan }
}

/**
 * Steps 5-6: writes each planned page via resolvePage(), syncs meta.db, and
 * logs the hatch. Call only after a human has confirmed the plan from
 * proposeHatchPlan(). A combined-path body (candidate.body) is used as-is for
 * a pure create (and for any `source` page); an entity/concept `update` —
 * combined path or classic — gets a generatePageContent() call with the
 * existing page content so the write is a delta, not a restatement (#114).
 *
 * Provenance (kip-app#113): `sourceRelPath` (coop-relative path of the
 * document, e.g. `pages/report.md`) and `sourceHash` (its sha1) are written
 * onto every page this hatch touches — frontmatter `source:`/`source_hatched:`
 * on all of them, plus a `## Source` section at the top of every
 * `type: 'source'` page on create. When the plan proposes no source page at
 * all, one is synthesized: the vault-pattern rule that every wiki page stays
 * traceable to its raw document needs a per-document hub that isn't
 * contingent on the model remembering to propose one.
 *
 * Pages whose generated body comes back empty are skipped, not written — a
 * frontmatter-only page renders as a broken/empty page in the graph app.
 * They land in the returned `skipped` list.
 *
 * `regenIndex` (default true) rewrites coop/nest/index.md at the end. Batch
 * callers (hatchAllSources) pass false and regenerate once after the whole
 * batch instead of once per file.
 *
 * @returns {{results: Array<{action, slug, path}>, skipped: string[]}}
 */
async function commitHatchPlan ({ plan, sourceTitle, sourceContent, sourceRelPath = null, sourceHash = null, sourceOriginal = null }, vaultRoot = DEFAULT_VAULT_ROOT, { regenIndex = true } = {}) {
  const allSlugs = plan.map((p) => p.slug)

  // Resolve every page's body up front, in parallel (capped). Writes stay
  // sequential.
  //
  // A combined-path drafted body is used as-is for a pure create, and for a
  // `source` page (its body is a stable trace pointer — file/hash/links — not
  // accumulating knowledge). An entity/concept `update` gets an
  // existing-content-aware generate call instead: the combined draft was
  // written from the source alone, never seeing the page it's extending, so on
  // the default path those updates came out as parallel restatements rather
  // than deltas (#114). That's the one extra call the classic path already
  // made for updates; updates are typically 0-2 per source, so the
  // one-call-per-file cost still mostly holds.
  const bodies = await mapLimit(plan, GENERATE_CONCURRENCY, (candidate) => {
    const draft = typeof candidate.body === 'string' && candidate.body.trim() ? candidate.body.trim() : null
    if (draft && (candidate.action !== 'update' || candidate.type === 'source')) return draft

    let existingContent = null
    if (candidate.action === 'update') {
      const existing = getPage(candidate.slug, vaultRoot)
      if (existing) {
        const raw = fs.readFileSync(path.join(vaultRoot, existing.path), 'utf8')
        existingContent = matter(raw).content.trim()
      }
    }
    // Combined-path update but the page has vanished from disk/index — the
    // drafted body is better than a source-only regenerate with no delta.
    if (draft && !existingContent) return draft
    return generatePageContent({
      title: candidate.title,
      type: candidate.type,
      action: candidate.action,
      existingContent,
      sourceTitle,
      sourceContent,
      siblingSlugs: allSlugs.filter((s) => s !== candidate.slug),
      vaultRoot
    })
  })

  const results = []
  const skipped = []
  for (let i = 0; i < plan.length; i++) {
    const candidate = plan[i]
    if (!bodies[i] || !bodies[i].trim()) {
      skipped.push(candidate.slug)
      continue
    }

    const result = resolvePage({
      type: candidate.type,
      title: candidate.title,
      body: bodies[i],
      tags: candidate.tags || [],
      vaultRoot,
      source: sourceRelPath,
      sourceHash,
      sourceOriginal,
      summary: candidate.summary || null
    })

    const writtenRaw = fs.readFileSync(path.join(vaultRoot, result.path), 'utf8')
    const { content: writtenBody } = matter(writtenRaw)
    upsertPage(result.slug, result.path, result.type, result.tags, candidate.summary || '', writtenBody, vaultRoot)

    // LLM section summaries (kip-app#106): the combined draft may have also
    // proposed one-liners per "##"/"###" section. Match them onto the
    // deterministic section rows; unmatched headings keep their first-line
    // summary. Best-effort — a model that omits or mangles sections degrades
    // gracefully.
    if (Array.isArray(candidate.sections) && candidate.sections.length) {
      setSectionSummaries(result.slug, candidate.sections, vaultRoot)
    }

    results.push(result)
  }

  if (regenIndex) regenerateIndexMd(vaultRoot)
  const touchedSlugs = [...new Set(results.map((r) => r.slug))]
  appendLog('hatch', sourceTitle, touchedSlugs, vaultRoot)

  return { results, skipped }
}

/**
 * Existing nest pages a search matches against the mindmap's node labels —
 * so the LLM can [[link]] the board's nodes to what's already in the wiki.
 * De-duped, the board's own page excluded, capped.
 */
function findRelatedPages (wb, ownSlug, vaultRoot, cap = 12) {
  const labels = [...new Set(wb.nodes
    .map((n) => String(n.label).replace(/^\[\[|\]\]$/g, '').replace(/^\(\(|\)\)$/g, '').trim())
    .filter((l) => l && l !== '(untitled)'))]
  const seen = new Map()
  for (const label of labels) {
    for (const hit of searchPages(label, { limit: 3 }, vaultRoot)) {
      if (hit.slug !== ownSlug && !seen.has(hit.slug)) seen.set(hit.slug, hit)
    }
    if (seen.size >= cap) break
  }
  return [...seen.values()].slice(0, cap)
}

/**
 * Turns one whiteboard .edn into nest/sources/<slug>.md. The **Outline** is a
 * deterministic render of the board's shapes (scripts/lib/whiteboard.js). A
 * **Context** section above it is written by the LLM (describeWhiteboard) —
 * an interpretation of the map plus [[links]] to related nest pages; it is
 * best-effort, and the page falls back to outline-only when there's no
 * provider configured or the call fails. Either way the page is a full
 * replace each time (not a dated _Update_ append): the board is the source
 * of truth, this page mirrors it.
 *
 * @returns {Promise<{action: 'create'|'update', slug: string, path: string, enriched: boolean}>}
 */
async function hatchWhiteboard (absPath, vaultRoot = DEFAULT_VAULT_ROOT) {
  const wb = parseWhiteboard(fs.readFileSync(absPath, 'utf8'))
  const boardName = wb.name || path.basename(absPath, path.extname(absPath))
  const slug = slugify(boardName)

  const relPath = `nest/sources/${slug}.md`
  const filePath = path.join(nestPath(vaultRoot), 'sources', `${slug}.md`)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })

  const today = new Date().toISOString().slice(0, 10)
  const existing = getPage(slug, vaultRoot)
  const created = existing ? String(existing.created).slice(0, 10) : today

  const outline = whiteboardToOutline(wb)

  let context = null
  let summary = `Whiteboard: ${boardName}`
  if (wb.nodes.length) {
    try {
      const related = findRelatedPages(wb, slug, vaultRoot)
      const described = await describeWhiteboard({ name: boardName, outline, relatedPages: related }, vaultRoot)
      if (described) {
        context = described.context
        if (described.summary) summary = described.summary
      }
    } catch {
      // no provider configured, or a transient LLM failure — outline-only is
      // still a useful result, so don't fail the hatch over it.
    }
  }

  const relBoardPath = path.relative(vaultRoot, absPath).split(path.sep).join('/')
  const intro = context
    ? `_Whiteboard **${boardName}** (source: \`${relBoardPath}\`): the Context is LLM-written, the Outline is regenerated from the board's shapes. Edit the board, not this page._`
    : `_Outline of the whiteboard **${boardName}**, generated from \`${relBoardPath}\`. Edit the board, not this page._`
  const body = context
    ? `${intro}\n\n## Context\n\n${context}\n\n## Outline\n\n${outline}`
    : `${intro}\n\n${outline}`

  fs.writeFileSync(filePath, matter.stringify(body + '\n', {
    type: 'source', created, updated: today, tags: ['whiteboard'],
    source: relBoardPath, source_hatched: today
  }))
  upsertPage(slug, relPath, 'source', ['whiteboard'], summary, body, vaultRoot)
  return { action: existing ? 'update' : 'create', slug, path: relPath, enriched: !!context }
}

/** Rough count of real prose characters — frontmatter and list/markdown punctuation removed. */
function meaningfulTextLength (raw) {
  let body
  try { body = matter(raw).content } catch { body = raw }
  return body
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[#>`*_~[\]()|=-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .length
}

/**
 * Prepare the unified source folder (pages/) for the source scan: turn every
 * dropped Office / PDF file into a Markdown sibling (scripts/lib/office.js)
 * so the normal scan can read it, and turn anything Kip can't convert into a
 * reference-only `.md` stub so it still gets a traceable page (instead of
 * being silently skipped). Idempotent — an up-to-date `<stem>.md` is left
 * alone. Best-effort per file: a failure is collected, not thrown.
 *
 * Runs before every hatch entry point (hatchAllSources, proposeNextPending,
 * pendingSourcesSummary) so a `.docx` synced in through Dropbox, or added by
 * `office-extract.js`, or dropped in the app all end up hatched the same way.
 *
 * @returns {{converted: Array<{source, kind}>, stubbed: Array<{source}>, failed: Array<{source, error}>}}
 */
async function prepareSources (vaultRoot = DEFAULT_VAULT_ROOT) {
  const sourcesDir = pagesPath(vaultRoot)
  if (!fs.existsSync(sourcesDir)) return { converted: [], stubbed: [], failed: [] }

  const entries = fs.readdirSync(sourcesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && !entry.name.endsWith('.md'))

  // Office/PDF extraction is independent per file (and several converters are
  // promise-based), so convert them in parallel — a folder of dropped docs is
  // a common case and serial conversion is what made it crawl.
  const results = await mapLimit(entries, OFFICE_CONCURRENCY, async (entry) => {
    const absPath = path.join(sourcesDir, entry.name)
    const target = path.join(sourcesDir, markdownNameFor(entry.name))
    try {
      const r = await convertOfficeFile(absPath, target)
      return r.skipped ? null : { converted: { source: entry.name, kind: r.kind } }
    } catch (err) {
      if (err instanceof UnsupportedFormatError) {
        // Unreadable format → a reference-only stub, not a silent skip. Idempotent
        // like conversion: leave an up-to-date stub alone.
        try {
          if (fs.statSync(target).mtimeMs >= fs.statSync(absPath).mtimeMs) return null
        } catch { /* no stub yet — write one */ }
        fs.writeFileSync(target, toStubSource(entry.name, (err && err.message) || undefined))
        return { stubbed: { source: entry.name } }
      }
      return { failed: { source: entry.name, error: (err && err.message) || String(err) } }
    }
  })

  const converted = []
  const stubbed = []
  const failed = []
  for (const r of results) {
    if (!r) continue
    if (r.converted) converted.push(r.converted)
    else if (r.stubbed) stubbed.push(r.stubbed)
    else if (r.failed) failed.push(r.failed)
  }
  return { converted, stubbed, failed }
}

/**
 * The deterministic half of "Hatch sources": scans the coop's source dirs
 * (pages/, journals/, whiteboards/) and buckets every file. No LLM, no writes.
 *
 * `pending` = new OR content-changed since last hatch (sha1 vs
 * hatched_sources); `kind` is the dir, or 'whiteboard' for a .edn board.
 * A source whose trace hub already exists in nest/sources/ is treated as
 * already hatched and skipped — the nest is synced graph markdown, so this
 * holds across devices (a Dropbox sync that brings over an already-hatched
 * file is NOT re-hatched), unlike the hatched_sources hash cache which is
 * device-local. Pass `force` to re-hatch those anyway (a manual re-hatch).
 * Skipped, and reported separately: dotfiles, non-.md files (they're turned
 * into .md siblings by prepareSources() first), near-empty files, and files
 * over MAX_SOURCE_BYTES (a ~1 MB context-window backstop — whiteboards are
 * exempt, they become a tiny outline).
 *
 * @returns {{pending: Array<{relPath, absPath, kind, bytes, status: 'new'|'changed'}>,
 *            oversized: Array<{relPath, bytes}>,
 *            empty: string[],
 *            errors: Array<{relPath, error}>}}
 */
function collectPendingSources (vaultRoot = DEFAULT_VAULT_ROOT, { roots = SOURCE_ROOTS, force = false } = {}) {
  const hashes = hatchedSourceHashes(vaultRoot)
  const hatchedPaths = force ? null : hatchedSourcePaths(vaultRoot)
  const pending = []
  const oversized = []
  const empty = []
  const errors = []

  for (const root of roots) {
    const dir = path.join(vaultRoot, root)
    if (!fs.existsSync(dir)) continue

    const board = root === 'whiteboards'
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue
      const name = entry.name.toLowerCase()
      if (board ? !name.endsWith('.edn') : !name.endsWith('.md')) continue

      const absPath = path.join(dir, entry.name)
      const relPath = `${root}/${entry.name}`
      let bytes
      let content
      try {
        bytes = fs.statSync(absPath).size
        content = fs.readFileSync(absPath, 'utf8')
      } catch (err) {
        // Unreadable now (permissions, a race with the file being replaced).
        // Report it rather than throwing the whole scan — groom runs
        // unattended on a schedule and must not die on one bad file.
        errors.push({ relPath, error: (err && err.code) || (err && err.message) || String(err) })
        continue
      }

      // Whiteboards are turned into a tiny outline deterministically, so the
      // huge tldraw JSON behind them doesn't count against the size/prose gates.
      if (!board && bytes > MAX_SOURCE_BYTES) { oversized.push({ relPath, bytes }); continue }

      if (!board && meaningfulTextLength(content) < MIN_CONTENT_CHARS) { empty.push(relPath); continue }
      if (hatchedPaths && hatchedPaths.has(relPath)) continue // already hatched (synced trace hub) — skip unless forced
      const priorHash = hashes.get(relPath)
      if (priorHash === hashContent(content)) continue // unchanged since last hatch

      // status splits the vault-Lint "un-ingested raw" check into its two
      // cases (kip-app#113): a brand-new source vs one hatched before and
      // edited since — an "immutable" source edited in place is a different
      // signal from a fresh drop, and re-hatching it re-appends the whole
      // document, so the preview/groom should say which is which.
      pending.push({ relPath, absPath, kind: board ? 'whiteboard' : root, bytes, status: priorHash === undefined ? 'new' : 'changed' })
    }
  }

  pending.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return { pending, oversized, empty, errors }
}

/**
 * Preview for the "Hatch sources" UI — what a run would touch, with no LLM
 * calls. `totalKb` is the combined size of `pending`, a rough proxy for how
 * much a full run will cost. Converts any pending Office/PDF file first so it
 * shows up as its `.md`; `conversionFailed` lists the ones that wouldn't.
 * Each pending entry carries `status: 'new' | 'changed'` (kip-app#113), and
 * `changedCount` summarizes the latter so the preview can say "N sources
 * edited since hatch" instead of blurring edits into new drops.
 */
async function pendingSourcesSummary (vaultRoot = DEFAULT_VAULT_ROOT, opts = {}) {
  const conv = await prepareSources(vaultRoot)
  const { pending, oversized, empty } = collectPendingSources(vaultRoot, opts)
  return {
    pending: pending.map((p) => ({ source: humanizeFilename(p.absPath), kind: p.kind, kb: Math.round(p.bytes / 1024), status: p.status })),
    oversized: oversized.map((o) => ({ source: o.relPath, kb: Math.round(o.bytes / 1024) })),
    empty,
    conversionFailed: conv.failed,
    changedCount: pending.filter((p) => p.status === 'changed').length,
    totalKb: Math.round(pending.reduce((sum, p) => sum + p.bytes, 0) / 1024)
  }
}

/**
 * Hatches up to `limit` pending source files (see collectPendingSources) —
 * propose + commit per file, NO plan review. Records each in hatched_sources
 * by content hash, so a re-run skips it until it changes and a run that dies
 * part-way resumes cleanly. findSimilarSlug()-based create-vs-update still
 * runs per page (that's not what's skipped).
 *
 * `combined` (default true) — one LLM call per file (propose + draft every
 * body together). `combined:false` is the classic path: one propose call
 * plus one generate call per page.
 *
 * One bad source (LLM error, empty plan) goes into `failed`, not thrown.
 * `remaining` is how many pending files are left after this batch.
 *
 * `onProgress({done, total, current})` fires before each file starts and
 * after each finishes — the CLI wires it to a status file the app polls for
 * a live progress bar.
 *
 * Each hatched/failed entry carries `ms` (wall time spent on that file).
 *
 * @returns {{hatched: Array<{source, kind, results, skipped, ms}>,
 *            failed: Array<{source, error, ms}>,
 *            oversized: Array<{source, kb}>,
 *            empty: string[],
 *            remaining: number}}
 */
async function hatchAllSources (vaultRoot = DEFAULT_VAULT_ROOT,
  { roots = SOURCE_ROOTS, limit = DEFAULT_BATCH_SIZE, onProgress = () => {}, combined = true, force = false } = {}) {
  const conversion = await prepareSources(vaultRoot)
  const { pending, oversized, empty } = collectPendingSources(vaultRoot, { roots, force })
  const batch = pending.slice(0, limit)

  // Phase 1 — propose/draft every file in parallel. This is the expensive LLM
  // call per file; it only reads the index (findSimilarSlug), so concurrent
  // proposals can't race each other. Writes happen in phase 2, sequentially.
  const prepared = await mapLimit(batch, HATCH_FILE_CONCURRENCY, async (file) => {
    const source = humanizeFilename(file.absPath)
    const startedAt = Date.now()
    try {
      const hash = hashContent(fs.readFileSync(file.absPath, 'utf8'))
      if (file.kind === 'whiteboard') {
        return { file, source, hash, whiteboard: true, startedAt }
      }
      const proposal = await proposeHatchPlan(file.absPath, vaultRoot, { copyToSources: false, combined })
      return { file, source, hash, proposal, startedAt }
    } catch (err) {
      return { file, source, error: (err && err.message) || String(err), startedAt }
    }
  })

  // Phase 2 — commit sequentially. resolvePage re-runs findSimilarSlug at write
  // time, so a page two files both proposed still resolves correctly; the
  // single-connection meta.db writes stay serial.
  const hatched = []
  const failed = []
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i]
    onProgress({ done: i, total: batch.length, current: p.source })

    if (p.error) {
      failed.push({ source: p.source, error: p.error, ms: Date.now() - p.startedAt })
      onProgress({ done: i + 1, total: batch.length, current: null })
      continue
    }

    try {
      if (p.whiteboard) {
        const result = await hatchWhiteboard(p.file.absPath, vaultRoot)
        recordHatchedSource(p.file.relPath, p.hash, vaultRoot)
        hatched.push({ source: p.source, kind: 'whiteboard', results: [result], skipped: [], ms: Date.now() - p.startedAt })
      } else if (p.proposal.plan.length === 0) {
        failed.push({ source: p.source, error: 'no usable pages proposed (often a transient LLM formatting issue — re-run to retry this file)', ms: Date.now() - p.startedAt })
      } else {
        // index.md is regenerated once after the whole batch, not per file.
        const { results, skipped } = await commitHatchPlan(
          { ...p.proposal, sourceRelPath: p.file.relPath, sourceHash: p.hash },
          vaultRoot, { regenIndex: false })
        if (results.length === 0) {
          failed.push({ source: p.source, error: 'the LLM returned empty content for every proposed page — re-run to retry this file', ms: Date.now() - p.startedAt })
        } else {
          recordHatchedSource(p.file.relPath, p.hash, vaultRoot)
          hatched.push({ source: p.source, kind: p.file.kind, results, skipped, ms: Date.now() - p.startedAt })
        }
      }
    } catch (err) {
      failed.push({ source: p.source, error: (err && err.message) || String(err), ms: Date.now() - p.startedAt })
    }
    onProgress({ done: i + 1, total: batch.length, current: null })
  }

  if (hatched.length) regenerateIndexMd(vaultRoot)

  // A file that couldn't be converted (a corrupt .docx, a scanned-image PDF)
  // is a failure the user should see, same as a bad hatch.
  for (const f of conversion.failed) failed.push({ source: f.source, error: `couldn't convert: ${f.error}`, ms: 0 })

  return {
    hatched,
    failed,
    converted: conversion.converted,
    oversized: oversized.map((o) => ({ source: o.relPath, kb: Math.round(o.bytes / 1024) })),
    empty,
    remaining: Math.max(0, pending.length - batch.length)
  }
}

/**
 * "Review before writing" mode, one file at a time. Proposes pages for the
 * first pending source (skipping the first `skip`, so the caller can step
 * past files it has already handled this session) but writes nothing. The
 * full plan — bodies and all — is stashed at <coop>/.roost/hatch-plan.json
 * for commitReviewedPlan() to pick up; the return value is slim (no bodies,
 * no source text) for the UI.
 *
 * @returns {{done: true} | {source, relPath, kind, remaining,
 *            plan: Array<{slug, title, type, action, summary}>,
 *            whiteboard?: true}}
 */
async function proposeNextPending (vaultRoot = DEFAULT_VAULT_ROOT,
  { roots = SOURCE_ROOTS, limit = DEFAULT_BATCH_SIZE, skip = 0, combined = true, force = false } = {}) {
  await prepareSources(vaultRoot)
  const { pending } = collectPendingSources(vaultRoot, { roots, force })
  const capped = pending.slice(0, limit)
  const file = capped[skip]
  if (!file) return { done: true }

  const source = humanizeFilename(file.absPath)
  const remaining = capped.length - skip - 1
  const hash = hashContent(fs.readFileSync(file.absPath, 'utf8'))
  const planFile = path.join(vaultRoot, '.roost', 'hatch-plan.json')
  fs.mkdirSync(path.dirname(planFile), { recursive: true })

  if (file.kind === 'whiteboard') {
    // A board becomes one deterministic outline page — nothing to pick from.
    fs.writeFileSync(planFile, JSON.stringify({ relPath: file.relPath, kind: 'whiteboard', hash, at: Date.now() }))
    return { source, relPath: file.relPath, kind: 'whiteboard', whiteboard: true, remaining }
  }

  const p = await proposeHatchPlan(file.absPath, vaultRoot, { copyToSources: false, combined })
  fs.writeFileSync(planFile, JSON.stringify({
    relPath: file.relPath, kind: file.kind, hash,
    sourceTitle: p.sourceTitle, sourceContent: p.sourceContent, sourceOriginal: p.sourceOriginal, plan: p.plan, at: Date.now()
  }))
  return {
    source, relPath: file.relPath, kind: file.kind, remaining,
    plan: p.plan.map((c) => ({ slug: c.slug, title: c.title, type: c.type, action: c.action, summary: c.summary || '' }))
  }
}

/**
 * Commits the plan stashed by proposeNextPending(), keeping only the pages
 * whose slug is in `keepSlugs` (null / undefined = keep all). Records the
 * source's content hash so it isn't re-proposed — including when the user
 * kept nothing (a deliberate "skip this file"). Regenerates index.md.
 *
 * @returns {{source, results?, skipped?, error?, keptNone?: true}}
 */
async function commitReviewedPlan (vaultRoot = DEFAULT_VAULT_ROOT, { keepSlugs = null } = {}) {
  const planFile = path.join(vaultRoot, '.roost', 'hatch-plan.json')
  const stash = JSON.parse(fs.readFileSync(planFile, 'utf8'))
  const source = humanizeFilename(path.join(vaultRoot, stash.relPath))
  const startedAt = Date.now()

  try {
    if (stash.kind === 'whiteboard') {
      const result = await hatchWhiteboard(path.join(vaultRoot, stash.relPath), vaultRoot)
      recordHatchedSource(stash.relPath, stash.hash, vaultRoot)
      regenerateIndexMd(vaultRoot)
      return { source, kind: 'whiteboard', results: [result], skipped: [], ms: Date.now() - startedAt }
    }

    const keep = Array.isArray(keepSlugs) ? new Set(keepSlugs) : null
    const kept = keep ? stash.plan.filter((c) => keep.has(c.slug)) : stash.plan

    if (kept.length === 0) {
      recordHatchedSource(stash.relPath, stash.hash, vaultRoot)
      return { source, keptNone: true, ms: Date.now() - startedAt }
    }

    const { results, skipped } = await commitHatchPlan(
      { plan: kept, sourceTitle: stash.sourceTitle, sourceContent: stash.sourceContent, sourceRelPath: stash.relPath, sourceHash: stash.hash, sourceOriginal: stash.sourceOriginal },
      vaultRoot, { regenIndex: true })
    if (results.length === 0) {
      return { source, error: 'every kept page came back empty — try again', ms: Date.now() - startedAt }
    }
    recordHatchedSource(stash.relPath, stash.hash, vaultRoot)
    return { source, kind: stash.kind, results, skipped, ms: Date.now() - startedAt }
  } catch (err) {
    return { source, error: (err && err.message) || String(err), ms: Date.now() - startedAt }
  } finally {
    try { fs.rmSync(planFile, { force: true }) } catch { /* best-effort */ }
  }
}

module.exports = {
  proposeHatchPlan,
  commitHatchPlan,
  proposeNextPending,
  commitReviewedPlan,
  ensureInSources,
  planCandidates,
  humanizeFilename,
  meaningfulTextLength,
  mapLimit,
  collectPendingSources,
  prepareSources,
  pendingSourcesSummary,
  hatchAllSources,
  hatchWhiteboard,
  SOURCE_ROOTS,
  MAX_SOURCE_BYTES
}
