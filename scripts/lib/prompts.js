// Prompt content for the nest's LLM-backed tasks: peck (key-term extraction,
// answering, the skills tool loop, fact capture), hatch (candidate-proposal,
// page-content generation, the combined one-call propose-and-draft, the
// whiteboard/mindmap "Context" section), and groom (contradiction / coherence
// / summary / link / merge checks). All actual API calls go through callLLM()
// in scripts/lib/llm.js — nothing here is provider-specific.
const { callLLM } = require('./llm')
const { runSkill, parseSkillCall, scrubInput } = require('./skills')
const { parseWebSearchOutput } = require('./web-sources')

// --- conversation context (kip-app#82) --------------------------------------
// A short buffer of recent Peck turns so a follow-up ("expand on that", "and
// his salary?") can resolve what it refers to. The renderer clips each turn;
// we re-clip here as a backstop and cap the number of turns.
const HISTORY_TURN_CLIP = 700
const HISTORY_MAX_TURNS = 6

/** history: [{ role: "user"|"assistant", text }] oldest→newest, or falsy. */
function formatConversation (history, { heading = 'Conversation so far' } = {}) {
  if (!Array.isArray(history) || !history.length) return ''
  const lines = history
    .filter((t) => t && typeof t.text === 'string' && t.text.trim())
    .slice(-HISTORY_MAX_TURNS)
    .map((t) => `${t.role === 'assistant' ? 'Kip' : 'User'}: ${t.text.trim().replace(/\s+/g, ' ').slice(0, HISTORY_TURN_CLIP)}`)
  return lines.length ? `${heading}:\n${lines.join('\n')}` : ''
}

/** Extracts key search terms from a question, for a broader secondary searchPages() pass. */
async function extractKeyTerms (question, vaultRoot, { history = [] } = {}) {
  const convo = formatConversation(history)
  const system = 'Extract 3-8 short key search terms/phrases for a full-text search over a ' +
    'personal wiki, to answer the user\'s current question. Strip stopwords; choose terms that ' +
    'maximize search recall. If the question is a follow-up, resolve its pronouns and references ' +
    'from the conversation and include the real subjects as terms. ' +
    'Respond with a JSON object of exactly this shape: {"terms": ["term1", "term2", ...]}.'
  const prompt = convo ? `${convo}\n\nCurrent question: ${question}` : `Question: ${question}`

  const { text } = await callLLM({ system, prompt, json: true, maxTokens: 1024, label: 'peck:key-terms' }, { vaultRoot })
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed.terms) ? parsed.terms : []
  } catch {
    return []
  }
}

function formatPagesForPrompt (pages) {
  return pages
    .map((p) => `### Page: ${p.slug} (type: ${p.type || 'unknown'})\n${p.content}`)
    .join('\n\n---\n\n')
}

const ANSWER_SYSTEM_PROMPT = `You are answering a question from a personal wiki — a second brain for journaling, goals, and health tracking. You are given the full text of the wiki pages retrieved as candidates for this question.

Answer using ONLY the information in these pages — do not use outside knowledge, and do not speculate beyond what's written. If the pages don't contain enough information to answer, say so plainly rather than guessing.

If a "Conversation so far" section is present, it is only there to tell you what a follow-up question refers to — it is NOT a source, so never cite it or treat it as fact.

Cite every claim back to the specific page it came from using Logseq's wikilink syntax: [[exact-page-slug]], using the exact slug shown in each "### Page: <slug>" heading. Prefer citing inline, next to the claim it supports, over a single list of links at the end.`

/** Answers a question against a set of candidate wiki pages, with [[slug]]
 *  citations. `arena` (optional): { compareToCallId } runs this as arena
 *  candidate B against an earlier answer — the regenerate free-rider
 *  (kip-app#73). `history` (optional): recent {role,text} turns for
 *  follow-up context (kip-app#82). */
