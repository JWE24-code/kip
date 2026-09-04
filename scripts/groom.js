#!/usr/bin/env node
// Implements the "Groom" workflow from coop/schema.md.
//
// Two modes:
//   node scripts/groom.js            quick — structural checks (meta.db only) +
//                                    one light contradiction pass. Fast, no artifacts.
//   node scripts/groom.js --deep     the weekly session: everything in quick, plus
//                                    per-page _Update_ reconciliation, summary drift,
//                                    missing/broken/dead-end links, content-level merge
//                                    candidates, and a deeper contradiction pass. Many
//                                    LLM calls; writes <coop>/.roost/groom-report.md
//                                    (a checklist), groom-metrics.json and, while it
//                                    runs, groom-progress.json for the app to poll.
//   --json    machine-readable stdout   --trace  full prompts/responses to groom-trace.jsonl
//
// Read-only in every mode — groom reports, it never edits a nest/ page.
require('dotenv').config()
const fs = require('node:fs')
const path = require('node:path')

const { openDb } = require('./lib/db')
const { appendLog, setPageSummary, setSectionSummaries, splitSections, getPageSections, slugSimilarity, extractWikilinkSlugs, SIMILARITY_THRESHOLD } = require('./lib/roost')
const { DEFAULT_VAULT_ROOT, nestPath, TYPE_DIRS } = require('./lib/paths')
const {
  flagContradictions, reviewPageCoherence, checkSummaryAccuracy, checkSectionSummaries, confirmMissingLinks, checkPagesSameSubject
} = require('./lib/prompts')
const { describeProvider } = require('./lib/llm')
const { collectPendingSources } = require('./lib/hatch')
const telemetry = require('./lib/telemetry')
const { createRunReporter } = require('./lib/run-progress')
const { installFeedbackPoster } = require('./lib/feedback-poster')

const MAX_CONTRADICTION_GROUP_SIZE = 6
const DEEP_CONTRADICTION_GROUP_SIZE = 12
const MAX_MERGE_PAIRS = 30
const MISSING_LINK_MAX_PER_PAGE = 8
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g

function slugifyLinkTarget (text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
function humanizeSlug (slug) {
  return slug.replace(/-/g, ' ')
}
function escapeRe (s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
/** date-shaped targets ([[2026-08-26]]) are valid Logseq journal refs, not broken nest links. */
function isDateSlug (s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s)
}

/** Pages with no inbound [[wikilink]] from any *other* page. */
function findOrphans (pages) {
  const allSlugs = new Set(pages.map((p) => p.slug))
  const linkedFrom = new Set()

  for (const p of pages) {
    WIKILINK_RE.lastIndex = 0
    let match
    while ((match = WIKILINK_RE.exec(p.body)) !== null) {
      const target = slugifyLinkTarget(match[1])
      if (target !== p.slug && allSlugs.has(target)) linkedFrom.add(target)
    }
  }

  return pages.filter((p) => !linkedFrom.has(p.slug)).map((p) => p.slug)
}

/** Drift between meta.db's `pages` rows and what's actually under coop/nest/. */
function findDrift (vaultRoot, dbPages) {
  const dbSlugs = new Set(dbPages.map((p) => p.slug))
  const missingFiles = [] // in meta.db, no file on disk
  const untrackedFiles = [] // on disk, no meta.db row

  for (const dir of Object.values(TYPE_DIRS)) {
    const full = path.join(nestPath(vaultRoot), dir)
    if (!fs.existsSync(full)) continue
    for (const file of fs.readdirSync(full)) {
      if (!file.endsWith('.md')) continue
      const slug = file.slice(0, -3)
      if (!dbSlugs.has(slug)) {
        untrackedFiles.push(`nest/${dir}/${file}`)
      }
    }
  }

  for (const p of dbPages) {
    if (!fs.existsSync(path.join(vaultRoot, p.path))) {
      missingFiles.push({ slug: p.slug, path: p.path })
    }
  }

  return { missingFiles, untrackedFiles }
}

/** All page pairs whose slug similarity meets the duplicate-prevention threshold. */
function findNearDuplicates (dbPages) {
  const results = []
  for (let i = 0; i < dbPages.length; i++) {
    for (let j = i + 1; j < dbPages.length; j++) {
      const score = slugSimilarity(dbPages[i].slug, dbPages[j].slug)
      if (score >= SIMILARITY_THRESHOLD) {
        results.push({ slugs: [dbPages[i].slug, dbPages[j].slug], score: Math.round(score * 100) / 100 })
      }
    }
  }
  results.sort((a, b) => b.score - a.score)
  return results
}

/** [[wikilink]] targets on a page that slugify to no existing page (dates excluded). */
function findBrokenLinks (pages) {
  const allSlugs = new Set(pages.map((p) => p.slug))
  const out = []
  for (const p of pages) {
    const bad = [...new Set(extractWikilinkSlugs(p.body))].filter((t) => t && !isDateSlug(t) && !allSlugs.has(t))
    if (bad.length) out.push({ slug: p.slug, badTargets: bad })
  }
  return out
}

/** Pages that link out to no other existing page (source pages especially should link out). */
function findDeadEnds (pages) {
  const allSlugs = new Set(pages.map((p) => p.slug))
  return pages
    .filter((p) => extractWikilinkSlugs(p.body).every((t) => t === p.slug || !allSlugs.has(t)))
    .map((p) => p.slug)
}

function stripForMentionScan (body) {
  return body
    .replace(/\[\[[^\]]+\]\]/g, ' ') // existing links — don't re-flag
    .replace(/_Update \d{4}-\d{2}-\d{2}:_/g, ' ')
}

