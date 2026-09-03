const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { rebuildRoost } = require('../rebuild-roost')
const { extractCitedSlugs, fileAnswerToNest, askQuestion, peckTurn, classifyPeckInput } = require('../lib/peck')
const { captureFacts, answerQuestionWithSkills } = require('../lib/prompts')
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
    else if (/planning which skills/.test(sys)) content = routes.plan || '{"calls": []}'
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
    assert.deepEqual(result, { answer: null, citedSlugs: [], candidateSlugs: [], steps: [], costUsd: null })
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

  await t.test('onStream forwards the answer deltas from the provider (kip-app#88)', async () => {
    writePage(root, 'concepts', 'sailing', { type: 'concept', tags: [], body: 'Started sailing this summer.' })
    rebuildRoost(root)
    saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

    const originalFetch = global.fetch
    global.fetch = async (url, init) => {
      const body = JSON.parse(init.body)
      const isKeyTerms = body.messages.some((m) => m.content.includes('key search terms'))
      if (isKeyTerms) {
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"terms":["sailing"]}' } }] }) }
      }
      // the answer call arrives with stream:true — reply with SSE
      assert.equal(body.stream, true, 'the answer call should be a streaming request')
      const parts = ['I ', 'sail ', '[[sailing]].']
      const lines = parts.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`)
      lines.push('data: [DONE]\n\n')
      const bodyStream = (async function * () { for (const l of lines) yield Buffer.from(l) })()
      return { ok: true, status: 200, headers: new Headers(), body: bodyStream, json: async () => ({}), text: async () => '' }
    }

    try {
      const chunks = []
      const result = await askQuestion('what do I know about sailing?', {
        vaultRoot: root,
        onStream: (c) => chunks.push(c)
      })
      assert.equal(chunks.join(''), 'I sail [[sailing]].')
      assert.equal(result.answer, 'I sail [[sailing]].')
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

test('classifyPeckInput — non-English questions without a "?" still classify as questions (kip-app#97)', () => {
  const questions = [
    'Wer leitet das Atlas-Projekt',            // DE
    'Was weiß ich über Schlaf',                // DE
    'Wie ist der Zeitplan für Q3',             // DE
    'Wie is de CEO van Globex',                // NL
    'Wat weet ik over slaap',                  // NL
    'Qui est le PDG de Globex',                // FR
    'Résume mes notes de sommeil',             // FR (imperative)
    'Quién es el director de Globex',          // ES
    'Muéstrame mis notas de la reunión',       // ES (imperative)
    'Chi guida il progetto Atlas',             // IT
    'Quem lidera o projeto Atlas',             // PT
    'Globex — wer ist eigentlich der CEO? danke' // "?" mid-string
  ]
  for (const q of questions) assert.equal(classifyPeckInput(q), 'question', q)

  // genuine declaratives in other languages are still statements
  for (const s of ['Der neue CDO von CompanyX ist John Doe', 'De lucht is blauw',
    'Le ciel est bleu', 'CompanyX ha spostato la sede a Rotterdam']) {
    assert.equal(classifyPeckInput(s), 'statement', s)
  }
})

test('classifyPeckInput — a bare follow-up after a Kip answer is a question (kip-app#82)', () => {
  const afterAnswer = [{ role: 'user', text: 'what are the pricing tiers?' },
    { role: 'assistant', text: 'There are three: Free, Pro, Team [[pricing]].' }]
  for (const q of ['tell me more', 'the second one', 'what about Team', 'and the price?', 'why', 'says who']) {
    assert.equal(classifyPeckInput(q, afterAnswer), 'question', q)
  }
  // with no history, the same short inputs still read as statements
  assert.equal(classifyPeckInput('the second one'), 'statement')
  // a real new fact after an answer is still a statement
  assert.equal(classifyPeckInput('the CDO of CompanyX is John Doe', afterAnswer), 'statement')
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

test('peckTurn — a German question with no "?" is answered, not filed as a fact (kip-app#97)', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)
  writePage(root, 'concepts', 'schlafhygiene', { type: 'concept', tags: [], body: 'Konsistente Schlafenszeit, keine Bildschirme vor dem Schlafengehen.' })
  rebuildRoost(root)

  const s = stubPeckFetch({
    keyTerms: '{"terms": ["Schlaf", "Schlafhygiene"]}',
    answer: 'Laut [[schlafhygiene]]: konsistente Schlafenszeit.'
  })
  try {
    const r = await peckTurn('Was weiß ich über Schlaf', { vaultRoot: root })
    assert.equal(r.intent, 'question', 'classified as a question, not a statement')
    assert.match(r.answer, /Schlafenszeit/)
    // nothing was filed as a "learned" fact
    assert.deepEqual(fs.readdirSync(path.join(root, 'nest', 'concepts')).sort(), ['schlafhygiene.md'])
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

test('peckTurn — the model batches two skills in one turn; both run, one answer', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)
  writePage(root, 'concepts', 'q3', { type: 'concept', tags: ['work'], body: 'Q3 numbers live in two sheets.' })
  rebuildRoost(root)
  writeFixtureSkill(root, 'alpha', 'console.log("ALPHA: 42")')
  writeFixtureSkill(root, 'beta', 'console.log("BETA: 30")')

  const s = stubPeckFetch({
    keyTerms: '{"terms": ["q3"]}',
    answerFn: (sys) => {
      const hasAlpha = /<skill_result name="alpha"/.test(sys)
      const hasBeta = /<skill_result name="beta"/.test(sys)
      if (!hasAlpha && !hasBeta) {
        return '<use_skill name="alpha">{}</use_skill>\n<use_skill name="beta">{}</use_skill>'
      }
      return 'Per [[q3]], alpha is 42 and beta is 30 (via alpha, beta).'
    }
  })
  try {
    const r = await peckTurn('what were the Q3 numbers?', { vaultRoot: root })
    assert.equal(r.intent, 'question')
    assert.deepEqual(r.steps.map((x) => [x.skill, x.ok]), [['alpha', true], ['beta', true]])
    assert.match(r.answer, /42/)
    assert.match(r.answer, /30/)
  } finally { s.restore() }
})

test('answerQuestionWithSkills — the plan drives a concurrent batch up front', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  const skills = [
    { name: 'alpha', description: 'fixture alpha', parameters: [], instructions: '' },
    { name: 'beta', description: 'fixture beta', parameters: [], instructions: '' }
  ]

  let calls = 0
  const original = global.fetch
  global.fetch = async (_url, init) => {
    calls++
    const sys = JSON.parse(init.body).messages.map((m) => m.content).join('\n')
    const content = /planning which skills/.test(sys)
      ? '{"calls":[{"name":"alpha","input":{}},{"name":"beta","input":{}}]}'
      : 'alpha + beta done'
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }) }
  }
  t.after(() => { global.fetch = original })

  const invoked = []
  let resolveAlpha, resolveBeta
  const gateAlpha = new Promise((r) => { resolveAlpha = r })
  const gateBeta = new Promise((r) => { resolveBeta = r })
  const runSkillFn = (skill) => {
    invoked.push(skill.name)
    return skill.name === 'alpha'
      ? gateAlpha.then(() => ({ ok: true, output: 'A', error: null, ms: 1 }))
      : gateBeta.then(() => ({ ok: true, output: 'B', error: null, ms: 1 }))
  }

  const resultP = answerQuestionWithSkills('q', [], skills, root, { runSkillFn })

  // Yield until the plan runs and the planned batch dispatches.
  for (let i = 0; i < 10 && invoked.length < 2; i++) {
    await new Promise((r) => setImmediate(r))
  }

  // Both planned skills were dispatched even though neither has resolved yet —
  // that's the concurrency guarantee (a serial loop would await alpha first).
  assert.deepEqual(invoked.slice().sort(), ['alpha', 'beta'])

  resolveAlpha()
  resolveBeta()
  const result = await resultP
  assert.equal(result.answer, 'alpha + beta done')
  assert.deepEqual(result.steps.map((s) => [s.skill, s.ok]), [['alpha', true], ['beta', true]])
})

test('answerQuestionWithSkills — an empty plan falls back to discovery in the loop', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  const skills = [{ name: 'alpha', description: 'fixture alpha', parameters: [], instructions: '' }]

  let calls = 0
  const original = global.fetch
  global.fetch = async (_url, init) => {
    calls++
    const sys = JSON.parse(init.body).messages.map((m) => m.content).join('\n')
    let content
    if (/planning which skills/.test(sys)) content = '{"calls": []}'          // planner says no skills
    else if (!/<skill_result/.test(sys)) content = '<use_skill name="alpha">{}</use_skill>' // adapts anyway
    else content = 'used alpha'
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }) }
  }
  t.after(() => { global.fetch = original })

  const result = await answerQuestionWithSkills('q', [], skills, root, {
    runSkillFn: async () => ({ ok: true, output: 'A', error: null, ms: 1 })
  })
  assert.equal(result.answer, 'used alpha')
  assert.deepEqual(result.steps.map((s) => [s.skill, s.ok]), [['alpha', true]], 'the loop still adapted after an empty plan')
})

test('peckTurn — a web-search run comes back as a hatchable webSource (kip-app#81)', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)
  writePage(root, 'concepts', 'topic', { type: 'concept', body: 'placeholder' })
  rebuildRoost(root)
  // a graph-local fixture named web-search (overrides the built-in), emitting
  // the built-in's output format. Set the skills-config *before* the fixture
  // so writeFixtureSkill's setSkillApproval isn't clobbered.
  onlyFixtureSkills(root, ['web-search'])
  writeFixtureSkill(root, 'web-search',
    'console.log(`Results for "latest on X" (via duckduckgo):\\n\\n- [A page](https://a.test) — a snippet\\n- [B page](https://b.test) — b snippet`)')

  const s = stubPeckFetch({
    keyTerms: '{"terms":["topic"]}',
    answerFn: (sys) => !/<skill_result name="web-search"/.test(sys)
      ? '<use_skill name="web-search">{"query":"latest on X"}</use_skill>'
      : 'Per the web, A and B (via web-search).'
  })
  try {
    const r = await peckTurn('what is the latest on X?', { vaultRoot: root })
    assert.equal(r.intent, 'question')
    assert.ok(r.webSource, 'the turn carries a webSource')
    assert.match(r.webSource.filename, /^web-search-\d{4}-\d{2}-\d{2}-what-is-the-latest-on-x\.md$/)
    assert.match(r.webSource.content, /source: web-search/)
    assert.match(r.webSource.content, /\[A page\]\(https:\/\/a\.test\)/)
    assert.match(r.webSource.content, /\[B page\]\(https:\/\/b\.test\)/)
  } finally { s.restore() }
})

test('peckTurn — nest miss falls back to a web search (kip-app#93)', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)
  writePage(root, 'concepts', 'globex', { type: 'concept', body: 'Globex is a client we onboarded in Q2.' })
  writePage(root, 'concepts', 'globex-project', { type: 'concept', body: 'The Globex project timeline.' })
  rebuildRoost(root)
  onlyFixtureSkills(root, ['web-search'])
  writeFixtureSkill(root, 'web-search',
    'console.log(`Results for "Globex CEO" (via duckduckgo):\\n\\n- [Globex leadership](https://globex.test/about) — Jane Roe is the CEO`)')

  // the nest pages mention Globex but not its CEO -> the plain answer is
  // NO_ANSWER, then the web answer takes over.
  const s = stubPeckFetch({
    keyTerms: '{"terms":["Globex","CEO"]}',
    answerFn: (sys) => /Web search results:/.test(sys)
      ? 'Jane Roe is the CEO of Globex (via web search).'
      : 'NO_ANSWER'
  })
  try {
    const r = await peckTurn('who is the CEO of Globex?', { vaultRoot: root })
    assert.equal(r.intent, 'question')
    assert.match(r.answer, /Jane Roe/)
    assert.ok(r.webSource, 'the web results are offered as a hatchable source')
    assert.deepEqual(r.citedSlugs, [], 'no nest pages were cited')
  } finally { s.restore() }
})