async function answerQuestion (question, pages, vaultRoot, { arena = null, history = [], onStream = null } = {}) {
  const convo = formatConversation(history)
  const prompt = `${formatPagesForPrompt(pages)}\n\n---\n\n` +
    (convo ? `${convo}\n\n---\n\n` : '') +
    `Question: ${question}`
  const { text } = await callLLM({ system: ANSWER_SYSTEM_PROMPT, prompt, maxTokens: 4096, label: 'peck:answer', arena, onStream }, { vaultRoot })
  return text
}

const MEETING_PREP_SYSTEM_PROMPT = `You are writing a short prep note for an upcoming event on a personal wiki (a second brain for journaling, goals, health, and work). You are given the event and the full text of wiki pages retrieved as related context.

Write 3-4 tight bullets of what's worth knowing walking in: who/what the event involves, relevant recent history or open threads, and anything to prepare or decide. Use ONLY the pages provided — no outside knowledge, no speculation. If the pages hold little of relevance, say so in one line instead of padding.

Cite every claim with Logseq wikilink syntax [[exact-page-slug]], using the exact slug from each "### Page: <slug>" heading, inline next to the claim.`

/**
 * A short prep brief for an upcoming reminder/event, citing [[slug]] pages.
 * Returns null on any failure (no provider, bad response) so the caller can
 * fall back to a bare list of related pages.
 */