/**
 * For each page, other pages' names that appear in its prose (word-boundary,
 * case-insensitive) without an existing [[link]]. Longer names first, capped —
 * these are candidates for an LLM confirm pass, not findings.
 * @returns {Array<{slug: string, candidates: string[]}>}
 */
function findMissingLinkCandidates (pages, { maxPerPage = MISSING_LINK_MAX_PER_PAGE } = {}) {
  const existing = new Set(pages.map((p) => p.slug))
  const names = pages
    .map((p) => ({ slug: p.slug, name: humanizeSlug(p.slug) }))
    .filter((n) => n.name.length >= 3)
    .sort((a, b) => b.name.length - a.name.length)
    .map((n) => ({ slug: n.slug, rx: new RegExp(`\\b${escapeRe(n.name)}\\b`, 'i') }))

  const out = []
  for (const p of pages) {
    const linked = new Set(extractWikilinkSlugs(p.body))
    const scan = stripForMentionScan(p.body)
    const candidates = []
    for (const n of names) {
      if (n.slug === p.slug || linked.has(n.slug) || !existing.has(n.slug)) continue
      if (n.rx.test(scan)) {
        candidates.push(n.slug)
        if (candidates.length >= maxPerPage) break
      }
    }
    if (candidates.length) out.push({ slug: p.slug, candidates })
  }
  return out
}

/**
 * Groups pages into batches of at most `maxSize` for contradiction-checking:
 * primarily by type, sub-split by shared tags when a type has too many pages
 * for one group. Singletons (nothing to compare against) are dropped.
 */
function buildContradictionGroups (pages, maxSize = MAX_CONTRADICTION_GROUP_SIZE) {
  const byType = new Map()
  for (const p of pages) {
    if (!byType.has(p.type)) byType.set(p.type, [])
    byType.get(p.type).push(p)
  }

  const groups = []
  for (const typePages of byType.values()) {
    if (typePages.length <= 1) continue
    if (typePages.length <= maxSize) {
      groups.push(typePages)
      continue
    }

    const remaining = new Set(typePages.map((p) => p.slug))
    const tagCounts = new Map()
    for (const p of typePages) for (const t of p.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1)
    const tagsByRarity = [...tagCounts.entries()].sort((a, b) => a[1] - b[1]).map(([t]) => t)

    for (const tag of tagsByRarity) {
      if (remaining.size === 0) break
      const group = typePages.filter((p) => remaining.has(p.slug) && p.tags.includes(tag)).slice(0, maxSize)
      if (group.length > 1) {
        groups.push(group)
        for (const p of group) remaining.delete(p.slug)
      }
    }

    const leftover = typePages.filter((p) => remaining.has(p.slug))
    for (let i = 0; i < leftover.length; i += maxSize) {
      const chunk = leftover.slice(i, i + maxSize)
      if (chunk.length > 1) groups.push(chunk)
    }
  }
  return groups
}

