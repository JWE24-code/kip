// Core logic for the "Peck" workflow (coop/schema.md), extracted out of
// scripts/peck.js so both the CLI (interactive) and other callers (the Kip
// app's Peck panel, via scripts/chat.js) share it.
//
// Peck does two things, auto-detected per turn:
//   - a QUESTION  -> search the nest, read candidates, answer with [[slug]]
//                    citations (askQuestion / answerFromPages). If the coop
//                    has skills configured (scripts/lib/skills.js), the model
//                    may call them mid-answer — web search, a spreadsheet
//                    read, ... — and `steps` records what it ran.
//   - a STATEMENT -> a fact to remember: file it onto the relevant existing
//                    page(s), or create a page plainly, and log a `told`
//                    entry (captureFacts + fileCapturedFacts).
// peckTurn() is the unified entry that classifies and dispatches.
const fs = require('node:fs')
const path = require('node:path')
const matter = require('gray-matter')

const { searchPages, upsertPage, regenerateIndexMd, appendLog, extractWikilinkSlugs, getPage } = require('./roost')
const { resolvePage } = require('./pages')
const { extractKeyTerms, answerQuestion, answerQuestionWithSkills, answerFromWeb, isNoAnswer, captureFacts } = require('./prompts')
const { discoverSkills, runSkill } = require('./skills')
const { buildWebSource, parseWebSearchOutput } = require('./web-sources')
const { looksLikeReminder } = require('./reminders')
const { DEFAULT_VAULT_ROOT } = require('./paths')
const telemetry = require('./telemetry')

const BROAD_SEARCH_LIMIT = 15
const CAPTURE_TYPES = new Set(['entity', 'concept'])

// Latency: both the key-term expansion pass and the skills tool loop cost an
// LLM round-trip. Skip each when it's very unlikely to change the answer.

// The direct FTS search already found this many ranked hits -> skip the LLM
// key-term pass (it mostly earns its keep when the question shares few nouns
// with the nest).
const DIRECT_HIT_CONFIDENCE = 3

// The question plausibly needs a skill (external/current info, a generated
// document, a Kip action). Retrieval being thin also triggers the skills path.
const SKILL_HINT_RE = new RegExp(
  '\\b(latest|current(?:ly)?|today|tonight|recent(?:ly)?|nowadays|as of \\d|up[- ]?to[- ]?date|this (?:week|month|year))\\b' +
  '|\\b(?:search|look ?up|google|web ?search|find (?:online|on the web)|on the (?:web|internet))\\b' +
  '|\\bnews\\b|\\bweather\\b|\\bprice of\\b|\\bstock price\\b|\\bwho (?:won|is winning|leads)\\b|\\bscore of\\b' +
  '|\\b(?:make|create|draft|generate|build|produce|compose|prepare|export|convert|turn)\\b[^.?!]{0,50}' +
    '\\b(?:doc|document|word|\\.docx|deck|slides?|presentation|powerpoint|\\.pptx|spreadsheet|sheet|excel|\\.xlsx|\\.csv|chart|graph|report|email|letter|brief)\\b' +
  '|\\b(?:hatch|groom|rebuild[- ]?roost|coop status|open settings)\\b',
  'i')

function mightNeedSkill (question, pageCount) {
  return pageCount < 2 || SKILL_HINT_RE.test(String(question || ''))
}