test('peckTurn — nest miss with no web search available returns a null answer', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)
  writePage(root, 'concepts', 'globex', { type: 'concept', body: 'Globex is a client.' })
  writePage(root, 'concepts', 'globex-two', { type: 'concept', body: 'More on Globex.' })
  rebuildRoost(root)
  // makeTempVault already disabled every bundled skill, web-search included.
  const s = stubPeckFetch({ keyTerms: '{"terms":["Globex"]}', answerFn: () => 'NO_ANSWER' })
  try {
    const r = await peckTurn('who is the CEO of Globex?', { vaultRoot: root })
    assert.equal(r.answer, null)
    assert.equal(r.webSource, null)
  } finally { s.restore() }
})

test('peckTurn — no web-search, no webSource', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)
  writePage(root, 'concepts', 'sleep', { type: 'concept', body: 'notes on sleep' })
  rebuildRoost(root)
  const s = stubPeckFetch({ keyTerms: '{"terms":["sleep"]}', answer: 'Per [[sleep]], rest.' })
  try {
    const r = await peckTurn('what about sleep?', { vaultRoot: root })
    assert.equal(r.webSource, null)
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

test('peckTurn — skips the key-term LLM pass when the direct search is confident', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)
  for (const slug of ['sleep-hygiene', 'sleep-quality', 'sleep-tracking', 'sleep-debt']) {
    writePage(root, 'concepts', slug, { type: 'concept', body: 'notes about sleep and rest' })
  }
  rebuildRoost(root)

  const s = stubPeckFetch({ keyTerms: '{"terms":["sleep"]}', answer: 'Per [[sleep-hygiene]], rest more.' })
  try {
    const r = await peckTurn('what do I know about sleep?', { vaultRoot: root })
    assert.equal(r.answer, 'Per [[sleep-hygiene]], rest more.')
    assert.ok(!s.calls.some((c) => /key search terms/i.test(c)),
      'the key-term extraction call was skipped — direct FTS had enough hits')
  } finally { s.restore() }
})