async function generateMeetingPrep ({ title, body, eventAt }, pages, vaultRoot) {
  if (!Array.isArray(pages) || pages.length === 0) return null
  try {
    const prompt = `${formatPagesForPrompt(pages)}\n\n---\n\nEvent: ${title}` +
      `${eventAt ? `\nWhen: ${eventAt}` : ''}${body ? `\nNotes: ${body}` : ''}\n\nWrite the prep note.`
    const { text } = await callLLM(
      { system: MEETING_PREP_SYSTEM_PROMPT, prompt, maxTokens: 800, label: 'reminders:prep' },
      { vaultRoot })
    return (text && text.trim()) || null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Peck's skills tool loop (scripts/lib/skills.js). A ReAct-style TEXT protocol
// — the model emits <use_skill name="X">{json}</use_skill> or a plain answer —
// so callLLM() stays untouched and provider-agnostic (no native function
// calling). Bounded, and safe to fail: any error downgrades to answerQuestion.
// ---------------------------------------------------------------------------

const MAX_SKILL_ITERATIONS = 4

const ANSWER_WITH_SKILLS_SYSTEM_PROMPT = `You are answering a question from a personal wiki — a second brain for journaling, goals, and health tracking. You are given the full text of the wiki pages retrieved as candidates, and you can run SKILLS (small programs) to fetch or produce information the pages don't contain.

Answer using the wiki pages AND any skill results you gather. Do not speculate beyond what you're given.

To run a skill, make your ENTIRE reply exactly this and nothing else:
<use_skill name="skill-name">{ "param": "value" }</use_skill>
Then stop. You'll get the skill's output back and can run another skill or write your answer.

When you can answer, write it as normal prose with NO tag. Cite a wiki-page claim with [[exact-page-slug]] (the slug shown in each "### Page: <slug>" heading). Attribute a skill-derived fact inline as "(via skill-name)".

Rules:
- At most ${MAX_SKILL_ITERATIONS} skill calls. Prefer the wiki pages — only run a skill when they can't answer.
- Some skills produce a file (a document, a deck) instead of an answer. When one does, its result is the path it wrote; give that exact path to the user (e.g. "Saved to exports/report.docx") rather than describing the contents.
- If a skill errors or returns nothing useful, don't retry it more than once; answer with what you have and note what was missing.`

/** Renders the available skills as a prompt block. */
function formatSkillsBlock (skills) {
  const one = (s) => {
    const params = s.parameters && s.parameters.length
      ? '\nParameters:\n' + s.parameters.map((p) => {
        const bits = [p.type || 'string', p.required ? 'required' : 'optional']
        if (p.enum) bits.push(`one of: ${p.enum.join(', ')}`)
        if (p.default !== undefined) bits.push(`default ${JSON.stringify(p.default)}`)
        return `- ${p.name} (${bits.join(', ')})${p.description ? `: ${p.description}` : ''}`
      }).join('\n')
      : ''
    return `### ${s.name}\n${s.description}` +
      (s.whenToUse ? `\nUse when: ${s.whenToUse}` : '') +
      params +
      (s.instructions ? `\n${s.instructions}` : '')
  }
  return `\n\nAvailable skills:\n\n${skills.map(one).join('\n\n')}`
}

/**
 * The skills tool loop: answer the question, but let the model call skills
 * first. Returns { answer, steps: [{skill, input, ok, ms, outputPreview}] }.
 * With no skills it's just answerQuestion(). Any unexpected throw is the
 * caller's (peck.js's) to catch and downgrade.
 */
async function answerQuestionWithSkills (question, pages, skills, vaultRoot, { runSkillFn = runSkill, history = [], onStream = null } = {}) {
  if (!skills || !skills.length) {
    return { answer: await answerQuestion(question, pages, vaultRoot, { history, onStream }), steps: [], webSearches: [] }
  }

  const byName = new Map(skills.map((s) => [s.name, s]))
  const system = ANSWER_WITH_SKILLS_SYSTEM_PROMPT + formatSkillsBlock(skills)
  const convo = formatConversation(history)
  let transcript = `${formatPagesForPrompt(pages)}\n\n---\n\n` +
    (convo ? `${convo}\n\n---\n\n` : '') +
    `Question: ${question}`
  const steps = []
  const webSearches = []   // parsed results of every web-search run this turn (kip-app#81)

  for (let turn = 0; turn <= MAX_SKILL_ITERATIONS; turn++) {
    // Stream every turn: a turn is either a <use_skill> tag or the final
    // prose. The consumer keys off the `first` flag to reset its buffer each
    // turn and suppresses anything that still looks like a partial skill tag,
    // so a tool-call turn shows nothing and the answer turn streams clean.
    const { text, raw } = await callLLM({
      system,
      prompt: transcript,
      maxTokens: 4096,
      label: turn === 0 ? 'peck:answer' : 'peck:skill-turn',
      onStream
    }, { vaultRoot })

    const call = parseSkillCall(text)
    // No <use_skill> tag (⇒ text is the final answer), or the model was cut
    // off (⇒ answer with what came back rather than loop on a partial tag).
    if (!call || responseWasTruncated(raw)) {
      return { answer: text, steps, webSearches }
    }

    // model still wants a tool on the last allowed turn — force a final answer
    if (turn === MAX_SKILL_ITERATIONS) {
      const { text: final } = await callLLM({
        system: ANSWER_SYSTEM_PROMPT,
        prompt: `${transcript}\n\nAnswer the question now with what you have.`,
        maxTokens: 4096,
        label: 'peck:answer:final',
        onStream
      }, { vaultRoot })
      return { answer: final, steps, webSearches }
    }

    const skill = byName.get(call.name)
    if (!skill) {
      steps.push({ skill: call.name, input: call.input, ok: false, ms: 0, outputPreview: 'no such skill' })
      transcript += `\n\n<skill_result name="${call.name}" ok="false">\nERROR: no such skill. Available: ${skills.map((s) => s.name).join(', ')}.\n</skill_result>\nCall a real skill or answer now.`
      continue
    }
    if (call.input === null) {
      steps.push({ skill: skill.name, input: null, ok: false, ms: 0, outputPreview: 'bad parameters' })
      transcript += `\n\n<skill_result name="${skill.name}" ok="false">\nERROR: your parameters were not valid JSON. Retry with a JSON object, or answer directly.\n</skill_result>`
      continue
    }

    const res = await runSkillFn(skill, call.input, vaultRoot)
    steps.push({
      skill: skill.name,
      input: scrubInput(call.input),
      ok: res.ok,
      ms: res.ms,
      outputPreview: (res.output || res.error || '').replace(/\s+/g, ' ').trim().slice(0, 500)
    })
    // Any skill whose output is a web-search result list (the built-in
    // web-search, or a user's own) — capture it as a savable source (kip-app#81).
    if (res.ok) {
      const parsed = parseWebSearchOutput(res.output)
      if (parsed && parsed.results.length) webSearches.push(parsed)
    }
    const body = res.ok ? String(res.output || '').slice(0, 6000) : `ERROR: ${res.error}`
    transcript += `\n\n<skill_result name="${skill.name}" ok="${res.ok}">\n${body}\n</skill_result>\nCall another skill or write your final answer now.`
  }

  // unreachable (the turn === MAX branch returns), but be safe
  return { answer: await answerQuestion(question, pages, vaultRoot, { history, onStream }), steps, webSearches }
}

/**
 * Flags apparent factual contradictions within a small group of related
 * pages (grouped by type/tags by the caller — see scripts/groom.js). Returns
 * an empty array if none are found, or if the response couldn't be parsed.
 */
async function flagContradictions (pages, vaultRoot) {
  const system = 'Identify any apparent factual contradictions between a small set of wiki pages ' +
    'from a personal knowledge base — places where one page states something that conflicts with ' +
    'what another page states. Only flag genuine contradictions, not simple differences in scope, ' +
    'time, or unrelated facts. Respond with a JSON object of exactly this shape: ' +
    '{"contradictions": [{"slugs": ["slug-a", "slug-b"], "description": "what contradicts what, ' +
    'in one or two sentences"}, ...]}. If there are none, respond with {"contradictions": []}.'

  const prompt = `Here are ${pages.length} wiki pages (grouped because they share a type and/or tags):\n\n${formatPagesForPrompt(pages)}`

  const { text } = await callLLM({ system, prompt, json: true, maxTokens: 2048, label: 'groom:contradictions' }, { vaultRoot })
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed.contradictions) ? parsed.contradictions : []
  } catch {
    return []
  }
}