// A Peck turn is a 'question' (answer it — running a skill first if that helps)
// or a 'statement' (a fact to file into the nest). Heuristic on purpose: fast,
// free, deterministic, and not at the mercy of a weak model mis-reading a plain
// declarative like "I started learning to sail".
//   question: a trailing "?", a leading question word, OR a leading "do this for
//     me" verb (make/create/summarize/…) — the last so "build me a deck from the
//     Q3 sheet" reaches the skills tool loop instead of the fact-capture path.
//   statement: anything else.
// Interrogatives / question openers. English, plus the main Latin-script
// languages (DE/NL/FR/ES/IT/PT) — a nest in another language would otherwise
// have every question that lacks a trailing "?" filed as a fact (kip-app#97).
const QUESTION_START_RE = new RegExp('^\\s*(?:' + [
  // EN
  'who|what|whats|when|where|why|how|which|whose|whom|is|are|was|were|do|does|did|can|could|should|would|will|have|has|had|am',
  'tell me|remind me|show me|list|give me|find|search|look up|any\\b',
  'make|create|build|generate|draft|write|compose|produce|prepare|compile|convert|summari[sz]e|turn',
  // DE
  'wer|was|wann|wo|warum|wieso|weshalb|wie|welche[rs]?|wessen|ist|sind|war|waren|hat|haben|kann|können|soll|wird|gibt es|zeig mir|erstelle|fasse?\\b|zusammenfass',
  // NL
  'wie|wat|wanneer|waar|waarom|hoe|welke?|is|zijn|was|waren|heeft|hebben|kan|kun(?:nen)?|moet|toon|maak|vat samen|geef',
  // FR
  'qui|que|quoi|quel(?:le)?s?|quand|où|pourquoi|comment|combien|est-ce|montre|résume|fais|liste|donne|cherche',
  // ES
  'qui[eé]n(?:es)?|qu[eé]|cu[aá]l(?:es)?|cu[aá]ndo|d[oó]nde|ad[oó]nde|por qu[eé]|c[oó]mo|cu[aá]nto[sa]?|mu[eé]strame|resume|haz|lista|busca|dame',
  // IT
  'chi|che|cosa|quale|quali|quando|dove|perch[eé]|come|quanto[ei]?|mostrami|riepiloga|fai|elenca|cerca',
  // PT
  'quem|que|qual|quais|quando|onde|aonde|por que|porqu[eê]|como|quanto[sa]?|mostre|resuma|fa[çc]a|liste|busque'
].join('|') + ')\\b', 'i')

// Any question mark anywhere — trailing is the common case, but "Globex, wer
// ist der CEO?" and fullwidth / inverted marks count too.
const QUESTION_MARK_RE = /[?？¿؟]/

// A short input right after a Kip answer that reads as "keep going" rather
// than a new fact — treat these as a question even without a '?' or a
// question word (kip-app#82).
const CONTINUATION_RE = /^\s*(and\b|also\b|what about|how about|tell me more|say more|go on|elaborate|expand|more\b|why\b|the (first|second|third|fourth|last|next|other|previous) one|that one|those|it\?|really\?|source\??|says who\??)/i

/** 'question' vs 'statement' for a Peck turn. `history` (optional) lets a
 *  bare follow-up after a Kip answer classify as a question (kip-app#82). */
function classifyPeckInput (input, history = []) {
  const t = String(input || '').trim()
  if (!t) return 'question'
  if (QUESTION_MARK_RE.test(t) || QUESTION_START_RE.test(t)) return 'question'
  const lastWasAnswer = Array.isArray(history) && history.length &&
    history[history.length - 1] && history[history.length - 1].role === 'assistant'
  if (lastWasAnswer && CONTINUATION_RE.test(t)) return 'question'
  return 'statement'
}

/**
 * Reads a candidate nest page. Returns null when its file is gone or
 * unreadable — meta.db can point at a page whose .md was deleted, moved, or
 * (on OneDrive/iCloud) not yet materialized. A stale index row must not
 * crash the whole turn; callers filter the nulls. `rebuild-roost` cleans
 * meta.db back up.
 */
function readPageBody (vaultRoot, candidate) {
  const filePath = path.join(vaultRoot, candidate.path)
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    console.error(`Warning: nest page ${candidate.path} is in the index but not on disk (${err.code || err.message}); skipping. Run rebuild-roost.`)
    return null
  }
  const { data, content } = matter(raw)
  // Carry the index's one-line summary through to the answer prompt
  // (kip-app#115) — it's already computed (hatch / a deep groom) and was
  // being dropped here. `summary` is on the searchPages() candidate.
  return { slug: candidate.slug, path: candidate.path, type: data.type, content: content.trim(), summary: candidate.summary || null }
}

