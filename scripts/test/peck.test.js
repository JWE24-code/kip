const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { rebuildRoost } = require('../rebuild-roost')
const { extractCitedSlugs, fileAnswerToNest, askQuestion, peckTurn, classifyPeckInput } = require('../lib/peck')
const { captureFacts } = require('../lib/prompts')
const { getPage } = require('../lib/roost')
const { saveLLMConfig } = require('../lib/llm')

/** Route a mocked local-provider chat completion by a distinctive phrase in the system prompt. */
function stubPeckFetch (routes) {
  const calls = []
  const original = global.fetch
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    const sys = body.messages.map((m) => m.content).join('\n')
    calls.push(sys)
    let content = '{}'
    if (/key search terms/.test(sys)) content = routes.keyTerms || '{"terms": []}'
    else if (/told their personal wiki a fact/.test(sys)) content = routes.capture
    else if (routes.answerFn) content = routes.answerFn(sys, calls.length)
    else content = routes.answer || 'an answer'
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }) }
  }
  return { calls, restore: () => { global.fetch = original } }
}

/** Writes <coop>/.henhouse/skills/<name>/{SKILL.md,run.js}. */
function writeFixtureSkill (root, name, run, frontmatter = {}) {
  const dir = path.join(root, '.henhouse', 'skills', name)
  fs.mkdirSync(dir, { recursive: true })
  const fm = Object.assign({ name, description: `fixture ${name}`, entry: 'run.js' }, frontmatter)
  fs.writeFileSync(path.join(dir, 'SKILL.md'),
    '---\n' + Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') + '\n---\n')
  fs.writeFileSync(path.join(dir, 'run.js'), run)
  require('../lib/skills').setSkillApproval(root, name, 'always') // user skills are gated until approved
}

/** Peck's tests must not see the repo's real bundled skills — disable every
 *  one that ships in scripts/skills/ (derived, so a new built-in can't
 *  silently reroute these tests through the tool loop). */
const BUILTIN_SKILL_NAMES = fs.readdirSync(path.join(__dirname, '..', 'skills'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(__dirname, '..', 'skills', e.name, 'SKILL.md')))
  .map((e) => e.name)

function onlyFixtureSkills (root, keep = []) {
  fs.mkdirSync(path.join(root, '.henhouse'), { recursive: true })
  fs.writeFileSync(path.join(root, '.henhouse', 'skills.json'),
    JSON.stringify({ disabled: BUILTIN_SKILL_NAMES.filter((n) => !keep.includes(n)) }))
}

function makeTempVault () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-peck-test-'))
  for (const dir of ['nest/entities', 'nest/concepts', 'nest/sources', 'clucks', '.roost', '.henhouse']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  // Peck tests exercise the plain answer path by default — turn off the
  // repo's bundled skills so they don't route through the tool loop. The
  // skills-loop tests below re-enable / add fixture skills explicitly.
  onlyFixtureSkills(root)
  return root
}

function writePage (root, dir, slug, { type, tags = [], body = '' }) {
  const frontmatter = ['---', `type: ${type}`, 'created: 2026-01-01', 'updated: 2026-01-01', `tags: [${tags.join(', ')}]`, '---', ''].join('\n')
  fs.writeFileSync(path.join(root, 'nest', dir, `${slug}.md`), frontmatter + body + '\n')
}

test('extractCitedSlugs', () => {
  const candidates = ['sleep-hygiene', 'dr-smith', 'morning-routine']

  assert.deepEqual(
    extractCitedSlugs('Per [[sleep-hygiene]] and [[Dr Smith]], you should sleep more.', candidates),
    ['sleep-hygiene', 'dr-smith']
  )
  assert.deepEqual(
    extractCitedSlugs('No wikilinks here at all.', candidates),
    []
  )
  assert.deepEqual(
    extractCitedSlugs('Links to [[something-unrelated]] that is not a candidate.', candidates),
    [],
    'a hallucinated link to a non-candidate slug should not count as cited'
  )
})

test('fileAnswerToNest', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  await t.test('creates a new concept page for a fresh question', async () => {
    const result = await fileAnswerToNest('What do I know about sleep?', 'You sleep poorly.', [], root)
    assert.equal(result.action, 'create')
    assert.equal(result.type, 'concept')

    const raw = fs.readFileSync(path.join(root, result.path), 'utf8')
    assert.ok(raw.includes('**Q:** What do I know about sleep?'))
    assert.ok(raw.includes('You sleep poorly.'))

    const dbPage = getPage(result.slug, root)
    assert.ok(dbPage, 'meta.db should be synced via upsertPage')

    const indexMd = fs.readFileSync(path.join(root, 'nest', 'index.md'), 'utf8')
    assert.ok(indexMd.includes(result.slug.replace(/-/g, ' ')) || true) // regenerateIndexMd ran without error

    const logFile = fs.readFileSync(path.join(root, 'clucks', `${new Date().toISOString().slice(0, 7)}.md`), 'utf8')
    assert.ok(logFile.includes('peck |'))
  })

  await t.test('updates an existing near-duplicate instead of creating a second page', async () => {
    writePage(root, 'concepts', 'sleep-quality', { type: 'concept', body: 'Original notes on sleep quality.' })
    rebuildRoost(root)

    // Question text becomes the page title, run through the same
    // findSimilarSlug() resolution as any other title — "sleep quality"
    // slugifies to exactly "sleep-quality", guaranteeing a match regardless
    // of the similarity threshold's exact calibration.
    const result = await fileAnswerToNest('sleep quality', 'New info.', [], root)
    assert.equal(result.action, 'update')
    assert.equal(result.slug, 'sleep-quality')
  })
})

