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
  hashContent, hatchedSourceHashes, recordHatchedSource, searchPages, SIMILARITY_THRESHOLD
} = require('./roost')
const { resolvePage } = require('./pages')
const { proposeCandidatePages, generatePageContent, proposeAndDraftPages, describeWhiteboard } = require('./prompts')
const { parseWhiteboard, whiteboardToOutline } = require('./whiteboard')
const { isSupported: isOfficeFile, convertFile: convertOfficeFile, markdownNameFor } = require('./office')
const { DEFAULT_VAULT_ROOT, eggsPath, nestPath, TYPE_DIRS } = require('./paths')

const VALID_TYPES = new Set(Object.keys(TYPE_DIRS))

// The coop subdirs "Hatch sources" scans, in order. eggs/ is a manual
// drop-box (any file type); journals/ and pages/ are Logseq's own markdown,
// read in place; whiteboards/ holds Logseq's .edn boards, turned into an
// outline page (deterministic) with an LLM-written Context section on top —
// see hatchWhiteboard.
const SOURCE_ROOTS = ['eggs', 'journals', 'pages', 'whiteboards']
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

/** Copies sourcePath into coop/eggs/ unless it's already there; returns the eggs/-relative path used from then on. */
function ensureInEggs (sourcePath, vaultRoot) {
  const eggsDir = eggsPath(vaultRoot)
  fs.mkdirSync(eggsDir, { recursive: true })
  const targetPath = path.join(eggsDir, path.basename(sourcePath))
  if (path.resolve(sourcePath) !== path.resolve(targetPath)) {
    fs.copyFileSync(sourcePath, targetPath)
  }
  return targetPath
}

/** Resolves create-vs-update for each LLM-proposed candidate. No writes — findSimilarSlug() only. */
function planCandidates (candidates, vaultRoot) {
  return candidates.map((candidate) => {
    const similar = findSimilarSlug(candidate.title, vaultRoot)
    if (similar && similar.score >= SIMILARITY_THRESHOLD) {
      return { ...candidate, action: 'update', slug: similar.slug, similarity: similar.score }
    }
    return { ...candidate, action: 'create', slug: slugify(candidate.title) }
  })
}

/**
 * Steps 1-3 of the Hatch workflow: (optionally) copy the source into
 * coop/eggs/, ask the LLM which pages it likely touches, and resolve
 * create-vs-update for each — without writing anything to coop/nest/ yet.
 * The caller is expected to show `plan` to a human and confirm before
 * calling commitHatchPlan().
 *
 * copyToEggs defaults true (the single-file CLI / "add this document" path).
 * "Hatch sources" passes false for journals/ and pages/ files — they're
 * already in the coop and copying them into eggs/ would just duplicate them.
 *
 * combined (default true) proposes the pages AND drafts each body in one LLM
 * call (proposeAndDraftPages) — plan entries then carry `body`, and
 * commitHatchPlan skips the per-page generate call. combined:false is the
 * classic path: propose only, one generate call per page at commit time.
 *
 * @returns {{sourceTitle: string, sourceContent: string, eggsFilePath: string, plan: Array}}
 */
async function proposeHatchPlan (sourcePath, vaultRoot = DEFAULT_VAULT_ROOT, { copyToEggs = true, combined = true } = {}) {
  const eggsFilePath = copyToEggs ? ensureInEggs(sourcePath, vaultRoot) : path.resolve(sourcePath)
  const sourceContent = fs.readFileSync(eggsFilePath, 'utf8')
  const sourceTitle = humanizeFilename(eggsFilePath)

  const proposed = combined
    ? await proposeAndDraftPages(sourceTitle, sourceContent, vaultRoot)
    : await proposeCandidatePages(sourceTitle, sourceContent, vaultRoot)
  const candidates = proposed.filter((c) =>
    c && typeof c.title === 'string' && c.title.trim() && VALID_TYPES.has(c.type) &&
    (!combined || (typeof c.body === 'string' && c.body.trim())))
  const plan = planCandidates(candidates, vaultRoot)

  return { sourceTitle, sourceContent, eggsFilePath, plan }
}