/** map candidates -> page bodies, dropping any whose file is missing. */
function readPageBodies (vaultRoot, candidates) {
  return candidates.map((c) => readPageBody(vaultRoot, c)).filter(Boolean)
}

/** True when the coop has at least one enabled skill — a question with no
 *  matching nest pages is still worth answering (a skill can answer it). */
function anySkills (vaultRoot) {
  try {
    return discoverSkills(vaultRoot).length > 0
  } catch {
    return false
  }
}

async function retrieveCandidates (question, vaultRoot, { history = [] } = {}) {
  // A follow-up ("tell me more about the second one") often shares no nouns
  // with the nest — fold in the recent user turns so the direct FTS pass has
  // something to match (kip-app#82).
  const recentUser = (Array.isArray(history) ? history : [])
    .filter((t) => t && t.role === 'user' && typeof t.text === 'string')
    .slice(-3).map((t) => t.text).join(' ')
  const direct = searchPages(`${recentUser} ${question}`.trim(), {}, vaultRoot)

  // Skip the LLM key-term pass when the direct search already found enough —
  // one fewer round-trip per turn, and a tighter set of pages to answer over.
  let keyTerms = []
  if (direct.length < DIRECT_HIT_CONFIDENCE) {
    try {
      keyTerms = await extractKeyTerms(question, vaultRoot, { history })
    } catch (err) {
      console.error(`Warning: key-term extraction failed (${err.message}); continuing with the direct search only.`)
    }
  }
  const broad = keyTerms.length ? searchPages(keyTerms.join(' '), { limit: BROAD_SEARCH_LIMIT }, vaultRoot) : []

  const bySlug = new Map()
  for (const p of [...direct, ...broad]) {
    if (!bySlug.has(p.slug)) bySlug.set(p.slug, p)
  }
  return [...bySlug.values()]
}

/** Which of the candidate pages the answer actually cited via [[wikilink]] syntax. */
function extractCitedSlugs (answerText, candidateSlugs) {
  const linked = new Set(extractWikilinkSlugs(answerText))
  return candidateSlugs.filter((slug) => linked.has(slug))
}

/** Removes the "Sources:" footer the answer model emits (epic #38 — clean
 *  prose + a sources list, instead of inline [[slugs]]). Returns the prose
 *  with the footer cut; the raw text is unchanged when there's no footer. */
function stripSources (answerText) {
  const text = String(answerText || '')
  const m = text.match(/^Sources:\s*$/m)
  return (m && m.index !== undefined ? text.slice(0, m.index) : text).trim()
}

/** A human-readable title from a slug: "sleep-hygiene" -> "sleep hygiene". */
function humanizeSlug (slug) {
  return String(slug).replace(/-+/g, ' ').trim()
}

/** Groom's findings map (.roost/lint.json, written by every groom run,
 *  kip-app#116). Read-only: Peck consults it, never writes it. Returns {} when
 *  the file is absent or unparseable — a nest that has never been groomed just
 *  gets no warnings. */
function readLintIndex (vaultRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(vaultRoot, '.roost', 'lint.json'), 'utf8'))
    return parsed && typeof parsed.findings === 'object' && parsed.findings ? parsed.findings : {}
  } catch {
    return {}
  }
}

/** groom findings for the pages an answer cited — [{slug, kind, note}], the
 *  answer-time half of kip-app#116. */
function lintWarningsFor (vaultRoot, citedSlugs) {
  if (!citedSlugs || !citedSlugs.length) return []
  const idx = readLintIndex(vaultRoot)
  const out = []
  for (const slug of citedSlugs) {
    for (const f of idx[slug] || []) {
      if (f && f.kind && f.note) out.push({ slug, kind: f.kind, note: f.note })
    }
  }
  return out
}

