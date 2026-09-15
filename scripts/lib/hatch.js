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
const { resolvePage, nextFreeSlug, sourceHubMustCreate, findSourceHubByPath, findPersonByEmail, hatchedSourcePaths } = require('./pages')
const { proposeCandidatePages, generatePageContent, proposeAndDraftPages, proposeAndDraftPagesBatch, describeWhiteboard } = require('./prompts')
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
// Max concurrent phase-1 workers. In classic mode each is one file's
// propose/draft; in combined mode each is one byte-budgeted group (one combined
// LLM call). Independent and read-only, so concurrency just cuts wall-clock
// time — capped to stay under provider rate limits.
const HATCH_FILE_CONCURRENCY = 4
// Combined-mode propose can send several small sources in one LLM call. Files
// are packed until their combined raw bytes would exceed this budget — the
// model must hold every source in the group at once, so this is a context/cost
// cap, not a per-file one. A file on its own over budget still hatches, solo,
// through the existing single-file path. Override with KIP_HATCH_GROUP_BYTES.
const MAX_GROUP_BYTES = 150 * 1024
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

/**
 * Splits `files` into contiguous groups whose combined `bytes` stay at or under
 * `maxBytes`, preserving input order. Each group is proposed with one combined
 * LLM call. A file that alone exceeds the budget becomes its own group of one
 * (so it can't drag a smaller neighbour into an oversized call), and a
 * whiteboard is always solo: its raw .edn never goes through the combined
 * prompt — it's rendered deterministically and enriched by its own call.
 */