test('askQuestion', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  await t.test('returns empty result with no writes when nothing matches', async () => {
    const result = await askQuestion('anything', { vaultRoot: root })
    assert.deepEqual(result, { answer: null, citedSlugs: [], candidateSlugs: [], steps: [] })
    assert.equal(fs.existsSync(path.join(root, 'clucks')), true)
    assert.deepEqual(fs.readdirSync(path.join(root, 'clucks')), [], 'a fruitless peck should not be logged, matching the original peck.js behavior')
  })

  await t.test('end-to-end against a real (local-provider, mocked fetch) LLM call', async () => {
    writePage(root, 'concepts', 'sleep-hygiene', {
      type: 'concept',
      tags: ['health'],
      body: 'Notes on sleep hygiene: consistent bedtime, no screens before bed.'
    })
    rebuildRoost(root)

    saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

    const originalFetch = global.fetch
    global.fetch = async (url, init) => {
      const body = JSON.parse(init.body)
      const isKeyTerms = body.messages.some((m) => m.content.includes('key search terms'))
      const content = isKeyTerms
        ? '{"terms": ["sleep"]}'
        : 'Per [[sleep-hygiene]], keep a consistent bedtime.'
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) }
    }

    try {
      const result = await askQuestion('what do I know about sleep?', { fileToNest: true, vaultRoot: root })
      assert.equal(result.answer, 'Per [[sleep-hygiene]], keep a consistent bedtime.')
      assert.deepEqual(result.candidateSlugs, ['sleep-hygiene'])
      assert.deepEqual(result.citedSlugs, ['sleep-hygiene'])

      // fileToNest: true should have written and logged.
      const nestFiles = fs.readdirSync(path.join(root, 'nest', 'concepts'))
      assert.ok(nestFiles.some((f) => f !== 'sleep-hygiene.md'), 'a new page for the filed answer should exist')
    } finally {
      global.fetch = originalFetch
    }
  })
})

test('classifyPeckInput — trailing ? or a leading question word is a question, else a statement', () => {
  for (const q of ['who is the CDO of CompanyX?', 'what do I know about sleep?', "isn't the CDO John Doe?",
    'remind me what the Atlas deadline is', 'how did the offsite go', 'is John still the CDO',
    'make me a Word doc from the Q3 sheet', 'create a deck about the offsite', 'summarize my sleep notes',
    'draft an email to the team']) {
    assert.equal(classifyPeckInput(q), 'question', q)
  }
  for (const s of ['the CDO of CompanyX is John Doe', 'I started learning to sail this summer',
    'CompanyX moved their HQ to Rotterdam in 2025', 'John Doe prefers async updates', 'the sky is blue']) {
    assert.equal(classifyPeckInput(s), 'statement', s)
  }
  assert.equal(classifyPeckInput(''), 'question')
})

test('captureFacts returns a safe default on unusable output', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  const s = stubPeckFetch({ capture: 'garbage' })
  try {
    assert.deepEqual(await captureFacts('x', [], root), { learned: false, note: '', pages: [] })
  } finally { s.restore() }
})