const PROPOSE_CANDIDATES_SYSTEM_PROMPT = `You are analyzing a raw source document being ingested into a personal wiki (a second brain for journaling, goals, and health tracking). The wiki has three page types:
- "entity": a person, place, or recurring thing (a doctor, a gym, a recurring project).
- "concept": a recurring theme (a habit, a goal, sleep, a specific idea being tracked).
- "source": one summary page for this ingested document itself, linking to the entity/concept pages it touches.

Propose the wiki pages this source touches. Always include exactly one "source" candidate for the document itself. Only propose an "entity" or "concept" candidate for something substantial enough in the source to be worth its own page — not every passing mention.

Respond with a JSON object of exactly this shape:
{"candidates": [{"title": "...", "type": "entity"|"concept"|"source", "tags": ["..."], "summary": "one-line description"}, ...]}`

/**
 * Proposes candidate wiki pages (title/type/tags/summary) a raw source likely
 * touches. Small/fast models occasionally return truncated or malformed JSON
 * here — one retry turns that transient flub into a non-event before the
 * caller sees an empty (and misleading "no candidates") result.
 */
async function proposeCandidatePages (sourceTitle, sourceContent, vaultRoot) {
  const prompt = `Source title: ${sourceTitle}\n\n${sourceContent}`
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text } = await callLLM({
      system: PROPOSE_CANDIDATES_SYSTEM_PROMPT,
      prompt,
      json: true,
      maxTokens: 4096,
      label: attempt === 0 ? 'hatch:propose' : 'hatch:propose:retry'
    }, { vaultRoot })
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed.candidates)) return parsed.candidates
    } catch { /* malformed — retry once, then give up */ }
  }
  return []
}