/** groom's stored contradiction findings where BOTH pages are in the candidate
 *  set — fed into the answer prompt as a "known disagreements" block so the
 *  model doesn't present a contested claim as settled (kip-app#116). No LLM
 *  call: this is groom's already-computed output. */
function knownConflictsFor (vaultRoot, candidateSlugs) {
  const inPlay = new Set(candidateSlugs)
  if (inPlay.size < 2) return []
  const idx = readLintIndex(vaultRoot)
  const seen = new Set()
  const out = []
  for (const slug of candidateSlugs) {
    for (const f of idx[slug] || []) {
      if (f.kind !== 'contradiction' || !Array.isArray(f.slugs) || f.slugs.length < 2) continue
      if (!f.slugs.every((s) => inPlay.has(s))) continue
      const key = f.slugs.slice().sort().join('|') + '::' + f.note
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ slugs: f.slugs, note: f.note })
    }
  }
  return out
}

/**
 * Writes an answer into the nest as a new/updated `concept` page (the same
 * create-vs-update resolution hatch.js uses) and logs the peck. The one
 * place this write+log sequence exists.
 *
 * The question is matched against existing pages in full, but the derived
 * slug is capped by resolvePage (SLUG_MAX) — a long (especially CJK)
 * question can't blow filename limits, and answers filed by older builds
 * still resolve to their existing page. The full question stays in the body
 * and the clucks row either way.
 *
 * `log: false` skips the clucks row — the app's file-back path uses it
 * because chat.js already wrote the turn's `peck` row at ask time
 * (kip-app#112); without it, one question+file would log twice.
 */
async function fileAnswerToNest (question, answer, candidateSlugs, vaultRoot = DEFAULT_VAULT_ROOT, { log = true } = {}) {
  const trimmed = question.trim()

  const result = resolvePage({
    type: 'concept', // a peck answer is a synthesized note; closest fit of
                      // the three page types. Existing-page updates keep
                      // whatever type the matched page already has.
    title: trimmed, // matched on the full question; the derived slug is
                    // capped by resolvePage, so old filed answers still resolve
    body: `**Q:** ${question}\n\n${answer}`,
    tags: ['from-peck'],
    mergeTags: true, // survive updates onto an existing page (kip-app#113)
    vaultRoot
  })

  // On update, keep the page's existing index summary — overwriting it with
  // the question replaced hatch's (or an earlier answer's) curated one-liner
  // and that clobber then propagated to nest/index.md (kip-app#112).
  const existing = result.action === 'update' ? getPage(result.slug, vaultRoot) : null
  const summary = existing
    ? existing.summary
    : trimmed.length > 200 ? trimmed.slice(0, 197) + '...' : trimmed

  const filePath = path.join(vaultRoot, result.path)
  const writtenRaw = fs.readFileSync(filePath, 'utf8')
  const { data: writtenData, content: writtenBody } = matter(writtenRaw)
  // Mirror the summary into the page's frontmatter too, so a later
  // rebuild-roost reads it back instead of degrading it to "**Q:** …"
  // (kip-app#115 — the summary-in-frontmatter half of immutability-2).
  if (summary && writtenData.summary !== summary) {
    writtenData.summary = summary
    fs.writeFileSync(filePath, matter.stringify(writtenBody, writtenData))
  }
  upsertPage(result.slug, result.path, result.type, result.tags, summary, writtenBody, vaultRoot)
  regenerateIndexMd(vaultRoot)
  if (log) {
    appendLog('peck', question, [...new Set([...candidateSlugs, result.slug])], vaultRoot)
  }

  return result
}

/**
 * Answers a question from already-retrieved candidate pages; optionally files
 * the answer. When any skills are configured (scripts/lib/skills.js) the model
 * can call them mid-answer — `steps` records what it ran. Skill discovery and
 * the whole tool loop are best-effort: a failure downgrades to a plain answer.
 */