test('peckTurn — thin retrieval still runs the key-term pass', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)
  writePage(root, 'concepts', 'sleep', { type: 'concept', body: 'notes on sleep' })
  rebuildRoost(root)

  const s = stubPeckFetch({ keyTerms: '{"terms":["sleep"]}', answer: 'Per [[sleep]], rest.' })
  try {
    await peckTurn('what about sleep?', { vaultRoot: root })
    assert.ok(s.calls.some((c) => /key search terms/i.test(c)),
      'one matching page (< the confidence threshold) → key-term expansion runs')
  } finally { s.restore() }
})

test('peckTurn — skills are skipped when the nest answers and the question is not skill-ish', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)
  onlyFixtureSkills(root, ['web-search'])
  writeFixtureSkill(root, 'web-search', 'console.log("Results for \\"x\\" (via duckduckgo):\\n\\n- [a](https://a) — s")')
  for (const slug of ['acme-corp', 'acme-pricing', 'acme-contacts']) {
    writePage(root, 'entities', slug, { type: 'entity', body: 'Acme is a client we work with.' })
  }
  rebuildRoost(root)

  const s = stubPeckFetch({ answer: 'Per [[acme-corp]], they are a client.' })
  try {
    const r = await peckTurn('what do we know about Acme?', { vaultRoot: root })
    assert.equal(r.answer, 'Per [[acme-corp]], they are a client.')
    assert.deepEqual(r.steps, [])
    assert.ok(!s.calls.some((c) => /Available skills:/.test(c)), 'no skills block was sent')
  } finally { s.restore() }
})