function buildGenerateContentSystemPrompt ({ action, existingContent, siblingSlugs }) {
  const linkNote = siblingSlugs.length
    ? ` Other pages from this same ingest, which you may reference with [[wikilink]] syntax using their exact slugs when relevant: ${siblingSlugs.join(', ')}.`
    : ''

  if (action === 'update') {
    return 'You are extending an existing wiki page in a personal wiki, with new information from ' +
      'a source document being ingested. Write ONLY the new content to add — not a rewrite of the whole ' +
      'page. Be factual and concise; use only what the source supports. If the new information contradicts ' +
      "something already on the page, state the contradiction explicitly (it's a new, possibly conflicting " +
      'claim) rather than silently overwriting the old one — the page should read as a history of what\'s ' +
      `known, not just the latest belief. Use Logseq's [[wikilink]] syntax to reference other related pages ` +
      `by their exact slug.${linkNote}\n\nExisting page content:\n${existingContent}`
  }

  return 'You are writing a new wiki page in a personal wiki (a second brain for journaling, goals, ' +
    'and health tracking), as part of ingesting a source document. Write the page\'s body content only (no ' +
    'frontmatter — that\'s added separately). Be factual and concise; use only what the source supports — ' +
    `do not invent details. Use Logseq's [[wikilink]] syntax to reference other related pages by their ` +
    `exact slug when relevant.${linkNote}`
}

/**
 * Generates the body content (markdown, no frontmatter) for one page during
 * a hatch. Small/fast models sometimes return an empty or whitespace-only
 * response — retry once, since a page written with no body renders as a
 * broken/empty page. Returns "" only if both attempts come back empty (the
 * caller skips the page in that case).
 */
async function generatePageContent ({ title, type, action, existingContent, sourceTitle, sourceContent, siblingSlugs = [], vaultRoot }) {
  const system = buildGenerateContentSystemPrompt({ action, existingContent, siblingSlugs })
  const prompt = `Page: "${title}" (type: ${type})\n\nSource document ("${sourceTitle}"):\n${sourceContent}`
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text } = await callLLM({
      system,
      prompt,
      maxTokens: 2048,
      label: `hatch:generate:${type}${attempt === 0 ? '' : ':retry'}`
    }, { vaultRoot })
    if (text && text.trim()) return text.trim()
  }
  return ''
}

const PROPOSE_AND_DRAFT_SYSTEM_PROMPT = `You are ingesting a raw source document into a personal wiki (a second brain for journaling, goals, and health tracking) in a single step: decide which wiki pages the source touches AND write each page's body.

The wiki has three page types:
- "entity": a person, place, or recurring thing (a doctor, a gym, a recurring project).
- "concept": a recurring theme (a habit, a goal, sleep, a specific idea being tracked).
- "source": exactly one page that summarizes THIS document and links to the entity/concept pages it touches.

Rules:
- Always include exactly one "source" page. Only add an "entity" or "concept" page for something substantial enough in the source to warrant its own page — not every passing mention.
- "body" is the page's markdown body only — NO YAML frontmatter, NO top-level "# Title" heading. Be factual and concise; use only what the source supports; do not invent details. Every page must have a non-empty body.
- Cross-link the other pages you are creating in this same batch with [[slug]] wikilinks, where the slug is the title lowercased with spaces/punctuation replaced by single hyphens (e.g. "Dr. Alvarez" -> [[dr-alvarez]]).

Respond with a JSON object of exactly this shape:
{"pages": [{"title": "...", "type": "entity"|"concept"|"source", "tags": ["..."], "summary": "one-line description", "body": "markdown body..."}, ...]}`

/** True when the provider stopped because it hit max_tokens (OpenAI-compatible or Anthropic shapes). */
function responseWasTruncated (raw) {
  if (!raw) return false
  const finish = raw.choices && raw.choices[0] && raw.choices[0].finish_reason
  return finish === 'length' || raw.stop_reason === 'max_tokens'
}