async function answerFromPages (question, pages, { fileToNest, vaultRoot, arena = null, history = [], onStream = null }) {
  const candidateSlugs = pages.map((p) => p.slug)
  const telemetryStart = telemetry.entries().length

  // groom's stored contradictions between two of the pages in play — passed
  // into the answer prompt so the model names the disagreement instead of
  // picking a side (kip-app#116). Not for arena: a regenerate free-rider is
  // "answer this again", and changing its prompt context would muddy the
  // model-vs-model compare.
  const knownConflicts = arena ? [] : knownConflictsFor(vaultRoot, candidateSlugs)

  // The skills tool loop adds a bigger system prompt and, when a skill runs,
  // extra round-trips. Only take that path — or even look for skills — when
  // one is plausibly needed; otherwise answer straight from the nest. A miss
  // is recoverable with the Regenerate button.
  let skills = []
  if (!arena && mightNeedSkill(question, pages.length)) {
    try {
      skills = discoverSkills(vaultRoot)
    } catch (err) {
      console.error(`Warning: skill discovery failed (${err.message}); answering without skills.`)
    }
  }
  const wantSkills = skills.length > 0

  let answer
  let steps = []
  let webSearches = []
  if (arena) {
    // A regenerate free-rider (kip-app#73): plain answer only. Skills add
    // per-run variance that would muddy a model-vs-model comparison, and a
    // regen is "answer this again, differently" — not "re-run the tool loop".
    answer = await answerQuestion(question, pages, vaultRoot, { arena, history })
  } else if (wantSkills) {
    try {
      ({ answer, steps, webSearches } = await answerQuestionWithSkills(question, pages, skills, vaultRoot, { history, onStream, knownConflicts }))
    } catch (err) {
      console.error(`Warning: the skills tool loop failed (${err.message}); falling back to a plain answer.`)
      answer = await answerQuestion(question, pages, vaultRoot, { history, onStream, knownConflicts })
      steps = []
    }
  } else {
    answer = await answerQuestion(question, pages, vaultRoot, { history, onStream, knownConflicts })
  }

  // The nest didn't cover it → search the web and answer from that
  // (kip-app#93). Not for arena (keeps a model-vs-model compare clean), and
  // not when a skill already web-searched this turn.
  let webbed = false
  if (isNoAnswer(answer)) {
    if (!arena && !webSearches.length) {
      const web = await webFallback(question, vaultRoot, { history, onStream })
      answer = web.answer
      webSearches = web.webSearches
      steps = [...steps, ...web.steps]
      webbed = webSearches.length > 0
    } else {
      answer = null
    }
  }

  const citedSlugs = answer ? extractCitedSlugs(answer, candidateSlugs) : []
  // groom's findings for the pages this answer actually leaned on (kip-app#116)
  const lintWarnings = lintWarningsFor(vaultRoot, citedSlugs)
  if (fileToNest && answer && !webbed) {
    // File the raw answer (with its "Sources:" footer) so the nest page keeps
    // its [[slug]] backlinks; the displayed answer below is clean prose.
    await fileAnswerToNest(question, answer, candidateSlugs, vaultRoot)
  }
  // The managed backend's ids for the answer call, so the app can attach a
  // preference signal (👍/👎, "was the regen better?") to it. Both null for
  // every other provider. Read from telemetry (which already records callId /
  // arenaId per PR kip-app#73) rather than threaded through answerQuestion's
  // string return — bounded to the calls THIS invocation just made.
  const { callId, arenaId } = answerCallSince(telemetryStart)
  // If this turn ran web-search, offer its results as a hatchable source
  // (kip-app#81) — the app shows a "save these" affordance on the answer.
  const webSource = buildWebSource(question, webSearches);
  const sources = citedSlugs.map((slug) => ({ slug, title: humanizeSlug(slug) }))
  return { answer: answer ? stripSources(answer) : answer, sources, citedSlugs, candidateSlugs, lintWarnings, steps, callId, arenaId, webSource: webSource || null }
}