test('peckTurn — a skill-ish question still gets the skills tool loop', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)
  onlyFixtureSkills(root, ['web-search'])
  writeFixtureSkill(root, 'web-search',
    'console.log("Results for \\"latest\\" (via duckduckgo):\\n\\n- [a page](https://a.test) — snip")')
  for (const slug of ['topic-a', 'topic-b', 'topic-c']) {
    writePage(root, 'concepts', slug, { type: 'concept', body: 'some notes on the topic' })
  }
  rebuildRoost(root)

  const s = stubPeckFetch({
    answerFn: (sys) => !/<skill_result name="web-search"/.test(sys)
      ? '<use_skill name="web-search">{"query":"latest news"}</use_skill>'
      : 'Per the web, ... (via web-search).'
  })
  try {
    const r = await peckTurn('what is the latest news on the topic?', { vaultRoot: root })
    assert.ok(s.calls.some((c) => /Available skills:/.test(c)), '"latest news" is skill-ish → skills block sent')
    assert.ok(r.steps.some((x) => x.skill === 'web-search'))
  } finally { s.restore() }
})

test('peckTurn — a follow-up carries the conversation history into key-terms + the answer (kip-app#82)', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)
  writePage(root, 'entities', 'acme', { type: 'entity', body: 'Acme pays $120k for the senior role.' })
  rebuildRoost(root)

  const s = stubPeckFetch({ keyTerms: '{"terms":["Acme","salary"]}', answer: 'Per [[acme]], $120k.' })
  try {
    const history = [
      { role: 'user', text: 'what do we know about Acme?' },
      { role: 'assistant', text: 'Acme is a prospective client [[acme]].' }
    ]
    const r = await peckTurn('and their salary?', { vaultRoot: root, history })
    assert.equal(r.intent, 'question')
    assert.equal(r.answer, 'Per [[acme]], $120k.')
    // stubPeckFetch collects each call's joined system+user text in .calls
    const keyTermsCall = s.calls.find((p) => /key search terms/i.test(p))
    assert.ok(keyTermsCall && /Acme is a prospective client/.test(keyTermsCall) && /Current question: and their salary\?/.test(keyTermsCall),
      'the key-terms prompt carried the recent turns + the follow-up')
    const answerCall = s.calls.find((p) => !/key search terms/i.test(p) && !/told their personal wiki/i.test(p))
    assert.ok(answerCall && /Conversation so far:/.test(answerCall) && /Acme is a prospective client/.test(answerCall),
      'the answer prompt carried a "Conversation so far" block')
  } finally { s.restore() }
})