/**
 * The one-call hatch path: proposes the pages a source touches AND drafts
 * each body in a single LLM call — vs proposeCandidatePages() plus one
 * generatePageContent() call per page. The source text is sent once and the
 * model reasons over it once. Returns [] on repeated malformed or truncated
 * output, which callers treat like "no usable pages" (same as
 * proposeCandidatePages).
 */
async function proposeAndDraftPages (sourceTitle, sourceContent, vaultRoot) {
  const prompt = `Source title: ${sourceTitle}\n\n${sourceContent}`
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, raw } = await callLLM({
      system: PROPOSE_AND_DRAFT_SYSTEM_PROMPT,
      prompt,
      json: true,
      maxTokens: 8192,
      label: attempt === 0 ? 'hatch:draft' : 'hatch:draft:retry'
    }, { vaultRoot })

    if (responseWasTruncated(raw)) continue // hit the token ceiling — one retry
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed.pages)) return parsed.pages
    } catch { /* malformed — retry once, then give up */ }
  }
  return []
}

// ---------------------------------------------------------------------------
// Deep-groom checks (scripts/groom.js --deep). Each is one JSON LLM call per
// page/pair, with one retry and a safe default so a single flub never aborts
// a long groom run.
// ---------------------------------------------------------------------------

/**
 * One JSON call with a single retry on malformed/truncated output.
 * `pick(parsed)` returns the value to resolve, or undefined to reject+retry.
 * Returns undefined if both attempts fail (callers substitute a safe default).
 */
async function jsonCall ({ system, prompt, maxTokens, label, vaultRoot }, pick) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, raw } = await callLLM({
      system,
      prompt,
      json: true,
      maxTokens,
      label: attempt === 0 ? label : `${label}:retry`
    }, { vaultRoot })
    if (responseWasTruncated(raw)) continue
    try {
      const value = pick(JSON.parse(text))
      if (value !== undefined) return value
    } catch { /* malformed — retry once, then give up */ }
  }
  return undefined
}

const DESCRIBE_WHITEBOARD_SYSTEM_PROMPT = `You are given a mindmap / whiteboard from a personal wiki (a second brain for journaling, goals, and health tracking), rendered as a nested outline of its nodes and the arrows between them.

Write a short "Context" section that adds what the bare outline does NOT already carry:
- what the map is about as a whole, in a sentence or two
- what each main branch represents, and how the branches relate
- any tension, imbalance, open question, or gap the structure implies (e.g. a branch with far more detail than its siblings, a dead-end, two branches that seem to pull against each other)

2-5 short paragraphs, or a tight bullet list. Be concrete and grounded in the actual node labels. Do NOT invent facts the map doesn't contain, and do NOT just restate the outline.

You are also given the slugs of existing wiki pages a search matched against the node labels. When a node genuinely refers to one of those pages (the same person / place / thing / concept), link it with Logseq wikilink syntax: [[exact-slug]]. Only link real references, never an incidental word match.

Respond with a JSON object of exactly this shape:
{"summary": "one sentence naming what this map captures", "context": "the Context section as markdown — no heading, no frontmatter"}`

/**
 * Writes the LLM "Context" section for a hatched whiteboard/mindmap: a short
 * interpretation of the outline (themes, how branches relate, gaps) plus
 * [[slug]] links to related nest pages. `relatedPages` is [{slug, summary}]
 * from a search over the node labels. Returns {summary, context} or null when
 * the model can't produce usable output (caller falls back to outline-only).
 */