/** @param {Function} flagFn injectable for tests — defaults to the real LLM call. */
async function findContradictions (pages, vaultRoot, flagFn = flagContradictions, maxSize = MAX_CONTRADICTION_GROUP_SIZE) {
  const groups = buildContradictionGroups(pages, maxSize)
  const all = []
  for (const group of groups) {
    const forPrompt = group.map((p) => ({ slug: p.slug, type: p.type, content: p.body }))
    try {
      const found = await flagFn(forPrompt, vaultRoot)
      all.push(...found)
    } catch (err) {
      console.error(`Warning: contradiction check failed for a group of ${group.length} page(s) (${err.message}); skipping.`)
    }
  }
  return all
}

/** One page per entity/concept grouped with the source pages that [[link]] it (for cross-checking). */
function buildEntitySourceGroups (pages, { maxGroup = 8 } = {}) {
  const sources = pages.filter((p) => p.type === 'source')
  const groups = []
  for (const e of pages) {
    if (e.type === 'source') continue
    const citing = sources.filter((s) => extractWikilinkSlugs(s.body).includes(e.slug))
    if (citing.length >= 1) groups.push([e, ...citing.slice(0, maxGroup - 1)])
  }
  return groups
}

/** Same-type page pairs the slug check missed that share ≥2 outbound links or a rare tag. */
function buildMergePairs (pages, nearDuplicates) {
  const flagged = new Set(nearDuplicates.map((d) => d.slugs.slice().sort().join('|')))
  const byType = new Map()
  for (const p of pages) {
    if (!byType.has(p.type)) byType.set(p.type, [])
    byType.get(p.type).push(p)
  }
  const tagCount = new Map()
  for (const p of pages) for (const t of (p.tags || [])) tagCount.set(t, (tagCount.get(t) || 0) + 1)

  const scored = []
  for (const group of byType.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]
        const b = group[j]
        if (flagged.has([a.slug, b.slug].sort().join('|'))) continue
        const aLinks = new Set(extractWikilinkSlugs(a.body))
        const bLinks = new Set(extractWikilinkSlugs(b.body))
        const sharedLinks = [...aLinks].filter((s) => bLinks.has(s)).length
        const sharedRareTags = (a.tags || []).filter((t) => (b.tags || []).includes(t) && (tagCount.get(t) || 0) <= 3).length
        if (sharedLinks >= 2 || sharedRareTags >= 1) scored.push({ pair: [a, b], score: sharedLinks + 2 * sharedRareTags })
      }
    }
  }
  return scored.sort((x, y) => y.score - x.score).map((s) => s.pair)
}

function needsCoherenceReview (body) {
  return (body.split('_Update ').length - 1) >= 2 || body.length > 1500
}