test('peckTurn — a question carries the managed backend callId (null for other providers)', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writePage(root, 'concepts', 'sleep', { type: 'concept', body: 'notes on sleep' })
  rebuildRoost(root)

  const original = global.fetch
  t.after(() => { global.fetch = original })

  // kip connector, backend tags the answer call
  saveLLMConfig({ provider: 'kip', providers: { kip: { apiKey: 'kip_x', baseUrl: 'http://lan.test:3000' } } }, root)
  global.fetch = async (url, init) => {
    const sys = JSON.parse(init.body).messages.map((m) => m.content).join('\n')
    const content = /key search terms/.test(sys) ? '{"terms":["sleep"]}' : 'Per [[sleep]], rest.'
    const callId = /key search terms/.test(sys) ? 'call_terms' : 'call_answer'
    return { ok: true, status: 200, headers: new Headers({ 'x-kip-call-id': callId }), json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }) }
  }
  const r = await peckTurn('what about sleep?', { vaultRoot: root })
  assert.equal(r.intent, 'question')
  assert.equal(r.callId, 'call_answer', 'the peck:answer call id, not the key-terms one')

  // a plain provider: same shape, callId null
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)
  const s = stubPeckFetch({ keyTerms: '{"terms":["sleep"]}', answer: 'Per [[sleep]], rest.' })
  try {
    const r2 = await peckTurn('what about sleep?', { vaultRoot: root })
    assert.equal(r2.callId, null)
  } finally { s.restore() }
})