async function describeWhiteboard ({ name, outline, relatedPages = [] }, vaultRoot) {
  const related = relatedPages.length
    ? relatedPages.map((p) => `- ${p.slug}${p.summary ? `: ${p.summary}` : ''}`).join('\n')
    : '(the search found no matching existing pages)'
  const v = await jsonCall(
    {
      system: DESCRIBE_WHITEBOARD_SYSTEM_PROMPT,
      prompt: `Whiteboard: ${name}\n\nOutline:\n${outline}\n\nExisting wiki pages that matched node labels:\n${related}`,
      maxTokens: 2048,
      label: 'hatch:whiteboard',
      vaultRoot
    },
    (p) => (typeof p.context === 'string' && p.context.trim()
      ? { summary: typeof p.summary === 'string' ? p.summary.trim() : '', context: p.context.trim() }
      : undefined))
  return v || null
}

const PAGE_COHERENCE_SYSTEM_PROMPT = `You are reviewing ONE page from a personal wiki. It was built up over time — a base body plus one or more dated "_Update <date>:_" sections appended as new sources came in, with nobody reconciling them.

Report problems WITHIN this single page:
- internal contradiction: a section states something a later section contradicts without acknowledging it
- redundancy: the same fact repeated across sections with nothing added
- superseded claim: an early statement a later section clearly overrides but doesn't say so

Respond with a JSON object of exactly this shape:
{"issues": ["one sentence per problem, naming the conflicting parts", ...], "consolidate": true|false}
Set "consolidate" true if the page would be clearer rewritten as one current-state summary plus a short dated history. If the page is fine, respond {"issues": [], "consolidate": false}.`

/** Flags internal contradictions / redundancy across a single page's _Update_ sections. */
async function reviewPageCoherence (slug, body, vaultRoot) {
  const v = await jsonCall(
    { system: PAGE_COHERENCE_SYSTEM_PROMPT, prompt: `Page: ${slug}\n\n${body}`, maxTokens: 1024, label: 'groom:coherence', vaultRoot },
    (p) => (Array.isArray(p.issues) ? { issues: p.issues, consolidate: !!p.consolidate } : undefined))
  return v || { issues: [], consolidate: false }
}

/** Checks whether a page's one-line meta.db summary still describes its (possibly grown) body. */
async function checkSummaryAccuracy (slug, summary, body, vaultRoot) {
  const system = 'You check whether a one-line summary still accurately describes a wiki page whose ' +
    'body may have grown since the summary was written. Respond with a JSON object of exactly this ' +
    'shape: {"ok": true|false, "suggested": "a better one-line summary, or empty string when ok is true"}. ' +
    'Only set ok:false for a real mismatch — the summary is wrong, or misses the main thing the page is ' +
    'now about — not for minor wording.'
  const v = await jsonCall(
    { system, prompt: `Page: ${slug}\nCurrent summary: ${summary}\n\nPage body:\n${body}`, maxTokens: 512, label: 'groom:summary', vaultRoot },
    (p) => (typeof p.ok === 'boolean' ? { ok: p.ok, suggested: p.suggested || '' } : undefined))
  return v || { ok: true, suggested: '' }
}

/** From deterministic "mentioned but not linked" candidates, the subset that are genuine references worth linking. */
async function confirmMissingLinks (slug, body, candidateSlugs, vaultRoot) {
  if (!candidateSlugs.length) return []
  const system = 'A wiki page mentions other pages by name in its prose but does not link them with ' +
    '[[wikilink]] syntax. Given the page body and a list of candidate page slugs, return the subset that ' +
    'are GENUINE references to that page (the same person / place / thing / concept) and would help a ' +
    'reader if linked — not an incidental use of a common word that happens to match a slug. Respond with ' +
    'a JSON object of exactly this shape: {"link": ["slug-a", "slug-b", ...]}.'
  const v = await jsonCall(
    { system, prompt: `Page: ${slug}\nCandidate slugs: ${candidateSlugs.join(', ')}\n\nPage body:\n${body}`, maxTokens: 512, label: 'groom:missing-links', vaultRoot },
    (p) => (Array.isArray(p.link) ? p.link.filter((s) => candidateSlugs.includes(s)) : undefined))
  return v || []
}