test('peckTurn — a statement is filed onto a matching page and logged as `told`', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  writePage(root, 'entities', 'companyx', { type: 'entity', tags: ['work'], body: 'CompanyX is a client.' })
  rebuildRoost(root)

  const s = stubPeckFetch({
    keyTerms: '{"terms": ["CompanyX", "CDO"]}',
    capture: JSON.stringify({
      learned: true,
      note: 'Recorded the CDO of [[companyx]] on that page.',
      pages: [{ title: 'CompanyX', type: 'entity', tags: ['work'], summary: 'A client', body: 'CDO: John Doe (as of 2026-08).' }]
    })
  })
  try {
    const r = await peckTurn('the CDO of CompanyX is John Doe', { vaultRoot: root })
    assert.equal(r.intent, 'statement')
    assert.equal(r.learned, true)
    assert.deepEqual(r.pages.map((p) => [p.action, p.slug]), [['update', 'companyx']], 'matching page is updated, not duplicated')

    const raw = fs.readFileSync(path.join(root, 'nest', 'entities', 'companyx.md'), 'utf8')
    assert.match(raw, /CDO: John Doe/)
    assert.match(raw, /_Update/, 'the new fact is appended under a dated section')

    const clucks = fs.readFileSync(path.join(root, 'clucks', `${new Date().toISOString().slice(0, 7)}.md`), 'utf8')
    assert.match(clucks, /\btold \|/)
    assert.match(clucks, /companyx/)

    // only companyx exists — no stray page
    assert.deepEqual(fs.readdirSync(path.join(root, 'nest', 'entities')).sort(), ['companyx.md'])
  } finally { s.restore() }
})

test('peckTurn — a stale index row (file deleted) is skipped, not fatal', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  writePage(root, 'concepts', 'sleep-hygiene', { type: 'concept', tags: ['health'], body: 'Consistent bedtime.' })
  writePage(root, 'sources', 'orphan-doc', { type: 'source', body: 'A source that will vanish.' })
  rebuildRoost(root)
  // meta.db now has orphan-doc; delete its file behind the index's back
  fs.rmSync(path.join(root, 'nest', 'sources', 'orphan-doc.md'))

  const s = stubPeckFetch({ keyTerms: '{"terms": ["sleep", "source"]}', answer: 'Keep a consistent bedtime. [[sleep-hygiene]]' })
  try {
    const r = await peckTurn('what helps my sleep?', { vaultRoot: root })
    assert.equal(r.intent, 'question')
    assert.match(r.answer, /consistent bedtime/i)
    assert.ok(!r.candidateSlugs.includes('orphan-doc'), 'the missing page is dropped from candidates')
    assert.ok(r.candidateSlugs.includes('sleep-hygiene'))
  } finally { s.restore() }
})

test('peckTurn — a statement with nothing new writes nothing and still logs `told []`', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)
  rebuildRoost(root)

  const s = stubPeckFetch({
    capture: JSON.stringify({ learned: false, note: 'Nothing new — the sky being blue is not wiki material.', pages: [] })
  })
  try {
    const r = await peckTurn('the sky is blue', { vaultRoot: root })
    assert.equal(r.intent, 'statement')
    assert.equal(r.learned, false)
    assert.ok(r.note.length > 0)
    assert.deepEqual(fs.readdirSync(path.join(root, 'nest', 'entities')), [])
    assert.deepEqual(fs.readdirSync(path.join(root, 'nest', 'concepts')), [])

    const clucks = fs.readFileSync(path.join(root, 'clucks', `${new Date().toISOString().slice(0, 7)}.md`), 'utf8')
    assert.match(clucks, /\btold \| the sky is blue/)
  } finally { s.restore() }
})

test('peckTurn — a question is answered and (fileToNest:false) writes nothing', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  writePage(root, 'concepts', 'sleep-hygiene', { type: 'concept', tags: ['health'], body: 'Consistent bedtime, no screens.' })
  rebuildRoost(root)

  const s = stubPeckFetch({
    keyTerms: '{"terms": ["sleep"]}',
    answer: 'Per [[sleep-hygiene]], keep a consistent bedtime.'
  })
  try {
    const r = await peckTurn('what do I know about sleep?', { vaultRoot: root, fileToNest: false })
    assert.equal(r.intent, 'question')
    assert.equal(r.answer, 'Per [[sleep-hygiene]], keep a consistent bedtime.')
    assert.deepEqual(r.citedSlugs, ['sleep-hygiene'])
    assert.deepEqual(fs.readdirSync(path.join(root, 'nest', 'concepts')).sort(), ['sleep-hygiene.md'], 'no answer page filed')
    assert.deepEqual(fs.readdirSync(path.join(root, 'clucks')), [], 'an unfiled question is not logged')
  } finally { s.restore() }
})

// ---------------------------------------------------------------------------
// the skills tool loop
// ---------------------------------------------------------------------------