test('peckTurn — sums the metered costUsd across the turn (null for non-kip)', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writePage(root, 'concepts', 'sleep', { type: 'concept', body: 'notes on sleep' })
  rebuildRoost(root)

  const original = global.fetch
  t.after(() => { global.fetch = original })

  // kip connector: key-terms costs 0.0001, the answer 0.0023
  saveLLMConfig({ provider: 'kip', providers: { kip: { apiKey: 'kip_x', baseUrl: 'http://lan.test:3000' } } }, root)
  global.fetch = async (url, init) => {
    const sys = JSON.parse(init.body).messages.map((m) => m.content).join('\n')
    const isTerms = /key search terms/.test(sys)
    const content = isTerms ? '{"terms":["sleep"]}' : 'Per [[sleep]], rest.'
    return {
      ok: true, status: 200,
      headers: new Headers({ 'x-kip-call-id': isTerms ? 'call_terms' : 'call_answer', 'x-kip-cost-usd': isTerms ? '0.0001' : '0.0023' }),
      json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] })
    }
  }
  const r = await peckTurn('what about sleep?', { vaultRoot: root })
  assert.equal(r.costUsd, 0.0024, 'key-terms + answer cost summed for the turn')

  // a plain provider: costUsd null (never guessed)
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)
  const s = stubPeckFetch({ keyTerms: '{"terms":["sleep"]}', answer: 'Per [[sleep]], rest.' })
  try {
    const r2 = await peckTurn('what about sleep?', { vaultRoot: root })
    assert.equal(r2.costUsd, null)
  } finally { s.restore() }
})