/** Decides whether two pages (near-dup the slug check missed) are the same subject and should merge. */
async function checkPagesSameSubject (a, b, vaultRoot) {
  const system = 'You are given two wiki pages that might be about the same subject under different names ' +
    '(a near-duplicate the slug-similarity check missed). Decide whether they describe the SAME person, ' +
    'place, thing, or concept and should be merged into one page. Respond with a JSON object of exactly ' +
    'this shape: {"same": true|false, "reason": "one sentence"}.'
  const v = await jsonCall(
    { system, prompt: `Page A (${a.slug}, ${a.type}):\n${a.body}\n\n---\n\nPage B (${b.slug}, ${b.type}):\n${b.body}`, maxTokens: 512, label: 'groom:merge', vaultRoot },
    (p) => (typeof p.same === 'boolean' ? { same: p.same, reason: p.reason || '' } : undefined))
  return v || { same: false, reason: '' }
}

// ---------------------------------------------------------------------------
// Peck conversational capture (scripts/lib/peck.js peckTurn) — tell the nest
// a fact and it files it onto the right page. (The question-vs-statement
// classifier is a heuristic and lives in scripts/lib/peck.js, not here.)
// ---------------------------------------------------------------------------

const CAPTURE_FACTS_SYSTEM_PROMPT = `A person just told their personal wiki a fact to remember. You get their statement and the wiki pages a search found as possibly relevant (slug, type, current body).

Your default is to RECORD the fact. A concrete detail — a name, a role, a date, a number, a relationship, a status, a preference — is worth keeping unless a page already states that exact thing. Only set learned:false for a statement with no recordable content: small talk, a bare opinion, or something already written verbatim.

Where it goes:
- PREFER updating an existing relevant page. "The CDO of CompanyX is John Doe" goes on the CompanyX page — and on a page for John Doe if the person is worth their own page.
- Create a new page only for a person / place / thing ("entity") or a recurring topic ("concept") the statement is substantially about that no existing page covers.

"body" is the markdown to record. For an update: ONLY the new fact, phrased as a standalone sentence (it is appended under a dated heading — do NOT rewrite the page). For a new page: a one-line factual starter. Link the pages you write to each other with [[slug]] wikilinks (slug = title lowercased, spaces/punctuation → hyphens).

Respond with a JSON object of exactly this shape:
{"learned": true|false, "note": "one sentence — what you recorded and where, or why nothing was recorded", "pages": [{"title": "...", "type": "entity"|"concept", "tags": ["..."], "summary": "one line", "body": "markdown"}, ...]}`

/** Given a told fact + the FTS-matched pages, returns {learned, note, pages[]} to write. Safe default {learned:false,…}. */
async function captureFacts (input, existingPages, vaultRoot) {
  const context = existingPages.length
    ? formatPagesForPrompt(existingPages)
    : '(the search found no relevant existing pages)'
  const v = await jsonCall(
    {
      system: CAPTURE_FACTS_SYSTEM_PROMPT,
      prompt: `Statement: ${input}\n\nPossibly-relevant existing pages:\n${context}`,
      maxTokens: 2048,
      label: 'peck:capture',
      vaultRoot
    },
    (p) => (typeof p.learned === 'boolean'
      ? { learned: p.learned, note: typeof p.note === 'string' ? p.note : '', pages: Array.isArray(p.pages) ? p.pages : [] }
      : undefined))
  return v || { learned: false, note: '', pages: [] }
}

module.exports = {
  extractKeyTerms,
  answerQuestion,
  formatConversation,
  generateMeetingPrep,
  answerQuestionWithSkills,
  formatSkillsBlock,
  MAX_SKILL_ITERATIONS,
  flagContradictions,
  proposeCandidatePages,
  generatePageContent,
  proposeAndDraftPages,
  describeWhiteboard,
  reviewPageCoherence,
  checkSummaryAccuracy,
  confirmMissingLinks,
  checkPagesSameSubject,
  captureFacts
}