/**
 * Steps 5-6: writes each planned page via resolvePage(), syncs meta.db, and
 * logs the hatch. Call only after a human has confirmed the plan from
 * proposeHatchPlan(). Bodies drafted by the combined path (candidate.body)
 * are used as-is; any candidate without one gets a generatePageContent()
 * call here (the classic path).
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
async function commitHatchPlan ({ plan, sourceTitle, sourceContent }, vaultRoot = DEFAULT_VAULT_ROOT, { regenIndex = true } = {}) {
  const allSlugs = plan.map((p) => p.slug)

  // Resolve every page's body up front, in parallel (capped). Combined-path
  // candidates already carry a drafted body; classic-path ones get one
  // generate call each here (independent + read-only). Writes stay sequential.
  const bodies = await mapLimit(plan, GENERATE_CONCURRENCY, (candidate) => {
    if (typeof candidate.body === 'string' && candidate.body.trim()) return candidate.body.trim()

    let existingContent = null
    if (candidate.action === 'update') {
      const existing = getPage(candidate.slug, vaultRoot)
      if (existing) {
        const raw = fs.readFileSync(path.join(vaultRoot, existing.path), 'utf8')
        existingContent = matter(raw).content.trim()
      }
    }
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
      vaultRoot
    })

    const writtenRaw = fs.readFileSync(path.join(vaultRoot, result.path), 'utf8')
    const { content: writtenBody } = matter(writtenRaw)
    upsertPage(result.slug, result.path, result.type, result.tags, candidate.summary || '', writtenBody, vaultRoot)

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

  const intro = context
    ? `_Whiteboard **${boardName}**: the Context is LLM-written, the Outline is regenerated from the board's shapes. Edit the board, not this page._`
    : `_Outline of the whiteboard **${boardName}**, generated from its shapes. Edit the board, not this page._`
  const body = context
    ? `${intro}\n\n## Context\n\n${context}\n\n## Outline\n\n${outline}`
    : `${intro}\n\n${outline}`

  fs.writeFileSync(filePath, matter.stringify(body + '\n', { type: 'source', created, updated: today, tags: ['whiteboard'] }))
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
 * Turn every Office / PDF file dropped into eggs/ into a Markdown sibling
 * (scripts/lib/office.js) so the normal source scan can read it. Idempotent —
 * an up-to-date `<stem>.md` is left alone. Best-effort per file: a conversion
 * failure is collected, not thrown.
 *
 * Runs before every hatch entry point (hatchAllSources, proposeNextPending,
 * pendingSourcesSummary) so a `.docx` synced in through Dropbox, or added by
 * `office-extract.js`, or dropped in the app all end up hatched the same way.
 *
 * @returns {{converted: Array<{source, kind}>, failed: Array<{source, error}>}}
 */
async function convertPendingOfficeSources (vaultRoot = DEFAULT_VAULT_ROOT) {
  const eggsDir = eggsPath(vaultRoot)
  if (!fs.existsSync(eggsDir)) return { converted: [], failed: [] }

  const converted = []
  const failed = []
  for (const entry of fs.readdirSync(eggsDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.') || !isOfficeFile(entry.name)) continue
    const absPath = path.join(eggsDir, entry.name)
    try {
      const r = await convertOfficeFile(absPath, path.join(eggsDir, markdownNameFor(entry.name)))
      if (!r.skipped) converted.push({ source: entry.name, kind: r.kind })
    } catch (err) {
      failed.push({ source: entry.name, error: (err && err.message) || String(err) })
    }
  }
  return { converted, failed }
}

/**
 * The deterministic half of "Hatch sources": scans the coop's source dirs
 * (eggs/, journals/, pages/, whiteboards/) and buckets every file. No LLM,
 * no writes.
 *
 * `pending` = new OR content-changed since last hatch (sha1 vs
 * hatched_sources); `kind` is the dir, or 'whiteboard' for a .edn board.
 * Skipped, and reported separately: dotfiles, non-.md files outside eggs/
 * and whiteboards/, near-empty files, and files over MAX_SOURCE_BYTES (a
 * ~1 MB context-window backstop — whiteboards are exempt, they become a
 * tiny outline).
 *
 * @returns {{pending: Array<{relPath, absPath, kind, bytes}>,
 *            oversized: Array<{relPath, bytes}>,
 *            empty: string[]}}
 */
function collectPendingSources (vaultRoot = DEFAULT_VAULT_ROOT, { roots = SOURCE_ROOTS } = {}) {
  const hashes = hatchedSourceHashes(vaultRoot)
  const pending = []
  const oversized = []
  const empty = []

  for (const root of roots) {
    const dir = path.join(vaultRoot, root)
    if (!fs.existsSync(dir)) continue

    const board = root === 'whiteboards'
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue
      const name = entry.name.toLowerCase()
      if (board ? !name.endsWith('.edn') : (root !== 'eggs' && !name.endsWith('.md'))) continue
      // An Office/PDF file in eggs/ is a *source for* conversion, not a source
      // to hatch — convertPendingOfficeSources() turns it into a .md sibling
      // that this scan then picks up on its own. See hatch-all.js / the app.
      if (root === 'eggs' && isOfficeFile(name)) continue

      const absPath = path.join(dir, entry.name)
      const relPath = `${root}/${entry.name}`
      const bytes = fs.statSync(absPath).size

      // Whiteboards are turned into a tiny outline deterministically, so the
      // huge tldraw JSON behind them doesn't count against the size/prose gates.
      if (!board && bytes > MAX_SOURCE_BYTES) { oversized.push({ relPath, bytes }); continue }

      const content = fs.readFileSync(absPath, 'utf8')
      if (!board && meaningfulTextLength(content) < MIN_CONTENT_CHARS) { empty.push(relPath); continue }
      if (hashes.get(relPath) === hashContent(content)) continue // unchanged since last hatch

      pending.push({ relPath, absPath, kind: board ? 'whiteboard' : root, bytes })
    }
  }

  pending.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return { pending, oversized, empty }
}