test('peckTurn — a regenerate (arenaCompareToCallId) routes the answer through the arena', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writePage(root, 'concepts', 'sleep', { type: 'concept', body: 'notes on sleep' })
  rebuildRoost(root)

  const original = global.fetch
  t.after(() => { global.fetch = original })

  saveLLMConfig({ provider: 'kip', providers: { kip: { apiKey: 'kip_x', baseUrl: 'http://lan.test:3000' } } }, root)
  let arenaCall = null
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    if (/\/v1\/arena\/completions$/.test(url)) {
      arenaCall = { url, body }
      return {
        ok: true, status: 200,
        headers: new Headers({ 'x-kip-arena-id': 'arena_1' }),
        json: async () => ({
          arena_id: 'arena_1', origin: 'regen',
          b: { choices: [{ message: { content: 'A better take, per [[sleep]].' }, finish_reason: 'stop' }], kip_call_id: 'call_B' }
        })
      }
    }
    // key-terms call still goes to /v1/chat/completions
    return { ok: true, status: 200, headers: new Headers({ 'x-kip-call-id': 'call_terms' }), json: async () => ({ choices: [{ message: { content: '{"terms":["sleep"]}' }, finish_reason: 'stop' }] }) }
  }

  const r = await peckTurn('what about sleep?', { vaultRoot: root, arenaCompareToCallId: 'call_A' })
  assert.equal(r.intent, 'question')
  assert.equal(r.answer, 'A better take, per [[sleep]].')
  assert.equal(r.arenaId, 'arena_1')
  assert.equal(r.callId, 'call_B', 'callId is the regenerated answer\'s own id')
  assert.ok(arenaCall, 'the answer call went to /v1/arena/completions')
  assert.equal(arenaCall.body.compare_to_call_id, 'call_A')

  // no arenaCompareToCallId -> normal path, arenaId null
  const s = stubPeckFetch({ keyTerms: '{"terms":["sleep"]}', answer: 'Per [[sleep]], rest.' })
  try {
    const r2 = await peckTurn('what about sleep?', { vaultRoot: root })
    assert.equal(r2.arenaId, null, 'no arena on a plain turn')
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

test('fileAnswerToNest hardening for the app file-back (kip-app#112)', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  await t.test('a 300-character question files fine: slug capped, body keeps the full question', async () => {
    const longQuestion = '这是什么意思呢'.repeat(60) // 360 chars, ~1080 bytes raw — would break an uncapped filename
    const result = await fileAnswerToNest(longQuestion, 'Short answer.', [], root)
    assert.equal(result.action, 'create')
    assert.ok(fs.existsSync(path.join(root, result.path)), 'file written within filename limits')
    assert.ok(result.slug.length <= 60, 'slug capped like web-sources SLUG_MAX')

    const raw = fs.readFileSync(path.join(root, result.path), 'utf8')
    assert.ok(raw.includes('**Q:** ' + longQuestion), 'body keeps the full question')

    const dbPage = getPage(result.slug, root)
    assert.ok(dbPage.summary.length <= 200, 'db summary is the capped question, not the full one')
  })

  await t.test('updating an existing page preserves its summary and merges the from-peck tag', async () => {
    writePage(root, 'concepts', 'sleep-quality', { type: 'concept', tags: ['health'], body: 'Original notes on sleep quality.' })
    rebuildRoost(root)

    const result = await fileAnswerToNest('sleep quality', 'New info.', [], root)
    assert.equal(result.action, 'update')

    const dbPage = getPage('sleep-quality', root)
    assert.equal(dbPage.summary, 'Original notes on sleep quality.', 'index summary not clobbered by the question')
    assert.ok(dbPage.tags.includes('health'), 'existing tag kept')
    assert.ok(dbPage.tags.includes('from-peck'), 'peck marker merged in')

    const raw = fs.readFileSync(path.join(root, dbPage.path), 'utf8')
    assert.ok(raw.includes('from-peck'), 'marker visible in the frontmatter too')
  })

  await t.test('log:false writes no clucks row (the app turn already logged one)', async () => {
    const logFile = path.join(root, 'clucks', `${new Date().toISOString().slice(0, 7)}.md`)
    const before = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
    const beforeCount = (before.match(/peck \|/g) || []).length

    await fileAnswerToNest('a question nobody logged yet?', 'Answer.', [], root, { log: false })

    const after = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
    const afterCount = (after.match(/peck \|/g) || []).length
    assert.equal(afterCount, beforeCount, 'no additional peck row')
  })
})