function dedupeContradictions (list) {
  const seen = new Set()
  const out = []
  for (const c of list) {
    const key = (c.slugs || []).slice().sort().join('|') + '::' + String(c.description || '').slice(0, 40)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

async function runGroom (vaultRoot = DEFAULT_VAULT_ROOT, {
  flagFn = flagContradictions,
  deep = false,
  onProgress = () => {},
  deps = {}
} = {}) {
  const coherenceFn = deps.reviewPageCoherence || reviewPageCoherence
  const summaryFn = deps.checkSummaryAccuracy || checkSummaryAccuracy
  const sectionSummaryFn = deps.checkSectionSummaries || checkSectionSummaries
  const missingLinksFn = deps.confirmMissingLinks || confirmMissingLinks
  const sameSubjectFn = deps.checkPagesSameSubject || checkPagesSameSubject

  const db = openDb(vaultRoot)
  let dbPages, bodyBySlug
  try {
    dbPages = db.prepare('SELECT slug, path, type, tags, summary FROM pages').all()
      .map((p) => ({ ...p, tags: JSON.parse(p.tags) }))
    bodyBySlug = new Map(db.prepare('SELECT slug, body FROM pages_fts').all().map((r) => [r.slug, r.body]))
  } finally {
    db.close()
  }

  const pages = dbPages.map((p) => ({ ...p, body: bodyBySlug.get(p.slug) || '' }))

  const report = {
    deep,
    orphans: findOrphans(pages),
    drift: findDrift(vaultRoot, dbPages),
    nearDuplicates: findNearDuplicates(dbPages),
    // The source-side check the vault's Lint calls "un-ingested raw" —
    // specifically the *changed* half (kip-app#113): a hatched source edited
    // since. New drops are the hatch preview's job; re-hatching a changed
    // one re-appends the whole document, so the user wants to know.
    changedSources: collectPendingSources(vaultRoot).pending
      .filter((p) => p.status === 'changed').map((p) => p.relPath),
    contradictions: await findContradictions(pages, vaultRoot, flagFn,
      deep ? DEEP_CONTRADICTION_GROUP_SIZE : MAX_CONTRADICTION_GROUP_SIZE)
  }

  if (!deep) return report

  // --- deterministic deep checks ---
  report.brokenLinks = findBrokenLinks(pages)
  report.deadEnds = findDeadEnds(pages)
  const missingCandidates = findMissingLinkCandidates(pages)

  // --- LLM deep checks ---
  const coherenceTargets = pages.filter((p) => needsCoherenceReview(p.body))
  const summaryTargets = pages.filter((p) => p.summary && p.summary.trim() && p.body.length > 400)
  const sectionTargets = pages.filter((p) => splitSections(p.body).some((s) => s.heading))
  const mergePairs = buildMergePairs(pages, report.nearDuplicates).slice(0, MAX_MERGE_PAIRS)
  const xrefGroups = buildEntitySourceGroups(pages)

  const total = coherenceTargets.length + summaryTargets.length + sectionTargets.length +
    missingCandidates.length + mergePairs.length + xrefGroups.length
  let done = 0
  const tick = (current) => onProgress({ done: done++, total, current })

  report.pageCoherence = []
  for (const p of coherenceTargets) {
    tick(`coherence: ${p.slug}`)
    const r = await coherenceFn(p.slug, p.body, vaultRoot)
    if (r.issues.length || r.consolidate) report.pageCoherence.push({ slug: p.slug, issues: r.issues, consolidate: r.consolidate })
  }

  // Summary drift: the deep pass computes a better one-liner than hatch wrote.
  // Persist it to the index (meta.db `pages.summary`, kip-app#115) instead of
  // only reporting it — the answer prompt reads that column, so a stale
  // summary would otherwise keep misdescribing the page on every turn. This
  // touches only the derived index, never a nest/ markdown file.
  report.summaryDrift = []
  for (const p of summaryTargets) {
    tick(`summary: ${p.slug}`)
    const r = await summaryFn(p.slug, p.summary, p.body, vaultRoot)
    if (r.ok || !r.suggested || !r.suggested.trim()) continue
    const applied = setPageSummary(p.slug, r.suggested.trim(), vaultRoot)
    report.summaryDrift.push({ slug: p.slug, current: p.summary, suggested: r.suggested.trim(), applied })
  }

  // Section-summary drift (kip-app#106): the per-section one-liners hatch wrote
  // may go stale as a page grows new _Update_ sections. Re-check each heading
  // section and persist the refreshed one-liner to the index — meta.db only,
  // never a nest/ file.
  report.sectionSummaryDrift = []
  for (const p of sectionTargets) {
    tick(`sections: ${p.slug}`)
    const current = getPageSections(p.slug, vaultRoot)
    const byHeading = new Map(current.map((s) => [s.heading.trim().toLowerCase(), s]))
    const sections = splitSections(p.body).map((s) => ({
      ...s,
      summary: (byHeading.get(s.heading.trim().toLowerCase()) || {}).summary || ''
    }))
    const r = await sectionSummaryFn(p.slug, sections, vaultRoot)
    const updates = (r.updates || []).filter((u) => u && typeof u.heading === 'string' && typeof u.summary === 'string' && u.summary.trim())
    if (!updates.length) continue
    const applied = setSectionSummaries(p.slug, updates, vaultRoot)
    if (applied) report.sectionSummaryDrift.push({ slug: p.slug, updates })
  }

  report.missingLinks = []
  for (const c of missingCandidates) {
    tick(`links: ${c.slug}`)
    const page = pages.find((p) => p.slug === c.slug)
    const confirmed = await missingLinksFn(c.slug, page.body, c.candidates, vaultRoot)
    if (confirmed.length) report.missingLinks.push({ slug: c.slug, shouldLink: confirmed })
  }

  report.mergeCandidates = []
  for (const [a, b] of mergePairs) {
    tick(`merge: ${a.slug} / ${b.slug}`)
    const r = await sameSubjectFn(
      { slug: a.slug, type: a.type, body: a.body },
      { slug: b.slug, type: b.type, body: b.body }, vaultRoot)
    if (r.same) report.mergeCandidates.push({ slugs: [a.slug, b.slug], reason: r.reason })
  }

  for (const group of xrefGroups) {
    tick(`cross-check: ${group[0].slug}`)
    try {
      const forPrompt = group.map((p) => ({ slug: p.slug, type: p.type, content: p.body }))
      report.contradictions.push(...await flagFn(forPrompt, vaultRoot))
    } catch { /* skip a bad group */ }
  }
  report.contradictions = dedupeContradictions(report.contradictions)

  onProgress({ done: total, total, current: null })
  return report
}

/**
 * Inverts a groom report into a slug → findings map for answer-time use
 * (kip-app#116). Peck intersects this with the pages an answer cited and warns
 * when it drew on a page groom flagged. Every finding is `{ kind, note }`, plus
 * `slugs` for the pairwise ones (contradiction, near-duplicate, merge). No LLM
 * — just a re-shape of what runGroom already computed.
 */
function buildLintIndex (report) {
  const idx = {}
  const add = (slug, finding) => {
    if (!slug) return
    ;(idx[slug] = idx[slug] || []).push(finding)
  }

  for (const slug of report.orphans || []) {
    add(slug, { kind: 'orphan', note: 'nothing links to this page' })
  }
  for (const d of report.nearDuplicates || []) {
    add(d.slugs[0], { kind: 'near-duplicate', note: `near-duplicate slug of ${d.slugs[1]} (similarity ${d.score})`, slugs: d.slugs })
    add(d.slugs[1], { kind: 'near-duplicate', note: `near-duplicate slug of ${d.slugs[0]} (similarity ${d.score})`, slugs: d.slugs })
  }
  for (const m of (report.drift && report.drift.missingFiles) || []) {
    add(m.slug, { kind: 'drift', note: 'in the index but missing on disk — run rebuild-roost' })
  }
  for (const c of report.contradictions || []) {
    for (const slug of c.slugs || []) add(slug, { kind: 'contradiction', note: c.description, slugs: c.slugs })
  }
  // deep-only findings
  for (const c of report.pageCoherence || []) {
    add(c.slug, { kind: 'coherence', note: c.issues.join(' ') || 'internal inconsistency across its _Update_ sections' })
  }
  for (const s of report.summaryDrift || []) {
    // A drift that groom just refreshed in the index (kip-app#115) is no
    // longer an outstanding issue — only surface one it couldn't apply.
    if (s.applied) continue
    add(s.slug, { kind: 'summary-drift', note: `its index summary may not fit${s.suggested ? ` (suggested: ${s.suggested})` : ''}` })
  }
  for (const b of report.brokenLinks || []) {
    add(b.slug, { kind: 'broken-link', note: `links to non-existent page(s): ${b.badTargets.join(', ')}` })
  }
  for (const slug of report.deadEnds || []) {
    add(slug, { kind: 'dead-end', note: 'links out to no other page' })
  }
  for (const m of report.mergeCandidates || []) {
    add(m.slugs[0], { kind: 'merge-candidate', note: `possible duplicate of ${m.slugs[1]}: ${m.reason}`, slugs: m.slugs })
    add(m.slugs[1], { kind: 'merge-candidate', note: `possible duplicate of ${m.slugs[0]}: ${m.reason}`, slugs: m.slugs })
  }
  return idx
}

/**
 * Writes <coop>/.roost/lint.json — a compact slug → findings map from the
 * groom report, for Peck to consult at answer time (kip-app#116). Written on
 * every run (quick and deep); a quick run carries only the deterministic
 * findings. Returns its path.
 */
function writeLintJson (vaultRoot, report) {
  const dir = path.join(vaultRoot, '.roost')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'lint.json')
  fs.writeFileSync(file, JSON.stringify({
    generated: new Date().toISOString(),
    deep: !!report.deep,
    findings: buildLintIndex(report)
  }, null, 2) + '\n')
  return file
}

/** Writes <coop>/.roost/groom-report.md — a dated checklist. Returns its path. */
function writeGroomReport (vaultRoot, report) {
  const today = new Date().toISOString().slice(0, 10)
  const lines = [
    `# Groom report — ${today}`,
    '',
    '_Deep pass. Read-only for your notes — no `nest/` file was changed. ' +
      '(The one exception: a drifted page summary is refreshed in the index — ' +
      'see "Summary drift".) Each item is a suggestion; check it off as you handle it._',
    ''
  ]

  const section = (title, items, render) => {
    lines.push(`## ${title} (${items.length})`)
    if (!items.length) { lines.push('', '_none_', ''); return }
    for (const it of items) lines.push(`- [ ] ${render(it)}`)
    lines.push('')
  }

  section('Page coherence', report.pageCoherence || [], (c) =>
    `**${c.slug}** — ${c.issues.join(' ')}${c.consolidate ? ' _(suggest consolidating into a current-state summary + a dated history)_' : ''}`)
  section('Summary drift', report.summaryDrift || [], (s) =>
    `**${s.slug}** — index summary ${s.applied ? 'refreshed' : 'should be'}: "${s.suggested}" _(was "${s.current}")_`)
  section('Section summaries refreshed', report.sectionSummaryDrift || [], (s) =>
    `**${s.slug}** — ${s.updates.map((u) => `"${u.heading}" → "${u.summary}"`).join('; ')}`)
  section('Merge candidates', report.mergeCandidates || [], (m) =>
    `**${m.slugs[0]}** ↔ **${m.slugs[1]}** — ${m.reason}`)
  section('Missing links', report.missingLinks || [], (l) =>
    `**${l.slug}** — mentions but does not link: ${l.shouldLink.map((s) => `[[${s}]]`).join(', ')}`)
  section('Broken links', report.brokenLinks || [], (b) =>
    `**${b.slug}** — links to non-existent page(s): ${b.badTargets.join(', ')}`)
  section('Dead-end pages', report.deadEnds || [], (slug) => `**${slug}** — links out to nothing`)
  section('Possible contradictions', report.contradictions || [], (c) =>
    `[${c.slugs.join(', ')}] ${c.description}`)
  section('Orphan pages', report.orphans || [], (slug) => `**${slug}** — nothing links to it`)

  const drift = [
    ...(report.drift.missingFiles || []).map((m) => `in meta.db, missing on disk: ${m.slug}`),
    ...(report.drift.untrackedFiles || []).map((f) => `on disk, not in meta.db: ${f}`)
  ]
  section('Filesystem drift', drift, (s) => `${s} — run \`npm run rebuild-roost\``)
  section('Sources changed since hatch', report.changedSources || [], (s) =>
    `\`${s}\` — edited after its last hatch; re-hatching re-appends the whole document (consider whether the new content belongs on the existing pages)`)
  section('Near-duplicate slugs', report.nearDuplicates || [], (d) =>
    `${d.slugs[0]} ↔ ${d.slugs[1]} (similarity ${d.score})`)

  const dir = path.join(vaultRoot, '.roost')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'groom-report.md')
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

function printReport (report) {
  console.log(`# Groom report${report.deep ? ' (deep)' : ''}\n`)

  const list = (title, items, render) => {
    console.log(`## ${title} (${items.length})`)
    if (!items.length) console.log('  none')
    else for (const it of items) console.log(`  - ${render(it)}`)
    console.log('')
  }

  if (report.deep) {
    list('Page coherence', report.pageCoherence || [], (c) => `${c.slug}: ${c.issues.join(' ')}`)
    list('Summary drift', report.summaryDrift || [], (s) => `${s.slug}: -> "${s.suggested}"`)
    list('Section summaries', report.sectionSummaryDrift || [], (s) => `${s.slug}: ${s.updates.map((u) => `${u.heading} -> "${u.summary}"`).join('; ')}`)
    list('Merge candidates', report.mergeCandidates || [], (m) => `${m.slugs.join(' <-> ')}: ${m.reason}`)
    list('Missing links', report.missingLinks || [], (l) => `${l.slug} -> ${l.shouldLink.join(', ')}`)
    list('Broken links', report.brokenLinks || [], (b) => `${b.slug} -> ${b.badTargets.join(', ')}`)
    list('Dead-end pages', report.deadEnds || [], (s) => s)
  }

  list('Orphan pages', report.orphans, (s) => s)

  const drift = [
    ...report.drift.missingFiles.map((m) => `in meta.db, missing on disk: ${m.slug} (${m.path})`),
    ...report.drift.untrackedFiles.map((f) => `on disk, not in meta.db: ${f}`)
  ]
  list('Filesystem drift', drift, (s) => s)
  if (drift.length) console.log('  -> run `npm run rebuild-roost` to fix\n')

  list('Sources changed since hatch', report.changedSources || [], (s) => s)
  list('Near-duplicate slugs', report.nearDuplicates, (d) => `${d.slugs[0]} <-> ${d.slugs[1]} (similarity ${d.score})`)
  list('Possible contradictions', report.contradictions, (c) => `[${c.slugs.join(', ')}] ${c.description}`)
}

async function main () {
  const jsonOutput = process.argv.includes('--json')
  const deep = process.argv.includes('--deep')
  const traceOn = process.argv.includes('--trace')
  const vaultRoot = DEFAULT_VAULT_ROOT

  // stderr, not stdout — --json mode's stdout must be pure JSON (the Kip Coop
  // status panel JSON.parses the entire stdout stream).
  console.error(describeProvider())

  let reporter = null
  let onProgress = () => {}
  if (deep) {
    console.error('  deep groom — many LLM calls, can take several minutes')
    const roostDir = path.join(vaultRoot, '.roost')
    telemetry.reset()
    installFeedbackPoster({ vaultRoot })
    reporter = createRunReporter({
      dir: roostDir,
      progressFile: path.join(roostDir, 'groom-progress.json'),
      metricsFile: path.join(roostDir, 'groom-metrics.json'),
      traceFile: path.join(roostDir, 'groom-trace.jsonl'),
      traceOn
    })
    reporter.setProgress({ done: 0, total: null, current: null })
    reporter.flush(true)
    onProgress = (p) => {
      reporter.setProgress({ done: p.done, total: p.total, current: p.current })
      reporter.flush(true)
      if (p.current) console.error(`  [${p.done}/${p.total}] ${p.current}`)
    }
  }

  const report = await runGroom(vaultRoot, { deep, onProgress })

  // Answer-time lint artifact (kip-app#116) — written on every run so Peck
  // always has the freshest findings for the pages an answer cites.
  report.lintPath = writeLintJson(vaultRoot, report)

  if (deep) {
    report.reportPath = writeGroomReport(vaultRoot, report)
    reporter.flush(false)
    reporter.writeMetrics()
    reporter.close()
  }

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    printReport(report)
    if (report.reportPath) console.error(`\nChecklist written to ${report.reportPath}`)
  }

  const driftCount = report.drift.missingFiles.length + report.drift.untrackedFiles.length
  let summary = `groom${deep ? ' (deep)' : ''} pass — orphans: ${report.orphans.length}, drift: ${driftCount}, ` +
    `near-duplicate slugs: ${report.nearDuplicates.length}, contradictions: ${report.contradictions.length}`
  if (deep) {
    summary += `, coherence: ${report.pageCoherence.length}, summary drift: ${report.summaryDrift.length}, ` +
      `merge candidates: ${report.mergeCandidates.length}, missing links: ${report.missingLinks.length}, ` +
      `broken links: ${report.brokenLinks.length}, dead ends: ${report.deadEnds.length}`
  }
  appendLog('groom', summary, [], vaultRoot)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}

module.exports = {
  runGroom,
  findOrphans,
  findDrift,
  findNearDuplicates,
  findBrokenLinks,
  findDeadEnds,
  findMissingLinkCandidates,
  buildContradictionGroups,
  buildEntitySourceGroups,
  buildMergePairs,
  findContradictions,
  writeGroomReport,
  buildLintIndex,
  writeLintJson
}