/**
 * Preview for the "Hatch sources" UI — what a run would touch, with no LLM
 * calls. `totalKb` is the combined size of `pending`, a rough proxy for how
 * much a full run will cost. Converts any pending Office/PDF file first so it
 * shows up as its `.md`; `conversionFailed` lists the ones that wouldn't.
 */
async function pendingSourcesSummary (vaultRoot = DEFAULT_VAULT_ROOT, opts = {}) {
  const conv = await convertPendingOfficeSources(vaultRoot)
  const { pending, oversized, empty } = collectPendingSources(vaultRoot, opts)
  return {
    pending: pending.map((p) => ({ source: humanizeFilename(p.absPath), kind: p.kind, kb: Math.round(p.bytes / 1024) })),
    oversized: oversized.map((o) => ({ source: o.relPath, kb: Math.round(o.bytes / 1024) })),
    empty,
    conversionFailed: conv.failed,
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
  { roots = SOURCE_ROOTS, limit = DEFAULT_BATCH_SIZE, onProgress = () => {}, combined = true } = {}) {
  const conversion = await convertPendingOfficeSources(vaultRoot)
  const { pending, oversized, empty } = collectPendingSources(vaultRoot, { roots })
  const batch = pending.slice(0, limit)

  const hatched = []
  const failed = []

  for (let i = 0; i < batch.length; i++) {
    const file = batch[i]
    const source = humanizeFilename(file.absPath)
    onProgress({ done: i, total: batch.length, current: source })
    const startedAt = Date.now()
    try {
      const hash = hashContent(fs.readFileSync(file.absPath, 'utf8'))

      if (file.kind === 'whiteboard') {
        const result = await hatchWhiteboard(file.absPath, vaultRoot)
        recordHatchedSource(file.relPath, hash, vaultRoot)
        hatched.push({ source, kind: 'whiteboard', results: [result], skipped: [], ms: Date.now() - startedAt })
        onProgress({ done: i + 1, total: batch.length, current: null })
        continue
      }

      const proposal = await proposeHatchPlan(file.absPath, vaultRoot, { copyToEggs: file.kind === 'eggs', combined })
      if (proposal.plan.length === 0) {
        failed.push({ source, error: 'no usable pages proposed (often a transient LLM formatting issue — re-run to retry this file)', ms: Date.now() - startedAt })
      } else {
        // index.md is regenerated once after the whole batch, not per file.
        const { results, skipped } = await commitHatchPlan(proposal, vaultRoot, { regenIndex: false })
        if (results.length === 0) {
          failed.push({ source, error: 'the LLM returned empty content for every proposed page — re-run to retry this file', ms: Date.now() - startedAt })
        } else {
          recordHatchedSource(file.relPath, hash, vaultRoot)
          hatched.push({ source, kind: file.kind, results, skipped, ms: Date.now() - startedAt })
        }
      }
    } catch (err) {
      failed.push({ source, error: (err && err.message) || String(err), ms: Date.now() - startedAt })
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
  { roots = SOURCE_ROOTS, limit = DEFAULT_BATCH_SIZE, skip = 0, combined = true } = {}) {
  await convertPendingOfficeSources(vaultRoot)
  const { pending } = collectPendingSources(vaultRoot, { roots })
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

  const p = await proposeHatchPlan(file.absPath, vaultRoot, { copyToEggs: file.kind === 'eggs', combined })
  fs.writeFileSync(planFile, JSON.stringify({
    relPath: file.relPath, kind: file.kind, hash,
    sourceTitle: p.sourceTitle, sourceContent: p.sourceContent, plan: p.plan, at: Date.now()
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
      { plan: kept, sourceTitle: stash.sourceTitle, sourceContent: stash.sourceContent },
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
  ensureInEggs,
  planCandidates,
  humanizeFilename,
  meaningfulTextLength,
  mapLimit,
  collectPendingSources,
  convertPendingOfficeSources,
  pendingSourcesSummary,
  hatchAllSources,
  hatchWhiteboard,
  SOURCE_ROOTS,
  MAX_SOURCE_BYTES
}