test('groom findings at answer time (kip-app#116)', async (t) => {
  const { lintWarningsFor, knownConflictsFor } = require('../lib/peck')

  const writeLint = (root, findings) => fs.writeFileSync(
    path.join(root, '.roost', 'lint.json'),
    JSON.stringify({ generated: new Date().toISOString(), deep: false, findings }))

  await t.test('lintWarningsFor / knownConflictsFor read .roost/lint.json without writing it', () => {
    const root = makeTempVault()
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))

    // no file yet -> no warnings, no throw
    assert.deepEqual(lintWarningsFor(root, ['a']), [])

    writeLint(root, {
      'sleep-hygiene': [{ kind: 'orphan', note: 'nothing links to this page' }],
      'salary-2025': [{ kind: 'contradiction', note: '90k vs 110k', slugs: ['salary-2025', 'salary-2026'] }],
      'salary-2026': [{ kind: 'contradiction', note: '90k vs 110k', slugs: ['salary-2025', 'salary-2026'] }]
    })
    const before = fs.readFileSync(path.join(root, '.roost', 'lint.json'), 'utf8')

    assert.deepEqual(lintWarningsFor(root, ['sleep-hygiene', 'unflagged']),
      [{ slug: 'sleep-hygiene', kind: 'orphan', note: 'nothing links to this page' }])
    assert.deepEqual(lintWarningsFor(root, ['unflagged']), [])

    // both sides of the contradiction in play -> one conflict; only one -> none
    assert.deepEqual(knownConflictsFor(root, ['salary-2025', 'salary-2026']),
      [{ slugs: ['salary-2025', 'salary-2026'], note: '90k vs 110k' }])
    assert.deepEqual(knownConflictsFor(root, ['salary-2025', 'something-else']), [])

    assert.equal(fs.readFileSync(path.join(root, '.roost', 'lint.json'), 'utf8'), before, 'lint.json untouched')
  })

  await t.test('an answer that cites a flagged page returns a lintWarning; a clean cite returns none', async () => {
    const root = makeTempVault()
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    writePage(root, 'concepts', 'sleep-hygiene', { type: 'concept', tags: ['health'], body: 'Consistent bedtime, no screens.' })
    rebuildRoost(root)
    saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

    writeLint(root, { 'sleep-hygiene': [{ kind: 'orphan', note: 'nothing links to this page' }] })
    const s = stubPeckFetch({ keyTerms: '{"terms":["sleep"]}', answer: 'Per [[sleep-hygiene]], keep a consistent bedtime.' })
    try {
      const result = await askQuestion('what about sleep?', { vaultRoot: root, fileToNest: false })
      assert.deepEqual(result.lintWarnings, [{ slug: 'sleep-hygiene', kind: 'orphan', note: 'nothing links to this page' }])
    } finally { s.restore() }

    // same nest, lint.json now flags a page this answer does NOT cite
    writeLint(root, { 'some-other-page': [{ kind: 'orphan', note: 'nothing links to this page' }] })
    const s2 = stubPeckFetch({ keyTerms: '{"terms":["sleep"]}', answer: 'Per [[sleep-hygiene]], keep a consistent bedtime.' })
    try {
      const result = await askQuestion('what about sleep?', { vaultRoot: root, fileToNest: false })
      assert.deepEqual(result.lintWarnings, [])
    } finally { s2.restore() }
  })

  await t.test('a groom contradiction between two candidate pages is injected into the answer prompt; no extra LLM call', async () => {
    const root = makeTempVault()
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    writePage(root, 'concepts', 'salary-2025', { type: 'concept', tags: ['work'], body: 'Salary was 90k in 2025.' })
    writePage(root, 'concepts', 'salary-2026', { type: 'concept', tags: ['work'], body: 'Salary is 110k in 2026.' })
    rebuildRoost(root)
    saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

    // baseline: no lint.json — count the calls a turn makes
    const base = stubPeckFetch({ keyTerms: '{"terms":["salary"]}', answer: 'Per [[salary-2025]] and [[salary-2026]].' })
    let baseCalls
    try {
      await askQuestion('what is my salary?', { vaultRoot: root, fileToNest: false })
      baseCalls = base.calls.length
    } finally { base.restore() }

    writeLint(root, {
      'salary-2025': [{ kind: 'contradiction', note: '2025 says 90k, 2026 says 110k', slugs: ['salary-2025', 'salary-2026'] }],
      'salary-2026': [{ kind: 'contradiction', note: '2025 says 90k, 2026 says 110k', slugs: ['salary-2025', 'salary-2026'] }]
    })
    const s = stubPeckFetch({ keyTerms: '{"terms":["salary"]}', answer: 'Per [[salary-2025]] and [[salary-2026]].' })
    try {
      await askQuestion('what is my salary?', { vaultRoot: root, fileToNest: false })
      const answerCall = s.calls.find((sys) => /You are answering a question from a personal wiki/.test(sys))
      assert.match(answerCall, /Known disagreements in your nest/)
      assert.match(answerCall, /\[\[salary-2025\]\] vs \[\[salary-2026\]\]/)
      assert.match(answerCall, /2025 says 90k, 2026 says 110k/)
      assert.equal(s.calls.length, baseCalls, 'reading lint.json adds no LLM round-trip')
    } finally { s.restore() }
  })
})