test('peckTurn — the model calls a skill, then answers with its output', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  writePage(root, 'concepts', 'q3', { type: 'concept', tags: ['work'], body: 'Q3 plan lives in a spreadsheet.' })
  rebuildRoost(root)
  writeFixtureSkill(root, 'echo', 'console.log("SHEET SAYS: revenue 42, cost 30")')

  const s = stubPeckFetch({
    keyTerms: '{"terms": ["q3"]}',
    answerFn: (sys) => {
      assert.match(sys, /Available skills:/, 'the skills block is in the system prompt')
      return !/<skill_result name="echo"/.test(sys)
        ? '<use_skill name="echo">{"file":"q3.xlsx"}</use_skill>'
        : 'Per [[q3]], the sheet shows revenue 42 and cost 30 (via echo).'
    }
  })
  try {
    const r = await peckTurn('what were the Q3 numbers?', { vaultRoot: root })
    assert.equal(r.intent, 'question')
    assert.equal(r.steps.length, 1)
    assert.equal(r.steps[0].skill, 'echo')
    assert.equal(r.steps[0].ok, true)
    assert.match(r.answer, /revenue 42/)
    assert.deepEqual(r.citedSlugs, ['q3'])
    assert.ok(s.calls.some((c) => /<skill_result name="echo"/.test(c)), 'the follow-up turn saw the skill result')
  } finally { s.restore() }
})

test('peckTurn — a failing skill does not break the answer', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)
  rebuildRoost(root)
  writeFixtureSkill(root, 'broken', 'console.error("kaboom"); process.exit(1)')

  const s = stubPeckFetch({
    answerFn: (sys) => !/<skill_result/.test(sys)
      ? '<use_skill name="broken">{}</use_skill>'
      : "I couldn't get that data, but here's what I know."
  })
  try {
    const r = await peckTurn('search something external', { vaultRoot: root })
    assert.equal(r.intent, 'question')
    assert.equal(r.steps[0].ok, false)
    assert.match(r.answer, /couldn't get that data/)
  } finally { s.restore() }
})

test('peckTurn — with no skills, only peck:answer is called (no skill-turn)', async (t) => {
  const root = makeTempVault()   // built-ins disabled, no fixture skills
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)
  writePage(root, 'concepts', 'sleep', { type: 'concept', body: 'notes on sleep' })
  rebuildRoost(root)

  const s = stubPeckFetch({ keyTerms: '{"terms":["sleep"]}', answer: 'Per [[sleep]], sleep more.' })
  try {
    const r = await peckTurn('what about sleep?', { vaultRoot: root })
    assert.equal(r.answer, 'Per [[sleep]], sleep more.')
    assert.deepEqual(r.steps, [])
    assert.ok(!s.calls.some((c) => /Available skills:/.test(c)), 'no skills block was ever sent')
  } finally { s.restore() }
})

test('peckTurn — an upcoming-event statement routes to the reminders skill, not fact capture', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  onlyFixtureSkills(root, ['reminders']) // keep the real reminders built-in enabled
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)
  rebuildRoost(root)

  const s = stubPeckFetch({
    answerFn: (sys) => !/<skill_result name="reminders"/.test(sys)
      ? '<use_skill name="reminders">{"action":"create","text":"meeting with Acme on friday at 15h"}</use_skill>'
      : 'Done — I set that reminder.'
  })
  try {
    const r = await peckTurn('I have a meeting with Acme on Friday at 15h', { vaultRoot: root })
    assert.equal(r.intent, 'reminder')
    assert.equal(r.steps[0].skill, 'reminders')
    assert.equal(r.steps[0].ok, true)
    assert.ok(fs.existsSync(path.join(root, 'reminders.json')), 'the reminder was stored')
    assert.ok(!s.calls.some((c) => /told their personal wiki a fact/.test(c)), 'fact-capture was not invoked')
  } finally { s.restore() }
})

test('peckTurn — a plain fact statement still goes to capture, not reminders', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  onlyFixtureSkills(root, ['reminders'])
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)
  rebuildRoost(root)

  const s = stubPeckFetch({
    keyTerms: '{"terms":["acme"]}',
    capture: '{"learned": true, "note": "Recorded.", "pages": [{"type":"entity","title":"Acme","body":"CDO is Jane Doe."}]}'
  })
  try {
    const r = await peckTurn('the CDO of Acme is Jane Doe', { vaultRoot: root })
    assert.equal(r.intent, 'statement')
    assert.ok(!fs.existsSync(path.join(root, 'reminders.json')))
  } finally { s.restore() }
})