/**
 * Auto web-search fallback (kip-app#93): run the bundled `web-search` skill on
 * the question, then answer from its results. Returns { answer, webSearches }.
 * `answer` is null when web search isn't available/enabled or returned nothing;
 * a short honest line when it ran but didn't produce a clear answer.
 */
async function webFallback (question, vaultRoot, { history = [], onStream = null } = {}) {
  let skill
  try {
    skill = discoverSkills(vaultRoot).find((s) => s.name === 'web-search')
  } catch { /* discovery failed — treat as no web search */ }
  if (!skill) return { answer: null, webSearches: [], steps: [] }

  let res
  try {
    res = await runSkill(skill, { query: question }, vaultRoot)
  } catch (err) {
    console.error(`Warning: the web-search fallback failed (${err.message}).`)
    return { answer: null, webSearches: [], steps: [] }
  }

  const preview = ((res && (res.output || res.error)) || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  const step = { skill: 'web-search', input: { query: question }, ok: !!(res && res.ok), ms: (res && res.ms) || 0, cached: !!(res && res.cached), outputPreview: preview }
  const parsed = res && res.ok ? parseWebSearchOutput(res.output) : null
  if (!parsed || !parsed.results.length) return { answer: null, webSearches: [], steps: [step] }

  const answer = await answerFromWeb(question, res.output, vaultRoot, { history, onStream })
  if (isNoAnswer(answer)) {
    return {
      answer: "I couldn't find this in your notes, and a quick web search didn't turn up a clear answer either — try rephrasing?",
      webSearches: [parsed],
      steps: [step]
    }
  }
  return { answer, webSearches: [parsed], steps: [step] }
}

/** callId + arenaId of the newest peck:answer* call at or after `startIdx`. */
function answerCallSince (startIdx) {
  const es = telemetry.entries()
  for (let i = es.length - 1; i >= startIdx; i--) {
    if (/^peck:answer/.test(es[i].label || '') && (es[i].callId || es[i].arenaId)) {
      return { callId: es[i].callId || null, arenaId: es[i].arenaId || null }
    }
  }
  return { callId: null, arenaId: null }
}

/**
 * Writes the pages captureFacts() proposed for a told fact — same
 * create-vs-update resolution Hatch uses (resolvePage -> findSimilarSlug),
 * so an update appends under a dated section rather than overwriting. Skips
 * pages with an unusable type or an empty title/body. Regenerates index.md
 * once. Does NOT log — peckTurn writes exactly one `told` entry.
 *
 * @returns {Array<{action, slug, path}>}
 */
function fileCapturedFacts (proposedPages, vaultRoot = DEFAULT_VAULT_ROOT) {
  const results = []
  for (const page of proposedPages) {
    if (!page || !CAPTURE_TYPES.has(page.type)) continue
    if (typeof page.title !== 'string' || !page.title.trim()) continue
    if (typeof page.body !== 'string' || !page.body.trim()) continue

    const result = resolvePage({
      type: page.type,
      title: page.title,
      body: page.body,
      tags: Array.isArray(page.tags) ? page.tags : [],
      vaultRoot
    })
    const writtenRaw = fs.readFileSync(path.join(vaultRoot, result.path), 'utf8')
    const { content: writtenBody } = matter(writtenRaw)
    upsertPage(result.slug, result.path, result.type, result.tags, page.summary || '', writtenBody, vaultRoot)
    results.push(result)
  }
  if (results.length) regenerateIndexMd(vaultRoot)
  return results
}

/**
 * The Peck workflow: search -> read candidate pages -> ask the LLM ->
 * optionally file the answer into the nest.
 *
 * With fileToNest:false, nothing is written or logged — the caller decides
 * afterward (e.g. after an interactive y/n prompt). fileToNest:true does the
 * whole transaction — search, answer, file, log — in one call.
 *
 * `arenaCompareToCallId` (optional): the callId of an earlier answer to this
 * same question — routes the answer call through the managed backend's arena
 * as candidate B (the regenerate free-rider, kip-app#73).
 *
 * @returns {{answer: string|null, citedSlugs: string[], candidateSlugs: string[], lintWarnings: Array<{slug,kind,note}>, steps: Array, callId: string|null, arenaId: string|null}}
 */
async function askQuestion (question, { fileToNest = true, vaultRoot = DEFAULT_VAULT_ROOT, arenaCompareToCallId = null, history = [], onStream = null } = {}) {
  const candidates = await retrieveCandidates(question, vaultRoot, { history })
  if (candidates.length === 0 && !anySkills(vaultRoot)) {
    return { answer: null, citedSlugs: [], candidateSlugs: [], steps: [] }
  }
  const pages = readPageBodies(vaultRoot, candidates)
  const arena = arenaCompareToCallId ? { compareToCallId: arenaCompareToCallId } : null
  return answerFromPages(question, pages, { fileToNest, vaultRoot, arena, history, onStream })
}

/**
 * One Peck turn: classify the input, then either answer it or capture it as
 * a fact. `fileToNest` only affects the question path (whether the answer is
 * filed); a statement is always filed — that's the point.
 *
 * @returns {{intent: 'question'|'statement'|'reminder', ...}}
 *   question:  { answer: string|null, sources, citedSlugs, candidateSlugs, lintWarnings, steps }
 *   statement: { learned: boolean, note: string, pages?: [{action,slug,path}], candidateSlugs }
 *   reminder:  { answer: string|null, sources, citedSlugs, candidateSlugs, lintWarnings, steps } — same
 *              shape as question; the `reminders` skill did the work and its
 *              confirmation is in `answer`.
 */
async function peckTurn (input, { vaultRoot = DEFAULT_VAULT_ROOT, fileToNest = false, arenaCompareToCallId = null, history = [], onStream = null } = {}) {
  // An upcoming event the user wants reminding about ("I have a meeting Friday
  // at 15h", "remind me to …") — route to the skills path (the `reminders`
  // skill creates it), NOT fact-capture, which would file it as a nest page.
  if (looksLikeReminder(input)) {
    return { intent: 'reminder', ...(await answerFromPages(input, [], { fileToNest: false, vaultRoot })) }
  }

  const candidates = await retrieveCandidates(input, vaultRoot, { history })
  const pages = readPageBodies(vaultRoot, candidates)
  const candidateSlugs = pages.map((p) => p.slug)

  if (classifyPeckInput(input, history) === 'statement') {
    const capture = await captureFacts(input, pages, vaultRoot)
    const results = capture.learned ? fileCapturedFacts(capture.pages, vaultRoot) : []
    const touched = [...new Set(results.map((r) => r.slug))]
    appendLog('told', input, touched, vaultRoot)
    return results.length
      ? { intent: 'statement', learned: true, note: capture.note, pages: results, candidateSlugs }
      : { intent: 'statement', learned: false, note: capture.note || 'Nothing new to record.', candidateSlugs }
  }

  if (pages.length === 0 && !anySkills(vaultRoot)) {
    return { intent: 'question', answer: null, citedSlugs: [], candidateSlugs: [], steps: [] }
  }
  const arena = arenaCompareToCallId ? { compareToCallId: arenaCompareToCallId } : null
  return { intent: 'question', ...(await answerFromPages(input, pages, { fileToNest, vaultRoot, arena, history, onStream })) }
}

module.exports = { askQuestion, peckTurn, classifyPeckInput, fileAnswerToNest, fileCapturedFacts, extractCitedSlugs, stripSources, humanizeSlug, lintWarningsFor, knownConflictsFor }