function groupByByteBudget (files, maxBytes = MAX_GROUP_BYTES) {
  const groups = []
  let current = []
  let currentBytes = 0
  const flush = () => {
    if (!current.length) return
    groups.push(current)
    current = []
    currentBytes = 0
  }
  for (const file of files) {
    if (file.kind === 'whiteboard') {
      flush()
      groups.push([file])
      continue
    }
    const bytes = file.bytes || 0
    if (current.length && currentBytes + bytes > maxBytes) flush()
    current.push(file)
    currentBytes += bytes
  }
  flush()
  return groups
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
    // A person resolves by canonical email first — same email = same person.
    if (candidate.type === 'person' && candidate.email) {
      const byEmail = findPersonByEmail(candidate.email, vaultRoot)
      if (byEmail) return { ...candidate, action: 'update', slug: byEmail.slug }
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

/** The contact fields a `person` candidate carries (kip-app#125), minus any the
 *  model left blank. */
function pickPerson (candidate) {
  const p = {}
  for (const f of ['email', 'org', 'role', 'phone', 'aliases']) {
    if (candidate[f] != null && candidate[f] !== '') p[f] = candidate[f]
  }
  return Object.keys(p).length ? p : null
}

/**
 * The propose+resolve half of Hatch, for a source already in hand (a file the
 * caller read, pasted text, or a fetched document): ask the LLM which pages it
 * touches, draft every body in the same call (combined), synthesize the
 * per-document trace hub when the model didn't propose one, and resolve
 * create-vs-update for each via findSimilarSlug(). No writes — the returned
 * plan is exactly what commitHatchPlan()/resolvePage() would do.
 *
 * Shared by the file-based proposeHatchPlan() and the sidecar's enrichment
 * entry point, so pasted text and a scanned page go through one implementation.
 *
 * @returns {{candidates: Array, plan: Array}}
 */
async function proposePlan ({ sourceTitle, sourceContent, sourceRelPath = null, sourceOriginal = null }, vaultRoot = DEFAULT_VAULT_ROOT, { combined = true } = {}) {
  // The LLM sees a cleaned copy (see stripLogseqNoise) — sourceContent itself
  // stays exactly as read, since it's also used below for the synthesized
  // source page's content hash and is threaded through to commitHatchPlan for
  // later generatePageContent() calls and change-tracking.
  const promptContent = stripLogseqNoise(sourceContent)
  const proposed = combined
    ? await proposeAndDraftPages(sourceTitle, promptContent, vaultRoot)
    : await proposeCandidatePages(sourceTitle, promptContent, vaultRoot)
  return buildHatchPlan(proposed, { sourceTitle, sourceContent, sourceRelPath, sourceOriginal }, vaultRoot, { combined })
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
  const prepared = prepareHatchSource(sourcePath, vaultRoot, { copyToSources })
  const { plan } = await proposePlan(prepared, vaultRoot, { combined })
  return { ...prepared, plan }
}

/**
 * Steps 1-4 of a hatch: resolve the source file, read it, humanize its title,
 * and pull any original-document trace out of its frontmatter. Split out of
 * proposeHatchPlan so the combined-mode batch path can do the per-file I/O
 * while still making one grouped LLM call (kip#111).
 */
function prepareHatchSource (sourcePath, vaultRoot, { copyToSources = true } = {}) {
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

  const sourceRelPath = path.relative(vaultRoot, sourceFilePath).split(path.sep).join('/')
  return { sourceFilePath, sourceContent, sourceTitle, sourceOriginal, sourceRelPath }
}

/**
 * Steps 6-9: filter the raw proposed candidates, synthesize the per-document
 * trace hub when the model proposed none, and resolve create-vs-update. Shared
 * by proposePlan() (the single-source LLM call) and the grouped batch path,
 * which runs it per file over the batch response's per-source pages (kip#111).
 *
 * @returns {{candidates: Array, plan: Array}}
 */
function buildHatchPlan (proposed, { sourceTitle, sourceContent, sourceRelPath = null, sourceOriginal = null }, vaultRoot, { combined = true } = {}) {
  const candidates = proposed.filter((c) =>
    c && typeof c.title === 'string' && c.title.trim() && VALID_TYPES.has(c.type) &&
    (!combined || (typeof c.body === 'string' && c.body.trim())))

  // The per-document trace hub (kip-app#113). The prompt asks for a
  // type:'source' page but nothing enforced it, so a plan could hatch a whole
  // document with nothing linking back to it. Synthesize the hub into the
  // plan HERE — the human reviewing the plan sees it and can deselect it.
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
  return { candidates, plan: planCandidates(candidates, vaultRoot, { sourceRelPath }) }
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

    const person = candidate.type === 'person' ? pickPerson(candidate) : null
    const result = resolvePage({
      type: candidate.type,
      title: candidate.title,
      body: bodies[i],
      tags: candidate.tags || [],
      vaultRoot,
      source: sourceRelPath,
      sourceHash,
      sourceOriginal,
      summary: candidate.summary || null,
      person
    })

    const writtenRaw = fs.readFileSync(path.join(vaultRoot, result.path), 'utf8')
    const { content: writtenBody } = matter(writtenRaw)
    upsertPage(result.slug, result.path, result.type, result.tags, candidate.summary || '', writtenBody, vaultRoot, person ? (person.aliases || []) : [])

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
 * Turns one whiteboard .edn into nest/sources/<slug>.md, PLUS real entity/
 * concept/person pages extracted from the same outline text (kip#-, "mindmap
 * hatching produces no data"). The **Outline** is a deterministic render of
 * the board's shapes (scripts/lib/whiteboard.js). A **Context** section above
 * it is written by the LLM (describeWhiteboard) — an interpretation of the
 * map plus [[links]] to related nest pages; it is best-effort, and the page
 * falls back to outline-only when there's no provider configured or the call
 * fails. Either way the source-mirror page is a full replace each time (not a
 * dated _Update_ append): the board is the source of truth, this page mirrors
 * it.
 *
 * A mindmap's node labels are content, not just shape data — a board with
 * "Alice", "Q3 budget", "Backend migration" as nodes deserves the same
 * entity/concept/person extraction any other hatched document gets, not just
 * a bullet-list mirror nobody's wiki links point at. So the outline text is
 * ALSO run through the standard proposePlan()/commitHatchPlan() pipeline
 * (same as any pages/journals source), one additional LLM call, filtering out
 * its own synthesized 'source' candidate since the mirror page above already
 * covers that role with a richer, whiteboard-specific body.
 *
 * @returns {Promise<{action: 'create'|'update', slug: string, path: string,
 *                     enriched: boolean, extracted: Array<{action, slug, path}>}>}
 */
async function hatchWhiteboard (absPath, vaultRoot = DEFAULT_VAULT_ROOT) {
  const wb = parseWhiteboard(fs.readFileSync(absPath, 'utf8'))
  const boardName = wb.name || path.basename(absPath, path.extname(absPath))
  const slug = slugify(boardName)
  const relBoardPath = path.relative(vaultRoot, absPath).split(path.sep).join('/')

  const relPath = `nest/sources/${slug}.md`
  const filePath = path.join(nestPath(vaultRoot), 'sources', `${slug}.md`)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })

  const today = new Date().toISOString().slice(0, 10)
  const existing = getPage(slug, vaultRoot)
  const created = existing ? String(existing.created).slice(0, 10) : today

  const outline = whiteboardToOutline(wb)

  let context = null
  let summary = `Whiteboard: ${boardName}`
  let extractedPlan = []
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

    try {
      const { plan } = await proposePlan({ sourceTitle: boardName, sourceContent: outline, sourceRelPath: relBoardPath }, vaultRoot, { combined: true })
      extractedPlan = plan.filter((c) => c.type !== 'source')
    } catch {
      // same best-effort rule as describeWhiteboard above — an outline-only
      // mirror page is still a useful result if extraction fails.
    }
  }

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

  let extracted = []
  if (extractedPlan.length) {
    const { results } = await commitHatchPlan(
      { plan: extractedPlan, sourceTitle: boardName, sourceContent: outline, sourceRelPath: relBoardPath, sourceHash: hashContent(outline) },
      vaultRoot, { regenIndex: false })
    extracted = results
  }

  return { action: existing ? 'update' : 'create', slug, path: relPath, enriched: !!context, extracted }
}

/**
 * Strips Logseq-native structural noise that isn't part of a document's
 * actual content: page/block properties (`key:: value` — Logseq's own
 * property syntax, which gray-matter's YAML frontmatter parser doesn't
 * recognize and so never removes, unlike a Hatch-written page's `---`
 * frontmatter), `:LOGBOOK:` time-tracking blocks (auto-appended whenever a
 * block's TODO/DOING/DONE marker changes), and the marker keywords
 * themselves at the start of a bullet.
 *
 * Confirmed against a real mindmap page (kip-app#132's `:block/type
 * "mindmap"`, a plain page — not a whiteboard .edn): four short topics
 * produced zero extracted concepts when hatched as-is (the LLM had to wade
 * through `type:: mindmap`, `LATER`/`DONE` markers, full `:LOGBOOK:`/`CLOCK:`
 * blocks, and `mindmap-color:: red` — more noise than content), and the exact
 * same four topics with this noise stripped produced 4 linked concept/entity
 * pages plus the source page. This is why "hatching a mindmap records no
 * data": the raw file was never processed into text meaningful enough for an
 * LLM to extract from.
 */
function stripLogseqNoise (raw) {
  return raw
    .replace(/[ \t]*:LOGBOOK:[\s\S]*?:END:[ \t]*\n?/g, '')
    .replace(/^[ \t]*[A-Za-z][A-Za-z0-9_-]*::[ \t].*$\n?/gm, '')
    .replace(/^([ \t]*[-*+][ \t]+)(TODO|DOING|DONE|LATER|NOW|CANCELED|CANCELLED|WAITING|IN-PROGRESS)[ \t]+/gm, '$1')
    .replace(/\n{3,}/g, '\n\n')
}

/** Rough count of real prose characters — frontmatter, Logseq noise, and list/markdown punctuation removed. */
function meaningfulTextLength (raw) {
  let body
  try { body = matter(raw).content } catch { body = raw }
  return stripLogseqNoise(body)
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
 * Phase-1 work for a single file: hash it, then either flag a whiteboard or
 * propose its plan with the existing single-file path. Errors are captured per
 * file, never thrown. This is the classic-mode worker and the solo-group worker
 * (an oversized source, a whiteboard) in combined mode.
 */
async function proposeFile (file, vaultRoot, { combined = true } = {}) {
  const source = humanizeFilename(file.absPath)
  const startedAt = Date.now()
  try {
    const hash = hashContent(fs.readFileSync(file.absPath, 'utf8'))
    if (file.kind === 'whiteboard') return { file, source, hash, whiteboard: true, startedAt }
    const proposal = await proposeHatchPlan(file.absPath, vaultRoot, { copyToSources: false, combined })
    return { file, source, hash, proposal, startedAt }
  } catch (err) {
    return { file, source, error: (err && err.message) || String(err), startedAt }
  }
}

/**
 * Phase-1 work for one byte-budgeted group. A group of one takes the unchanged
 * single-file path (proposeFile). A larger group reads each file, makes ONE
 * proposeAndDraftPagesBatch call, then builds each file's plan from its slice
 * of the response. Per-file read/plan errors are captured on that file only, so
 * one bad file can't fail its neighbours. Returns one prepared entry per file,
 * in group order — the shape phase 2 expects.
 */
async function proposeBatchGroup (files, vaultRoot) {
  if (files.length === 1) return [await proposeFile(files[0], vaultRoot, { combined: true })]

  const entries = files.map((file) => {
    const source = humanizeFilename(file.absPath)
    const startedAt = Date.now()
    try {
      const hash = hashContent(fs.readFileSync(file.absPath, 'utf8'))
      return { file, source, hash, startedAt, prepared: prepareHatchSource(file.absPath, vaultRoot, { copyToSources: false }), proposal: null, error: null }
    } catch (err) {
      return { file, source, hash: null, startedAt, prepared: null, proposal: null, error: (err && err.message) || String(err) }
    }
  })

  const live = entries.filter((e) => !e.error)
  if (live.length) {
    const sources = live.map((e) => ({ sourceTitle: e.prepared.sourceTitle, sourceContent: e.prepared.sourceContent }))
    try {
      const results = await proposeAndDraftPagesBatch(sources, vaultRoot)
      live.forEach((entry, i) => {
        const result = results[i] || { pages: [] }
        if (result.error) {
          entry.error = (result.error && result.error.message) || String(result.error)
          return
        }
        try {
          entry.proposal = { ...entry.prepared, plan: buildHatchPlan(result.pages, entry.prepared, vaultRoot, { combined: true }).plan }
        } catch (err) {
          entry.error = (err && err.message) || String(err)
        }
      })
    } catch (err) {
      // The batch call itself failed (e.g. provider down) — that's a whole-group
      // failure, not per file.
      const msg = (err && err.message) || String(err)
      for (const entry of live) entry.error = msg
    }
  }

  return entries.map((e) => e.error
    ? { file: e.file, source: e.source, error: e.error, startedAt: e.startedAt }
    : { file: e.file, source: e.source, hash: e.hash, proposal: e.proposal, startedAt: e.startedAt })
}

/**
 * Hatches up to `limit` pending source files (see collectPendingSources) —
 * propose + commit per file, NO plan review. Records each in hatched_sources
 * by content hash, so a re-run skips it until it changes and a run that dies
 * part-way resumes cleanly. findSimilarSlug()-based create-vs-update still
 * runs per page (that's not what's skipped).
 *
 * `combined` (default true) — propose + draft every body together. Pending
 * files are packed into byte-budgeted groups (see groupByByteBudget /
 * `groupBytes`) and each group costs one combined LLM call, so N small files
 * cost ceil(N/groupSize) calls instead of N. The per-file I/O, create-vs-update
 * planning and the sequential commit are unchanged — only the LLM call is
 * grouped. A file over budget (or a whiteboard) is proposed solo.
 * `combined:false` is the classic path: one propose call plus one generate call
 * per page, per file, with no grouping.
 *
 * One bad source (LLM error, empty plan) goes into `failed`, not thrown.
 * `remaining` is how many pending files are left after this batch.
 *
 * `onProgress({done, total, current})` fires before each file starts and
 * after each finishes — the CLI wires it to a status file the app polls for
 * a live progress bar. It stays file-granular in grouped mode.
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
  { roots = SOURCE_ROOTS, limit = DEFAULT_BATCH_SIZE, onProgress = () => {}, combined = true, force = false, groupBytes = MAX_GROUP_BYTES } = {}) {
  const conversion = await prepareSources(vaultRoot)
  const { pending, oversized, empty } = collectPendingSources(vaultRoot, { roots, force })
  const batch = pending.slice(0, limit)

  // Phase 1 — propose/draft every file. This is the expensive LLM work; it
  // only reads the index (findSimilarSlug), so concurrent proposals can't race
  // each other. Writes happen in phase 2, sequentially. Combined mode groups
  // pending files by byte budget and makes one call per group; classic mode
  // keeps one call per file. Either way `prepared` stays one entry per file,
  // in `batch` order, so phase 2 is unchanged.
  let prepared
  if (combined) {
    const groups = groupByByteBudget(batch, groupBytes)
    const grouped = await mapLimit(groups, HATCH_FILE_CONCURRENCY, (group) => proposeBatchGroup(group, vaultRoot))
    prepared = grouped.flat()
  } else {
    prepared = await mapLimit(batch, HATCH_FILE_CONCURRENCY, (file) => proposeFile(file, vaultRoot, { combined: false }))
  }

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

/**
 * Selects the next review group: up to `groupSize` files, in scan order,
 * stopping early when the combined source bytes would exceed `maxBytes` (a
 * file over budget alone still comes through, as a group of one). Unlike
 * groupByByteBudget() — whose every group maps to one combined LLM call, so it
 * solos whiteboards — a whiteboard may share a review group: it never enters
 * the prompt, so grouping it with its neighbours is pure bookkeeping.
 */
function nextReviewGroup (files, { groupSize, maxBytes = MAX_GROUP_BYTES } = {}) {
  const group = []
  let bytes = 0
  for (const file of files) {
    if (group.length >= groupSize) break
    if (group.length && bytes + (file.bytes || 0) > maxBytes) break
    group.push(file)
    bytes += file.bytes || 0
  }
  return group
}

/**
 * Group-aware "review before writing" propose (kip#112). Like
 * proposeNextPending(), but proposes up to `groupSize` pending files (under a
 * byte budget, see nextReviewGroup) with ONE combined LLM call
 * (proposeAndDraftPagesBatch, which falls back per-file on a bad batch
 * response). Writes nothing; the whole group — bodies and all — is stashed at
 * <coop>/.roost/hatch-plan.json as an ARRAY, one entry per file, for
 * commitReviewedPlanGroup() to pick up.
 *
 * Whiteboards are deterministic, so they skip the LLM call and stay mixed into
 * the same array with a `whiteboard: true` marker, matching today's per-file
 * handling. The return value is slim (no bodies, no source text) for the UI.
 *
 * @returns {{done: true} | {files: Array<{source, relPath, kind, plan?,
 *            whiteboard?, error?}>, remaining: number}}
 */
async function proposeNextPendingGroup (vaultRoot = DEFAULT_VAULT_ROOT,
  { roots = SOURCE_ROOTS, limit = DEFAULT_BATCH_SIZE, skip = 0, groupSize = 1, combined = true, force = false } = {}) {
  await prepareSources(vaultRoot)
  const { pending } = collectPendingSources(vaultRoot, { roots, force })
  const capped = pending.slice(0, limit)
  const group = nextReviewGroup(capped.slice(skip), { groupSize })
  if (group.length === 0) return { done: true }

  const planFile = path.join(vaultRoot, '.roost', 'hatch-plan.json')
  fs.mkdirSync(path.dirname(planFile), { recursive: true })

  const entries = group.map((file) => {
    const source = humanizeFilename(file.absPath)
    const hash = hashContent(fs.readFileSync(file.absPath, 'utf8'))
    if (file.kind === 'whiteboard') return { file, source, hash, whiteboard: true }
    return { file, source, hash, prepared: prepareHatchSource(file.absPath, vaultRoot, { copyToSources: false }) }
  })

  // One combined LLM call covers every regular file in the group; whiteboards
  // ride along without a call.
  const regular = entries.filter((e) => !e.whiteboard)
  if (regular.length) {
    const sources = regular.map((e) => ({ sourceTitle: e.prepared.sourceTitle, sourceContent: e.prepared.sourceContent }))
    const drafted = combined
      ? await proposeAndDraftPagesBatch(sources, vaultRoot)
      : await mapLimit(sources, HATCH_FILE_CONCURRENCY, (s) => proposeCandidatePages(s.sourceTitle, s.sourceContent, vaultRoot))
    regular.forEach((e, i) => {
      const result = combined ? (drafted[i] || { pages: [] }) : { pages: drafted[i] || [] }
      if (result.error) {
        e.error = (result.error && result.error.message) || String(result.error)
        return
      }
      try {
        e.plan = buildHatchPlan(result.pages, e.prepared, vaultRoot, { combined }).plan
      } catch (err) {
        e.error = (err && err.message) || String(err)
      }
    })
  }

  const stash = []
  const files = []
  for (const e of entries) {
    if (e.whiteboard) {
      stash.push({ relPath: e.file.relPath, kind: 'whiteboard', hash: e.hash, whiteboard: true })
      files.push({ source: e.source, relPath: e.file.relPath, kind: 'whiteboard', whiteboard: true })
      continue
    }
    if (e.error) {
      // The per-source fallback call failed for this file alone — surface it
      // so the UI can skip it, without stashing a bogus plan.
      stash.push({ relPath: e.file.relPath, kind: e.file.kind, hash: e.hash, error: e.error, plan: [] })
      files.push({ source: e.source, relPath: e.file.relPath, kind: e.file.kind, error: e.error, plan: [] })
      continue
    }
    stash.push({
      relPath: e.file.relPath, kind: e.file.kind, hash: e.hash,
      sourceTitle: e.prepared.sourceTitle, sourceContent: e.prepared.sourceContent,
      sourceOriginal: e.prepared.sourceOriginal, plan: e.plan
    })
    files.push({
      source: e.source, relPath: e.file.relPath, kind: e.file.kind,
      plan: e.plan.map((c) => ({ slug: c.slug, title: c.title, type: c.type, action: c.action, summary: c.summary || '' }))
    })
  }

  fs.writeFileSync(planFile, JSON.stringify(stash))
  return { files, remaining: capped.length - skip - group.length }
}

/**
 * Commits the array of plans stashed by proposeNextPendingGroup() (kip#112).
 * `keeps` maps each file's coop-relative path to the slugs to keep; a file
 * omitted from `keeps` — or mapped to [] — is skipped (recorded as handled,
 * mirroring today's keptNone case). Whiteboards are deterministic full
 * replaces and are always hatched, `keeps` aside (matching the single-file
 * path).
 *
 * Each file is committed with commitHatchPlan() sequentially — no change to
 * write concurrency — and index.md is regenerated ONCE at the end rather than
 * per file (mirroring hatchAllSources' regenIndex:false batching). Records
 * every committed/skipped source's hash.
 *
 * @returns {Array<{source, results?, skipped?, ms} | {source, error, ms} |
 *            {source, keptNone: true, ms}>}
 */
async function commitReviewedPlanGroup (vaultRoot = DEFAULT_VAULT_ROOT, { keeps = {} } = {}) {
  const planFile = path.join(vaultRoot, '.roost', 'hatch-plan.json')
  const parsed = JSON.parse(fs.readFileSync(planFile, 'utf8'))
  const stash = Array.isArray(parsed) ? parsed : [parsed]

  const results = []
  let wroteSomething = false
  try {
    for (const entry of stash) {
      const source = humanizeFilename(path.join(vaultRoot, entry.relPath))
      const startedAt = Date.now()
      if (entry.error) {
        // A propose that failed for this file: report it, don't write, and
        // leave the hash un-recorded so a later run re-proposes it.
        results.push({ source, error: entry.error, ms: 0 })
        continue
      }
      try {
        if (entry.whiteboard) {
          const result = await hatchWhiteboard(path.join(vaultRoot, entry.relPath), vaultRoot)
          recordHatchedSource(entry.relPath, entry.hash, vaultRoot)
          wroteSomething = true
          results.push({ source, kind: 'whiteboard', results: [result], skipped: [], ms: Date.now() - startedAt })
          continue
        }

        // Omitted / empty keep-set = "skip this file" (the group equivalent of
        // the single-file keptNone case).
        const keepSet = new Set(Array.isArray(keeps[entry.relPath]) ? keeps[entry.relPath] : [])
        const kept = entry.plan.filter((c) => keepSet.has(c.slug))
        if (kept.length === 0) {
          recordHatchedSource(entry.relPath, entry.hash, vaultRoot)
          results.push({ source, keptNone: true, ms: Date.now() - startedAt })
          continue
        }

        const { results: written, skipped } = await commitHatchPlan(
          {
            plan: kept,
            sourceTitle: entry.sourceTitle,
            sourceContent: entry.sourceContent,
            sourceRelPath: entry.relPath,
            sourceHash: entry.hash,
            sourceOriginal: entry.sourceOriginal
          },
          vaultRoot, { regenIndex: false })
        if (written.length === 0) {
          results.push({ source, error: 'every kept page came back empty — try again', ms: Date.now() - startedAt })
          continue
        }
        recordHatchedSource(entry.relPath, entry.hash, vaultRoot)
        wroteSomething = true
        results.push({ source, kind: entry.kind, results: written, skipped, ms: Date.now() - startedAt })
      } catch (err) {
        results.push({ source, error: (err && err.message) || String(err), ms: Date.now() - startedAt })
      }
    }
    if (wroteSomething) regenerateIndexMd(vaultRoot)
    return results
  } finally {
    try { fs.rmSync(planFile, { force: true }) } catch { /* best-effort */ }
  }
}

module.exports = {
  proposeHatchPlan,
  proposePlan,
  commitHatchPlan,
  proposeNextPending,
  commitReviewedPlan,
  proposeNextPendingGroup,
  commitReviewedPlanGroup,
  ensureInSources,
  planCandidates,
  humanizeFilename,
  meaningfulTextLength,
  stripLogseqNoise,
  mapLimit,
  groupByByteBudget,
  collectPendingSources,
  prepareSources,
  pendingSourcesSummary,
  hatchAllSources,
  hatchWhiteboard,
  SOURCE_ROOTS,
  MAX_SOURCE_BYTES,
  MAX_GROUP_BYTES
}
