const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  discoverSkills, describeSkills, runSkill, loadSkillsConfig, saveSkillsConfig,
  setSkillEnabled, setSkillApproval, loadSearchSettings, saveSearchSettings, parseSkillCall, parseSkillCalls, scrubInput
} = require('../lib/skills')
const telemetry = require('../lib/telemetry')

function makeTempCoop () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-skills-test-'))
  fs.mkdirSync(path.join(root, '.henhouse', 'skills'), { recursive: true })
  fs.mkdirSync(path.join(root, 'eggs'), { recursive: true })
  return root
}

/** Writes <coop>/.henhouse/skills/<name>/{SKILL.md, run.js}. Auto-approves the
 *  skill so existing runnability tests are unaffected; pass approve:false to
 *  test the approval gate itself. */
function writeSkill (root, name, { frontmatter = {}, body = '', run = 'process.exit(0)', approve = true } = {}) {
  const dir = path.join(root, '.henhouse', 'skills', name)
  fs.mkdirSync(dir, { recursive: true })
  const fm = Object.assign({ name, description: `test skill ${name}`, entry: 'run.js' }, frontmatter)
  const yaml = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${yaml}\n---\n${body}\n`)
  fs.writeFileSync(path.join(dir, 'run.js'), run)
  if (approve) setSkillApproval(root, name, 'always')
  return dir
}

function setSkillsConfig (root, cfg) {
  // keep whatever writeSkill() approved unless the test sets `approved` itself
  const p = path.join(root, '.henhouse', 'skills.json')
  let prev = {}
  try { prev = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { /* none yet */ }
  fs.writeFileSync(p, JSON.stringify({ ...(prev.approved ? { approved: prev.approved } : {}), ...cfg }))
}

// ---------------------------------------------------------------------------

test('discoverSkills: includes the built-ins, then user skills; user wins on name', (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  let skills = discoverSkills(root)
  const names = skills.map((s) => s.name).sort()
  assert.ok(names.includes('xlsx-csv'), 'built-in xlsx-csv discovered')
  assert.ok(names.includes('web-search'), 'built-in web-search discovered')
  assert.equal(skills.find((s) => s.name === 'xlsx-csv').source, 'builtin')

  writeSkill(root, 'notes-lookup', { body: 'looks stuff up' })
  writeSkill(root, 'xlsx-csv', { frontmatter: { description: 'my override' } })

  skills = discoverSkills(root)
  assert.ok(skills.some((s) => s.name === 'notes-lookup' && s.source === 'user'))
  const overridden = skills.find((s) => s.name === 'xlsx-csv')
  assert.equal(overridden.source, 'user')
  assert.equal(overridden.description, 'my override')
})

test('approval gate: a user skill is not runnable until approved; the choice sticks', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeSkill(root, 'custom', { frontmatter: { network: true, permissions: ['read files', 'network'] }, run: 'console.log("ran")', approve: false })

  // not offered to Peck
  assert.ok(!discoverSkills(root).some((s) => s.name === 'custom'))

  // but visible in Settings, marked pending, with its declared permissions
  const listed = describeSkills(root).find((s) => s.name === 'custom')
  assert.equal(listed.approval, 'pending')
  assert.deepEqual(listed.permissions, ['read files', 'network'])

  // and it refuses to run
  const skill = discoverSkills(root, { includeDisabled: true }).find((s) => s.name === 'custom')
  const blocked = await runSkill(skill, {}, root)
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /approved/i)

  // approve -> runnable + offered, and persisted to skills.json
  assert.equal(setSkillApproval(root, 'custom', 'always').approval, 'always')
  assert.equal(loadSkillsConfig(root).approved.custom, 'always')
  assert.ok(discoverSkills(root).some((s) => s.name === 'custom'))
  assert.equal((await runSkill(skill, {}, root)).ok, true)

  // block -> not runnable again
  setSkillApproval(root, 'custom', 'never')
  assert.equal(describeSkills(root).find((s) => s.name === 'custom').approval, 'never')
  assert.equal((await runSkill(skill, {}, root)).ok, false)

  // forget -> back to pending
  setSkillApproval(root, 'custom', null)
  assert.equal(describeSkills(root).find((s) => s.name === 'custom').approval, 'pending')
})

test('approval gate: built-ins are always allowed and ignore approval', (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bi = describeSkills(root).find((s) => s.name === 'xlsx-csv')
  assert.equal(bi.source, 'builtin')
  assert.equal(bi.approval, '')
  assert.ok(discoverSkills(root).some((s) => s.name === 'xlsx-csv'))
})

test('discoverSkills: skills.json "disabled" hides a skill unless includeDisabled', (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeSkill(root, 'thing', {})
  setSkillsConfig(root, { disabled: ['web-search', 'thing'] })

  const enabled = discoverSkills(root).map((s) => s.name)
  assert.ok(!enabled.includes('web-search'))
  assert.ok(!enabled.includes('thing'))

  const all = discoverSkills(root, { includeDisabled: true })
  assert.equal(all.find((s) => s.name === 'thing').enabled, false)
  assert.equal(all.find((s) => s.name === 'xlsx-csv').enabled, true)
})

test('discoverSkills: a malformed SKILL.md is skipped, not thrown', (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, '.henhouse', 'skills', 'no-name')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\ndescription: "no name here"\n---\n')
  fs.writeFileSync(path.join(dir, 'run.js'), 'process.exit(0)')

  const skills = discoverSkills(root)
  assert.ok(!skills.some((s) => s.name === 'no-name'))
  assert.ok(skills.length >= 2) // built-ins still there
})

test('runSkill: passes SKILL_INPUT + KIP_COOP_ROOT to the child, captures stdout', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeSkill(root, 'echo', {
    run: 'console.log(JSON.stringify({ input: JSON.parse(process.env.SKILL_INPUT), coop: process.env.KIP_COOP_ROOT }))'
  })
  const skill = discoverSkills(root).find((s) => s.name === 'echo')

  const res = await runSkill(skill, { a: 1, b: 'two' }, root)
  assert.equal(res.ok, true)
  const parsed = JSON.parse(res.output)
  assert.deepEqual(parsed.input, { a: 1, b: 'two' })
  assert.equal(parsed.coop, path.resolve(root))
  assert.ok(typeof res.ms === 'number')
})

test('runSkill: injects per-skill secrets from skills.json as env', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeSkill(root, 'needs-key', { run: 'console.log(process.env.MY_TOKEN || "MISSING")' })
  setSkillsConfig(root, { secrets: { 'needs-key': { MY_TOKEN: 'sekret' } } })
  const skill = discoverSkills(root).find((s) => s.name === 'needs-key')

  const res = await runSkill(skill, {}, root)
  assert.equal(res.output, 'sekret')
})

test('runSkill: a non-zero exit is { ok: false } with the stderr', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeSkill(root, 'broken', { run: 'console.error("boom"); process.exit(3)' })
  const skill = discoverSkills(root).find((s) => s.name === 'broken')

  const res = await runSkill(skill, {}, root)
  assert.equal(res.ok, false)
  assert.match(res.error, /boom/)
})

test('runSkill: a hanging skill times out', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeSkill(root, 'slow', { run: 'setInterval(() => {}, 1e9)' })
  const skill = discoverSkills(root).find((s) => s.name === 'slow')

  const res = await runSkill(skill, {}, root, { timeoutMs: 500 })
  assert.equal(res.ok, false)
  assert.equal(res.timedOut, true)
  assert.match(res.error, /timed out/)
})

test('runSkill: oversized output is capped', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeSkill(root, 'chatty', { run: 'process.stdout.write("x".repeat(1024 * 1024))' })
  const skill = discoverSkills(root).find((s) => s.name === 'chatty')

  const res = await runSkill(skill, {}, root, { outputCapBytes: 2048 })
  assert.ok(res.output.length <= 2100, `output was ${res.output.length}`)
})

test('runSkill: records a content-free telemetry entry', async (t) => {
  telemetry.reset()
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeSkill(root, 'echo', { run: 'console.log("SENSITIVE OUTPUT")' })
  const skill = discoverSkills(root).find((s) => s.name === 'echo')

  await runSkill(skill, { apiKey: 'sk-leak' }, root)
  const entries = telemetry.entries()
  const e = entries.find((x) => x.label === 'skill:echo')
  assert.ok(e, 'a skill:echo entry exists')
  assert.equal(e.phase, 'skill')
  for (const k of ['prompt', 'system', 'responseText']) assert.ok(!(k in e), `entries() leaked ${k}`)
  assert.equal(JSON.stringify(telemetry.summary()).includes('SENSITIVE'), false)
})

test('parseSkillCall: clean, fenced, amid prose, absent, malformed', () => {
  assert.deepEqual(
    parseSkillCall('<use_skill name="web-search">{"query":"cats"}</use_skill>'),
    { name: 'web-search', input: { query: 'cats' } }
  )
  assert.deepEqual(
    parseSkillCall('sure:\n<use_skill name="xlsx-csv">\n```json\n{"file":"a.csv"}\n```\n</use_skill>'),
    { name: 'xlsx-csv', input: { file: 'a.csv' } }
  )
  assert.deepEqual(
    parseSkillCall('I will look: <use_skill name="thing">{"x": 1} and then</use_skill> done'),
    { name: 'thing', input: { x: 1 } }
  )
  assert.equal(parseSkillCall('just a plain answer with [[a-slug]]'), null)
  assert.deepEqual(
    parseSkillCall('<use_skill name="thing">not json</use_skill>'),
    { name: 'thing', input: null }
  )
})

test('parseSkillCalls: returns every tag in order; empty when none', () => {
  assert.deepEqual(
    parseSkillCalls('<use_skill name="a">{"x":1}</use_skill>\n<use_skill name="b">{"y":2}</use_skill>'),
    [{ name: 'a', input: { x: 1 } }, { name: 'b', input: { y: 2 } }]
  )
  assert.deepEqual(
    parseSkillCalls('first <use_skill name="a">{}</use_skill>, then <use_skill name="b">{"q":"z"}</use_skill> done'),
    [{ name: 'a', input: {} }, { name: 'b', input: { q: 'z' } }]
  )
  assert.deepEqual(parseSkillCalls('just a plain answer with [[a-slug]]'), [])
  assert.deepEqual(parseSkillCalls(''), [])
  // a malformed second tag still yields a { input: null } entry, not a drop
  assert.deepEqual(
    parseSkillCalls('<use_skill name="a">{"x":1}</use_skill><use_skill name="b">not json</use_skill>'),
    [{ name: 'a', input: { x: 1 } }, { name: 'b', input: null }]
  )
})

test('scrubInput redacts secret-ish keys', () => {
  assert.deepEqual(
    scrubInput({ query: 'x', apiKey: 'sk-abc', BRAVE_TOKEN: 'brv', count: 3 }),
    { query: 'x', apiKey: '[redacted]', BRAVE_TOKEN: '[redacted]', count: 3 }
  )
})

test('loadSkillsConfig: safe default on a missing/broken file', (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.deepEqual(loadSkillsConfig(root), { disabled: [], secrets: {}, config: {}, approved: {} })
  fs.writeFileSync(path.join(root, '.henhouse', 'skills.json'), '{ not json')
  assert.deepEqual(loadSkillsConfig(root), { disabled: [], secrets: {}, config: {}, approved: {} })
})

// ---------------------------------------------------------------------------
// the bundled xlsx-csv skill, end to end
// ---------------------------------------------------------------------------

test('xlsx-csv skill: summarizes a CSV', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'eggs', 'data.csv'), 'name,score\na,10\nb,20\n')

  const skill = discoverSkills(root).find((s) => s.name === 'xlsx-csv')
  const res = await runSkill(skill, { file: 'eggs/data.csv', operation: 'summarize' }, root)

  assert.equal(res.ok, true, res.error || '')
  assert.match(res.output, /2 rows/)
  assert.match(res.output, /\| name \|/)
  assert.match(res.output, /\| score \|/)
  assert.match(res.output, /sum 30/)
  assert.match(res.output, /mean 15/)
})

test('xlsx-csv skill: refuses a path that escapes the coop', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const skill = discoverSkills(root).find((s) => s.name === 'xlsx-csv')

  const res = await runSkill(skill, { file: '../../etc/passwd' }, root)
  assert.equal(res.ok, false)
  assert.match(res.error, /outside the coop/)
})

// ---------------------------------------------------------------------------
// the bundled docx / pptx skills, end to end
// ---------------------------------------------------------------------------

const PizZip = require('pizzip')

/** Every ppt/slides/slideN.xml or word/document.xml text, concatenated. */
function zipText (file, pattern) {
  const zip = new PizZip(fs.readFileSync(file))
  return zip.file(pattern).map((f) => f.asText()).join('\n')
}

test('docx skill: builds a .docx from content blocks', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const skill = discoverSkills(root).find((s) => s.name === 'docx')

  const res = await runSkill(skill, {
    title: 'Report',
    filename: 'r.docx',
    content: [
      { heading: 'Intro', level: 1 },
      { text: 'Hello world.' },
      { bullets: ['one', 'two'] },
      { table: { headers: ['A', 'B'], rows: [['1', '2']] } }
    ]
  }, root)

  assert.equal(res.ok, true, res.error || '')
  assert.match(res.output, /exports\/r\.docx/)
  const out = path.join(root, 'exports', 'r.docx')
  assert.ok(fs.existsSync(out), 'file written')
  const xml = new PizZip(fs.readFileSync(out)).file('word/document.xml').asText()
  assert.match(xml, /Hello world\./)
  assert.match(xml, /Intro/)
  assert.match(xml, /one/)
})

test('docx skill: fills a .docx template with data', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const D = require('docx')
  const tplBuf = await D.Packer.toBuffer(new D.Document({
    sections: [{ children: [new D.Paragraph('Dear {client},'), new D.Paragraph('You have {count} open items.')] }]
  }))
  fs.mkdirSync(path.join(root, 'templates'))
  fs.writeFileSync(path.join(root, 'templates', 'memo.docx'), tplBuf)

  const skill = discoverSkills(root).find((s) => s.name === 'docx')
  const res = await runSkill(skill, { template: 'templates/memo.docx', data: { client: 'Acme', count: 7 } }, root)

  assert.equal(res.ok, true, res.error || '')
  const xml = new PizZip(fs.readFileSync(path.join(root, 'exports', 'memo-filled.docx'))).file('word/document.xml').asText()
  assert.match(xml, /Dear Acme,/)
  assert.match(xml, /You have 7 open items\./)
})

test('docx skill: refuses a template path outside the coop', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const skill = discoverSkills(root).find((s) => s.name === 'docx')

  const res = await runSkill(skill, { template: '../../secret.docx', data: {} }, root)
  assert.equal(res.ok, false)
  assert.match(res.error, /outside the coop/)
})

test('pptx skill: builds a .pptx from a slide outline', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const skill = discoverSkills(root).find((s) => s.name === 'pptx')

  const res = await runSkill(skill, {
    title: 'Deck',
    filename: 'd.pptx',
    slides: [{ title: 'Goals', bullets: ['ship', 'measure'] }, { section: 'Next' }]
  }, root)

  assert.equal(res.ok, true, res.error || '')
  const out = path.join(root, 'exports', 'd.pptx')
  assert.ok(fs.existsSync(out), 'file written')
  const texts = zipText(out, /ppt\/slides\/slide\d+\.xml/)
  assert.match(texts, /Goals/)
  assert.match(texts, /ship/)
  assert.match(texts, /Next/)
})

test('pptx skill: applies a JSON theme', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'theme.json'), JSON.stringify({ primary: '#102030', font: 'Georgia', footer: 'CONF-MARK' }))

  const skill = discoverSkills(root).find((s) => s.name === 'pptx')
  const res = await runSkill(skill, { filename: 't.pptx', theme: 'theme.json', slides: [{ title: 'X', text: 'y' }] }, root)

  assert.equal(res.ok, true, res.error || '')
  assert.match(res.output, /themed/)
  const chrome = zipText(path.join(root, 'exports', 't.pptx'), /ppt\/slide(Masters|Layouts)\/.*\.xml/)
  assert.match(chrome, /CONF-MARK/)
})

test('pptx skill: clones a .pptx template and fills its placeholders', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const PptxGenJS = require('pptxgenjs')
  const g = new PptxGenJS()
  g.layout = 'LAYOUT_WIDE'
  const s = g.addSlide()
  s.background = { color: 'EEEEEE' }
  s.addText('PH TITLE', { x: 0.5, y: 0.3, w: 9, h: 1, fontSize: 28 })
  s.addText('PH BODY', { x: 0.5, y: 1.7, w: 9, h: 4, fontSize: 16 })
  await g.writeFile({ fileName: path.join(root, 'brand.pptx') })

  const skill = discoverSkills(root).find((sk) => sk.name === 'pptx')
  const res = await runSkill(skill, {
    template: 'brand.pptx',
    filename: 'out.pptx',
    slides: [{ title: 'Agenda', bullets: ['Intro', 'Wrap'] }]
  }, root)

  assert.equal(res.ok, true, res.error || '')
  const texts = zipText(path.join(root, 'exports', 'out.pptx'), /ppt\/slides\/slide\d+\.xml/)
  assert.match(texts, /Agenda/)
  assert.match(texts, /Intro/)
})

// ---------------------------------------------------------------------------
// kip-control (the built-in "drive the app" skill)
// ---------------------------------------------------------------------------

test('kip-control: discovered as a built-in with an operation enum', (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const skill = discoverSkills(root).find((s) => s.name === 'kip-control')
  assert.ok(skill, 'kip-control is discovered')
  assert.equal(skill.source, 'builtin')
  const opParam = skill.parameters.find((p) => p.name === 'operation')
  assert.ok(opParam && opParam.enum.includes('status') && opParam.enum.includes('set-provider'))
})

test('kip-control: unknown operation is a clean failure', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const skill = discoverSkills(root).find((s) => s.name === 'kip-control')

  const res = await runSkill(skill, { operation: 'nope' }, root)
  assert.equal(res.ok, false)
  assert.match(res.error, /unknown operation/)
})

test('kip-control: set-skill toggles skills.json "disabled"', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const skill = discoverSkills(root).find((s) => s.name === 'kip-control')

  let res = await runSkill(skill, { operation: 'set-skill', skill: 'web-search', enabled: false }, root)
  assert.equal(res.ok, true, res.error || '')
  assert.deepEqual(loadSkillsConfig(root).disabled, ['web-search'])
  assert.ok(!discoverSkills(root).some((s) => s.name === 'web-search'))

  res = await runSkill(skill, { operation: 'set-skill', skill: 'web-search', enabled: true }, root)
  assert.equal(res.ok, true, res.error || '')
  assert.deepEqual(loadSkillsConfig(root).disabled, [])
})

test('kip-control: set-skill refuses to disable kip-control itself', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const skill = discoverSkills(root).find((s) => s.name === 'kip-control')

  const res = await runSkill(skill, { operation: 'set-skill', skill: 'kip-control', enabled: false }, root)
  assert.equal(res.ok, false)
  assert.match(res.error, /refusing to disable/)
})

test('kip-control: settings reports the provider and every skill', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const skill = discoverSkills(root).find((s) => s.name === 'kip-control')

  const res = await runSkill(skill, { operation: 'settings' }, root)
  assert.equal(res.ok, true, res.error || '')
  assert.match(res.output, /LLM provider/)
  assert.match(res.output, /xlsx-csv/)
})

test('kip-control: status runs against a fresh coop', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const skill = discoverSkills(root).find((s) => s.name === 'kip-control')

  const res = await runSkill(skill, { operation: 'status' }, root)
  assert.equal(res.ok, true, res.error || '')
  assert.match(res.output, /Kip status/)
  assert.match(res.output, /Pending sources: 0/)
  assert.match(res.output, /Hatch: idle/)
})

// ---------------------------------------------------------------------------
// per-skill config + env, settings helpers
// ---------------------------------------------------------------------------

test('runSkill: skills.json "config" is spread into the child env; opts.env overrides', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeSkill(root, 'envdump', { run: 'console.log(process.env.FOO + "/" + process.env.BAR)' })
  setSkillsConfig(root, { config: { envdump: { FOO: 'from-config', BAR: 'from-config' } } })
  const skill = discoverSkills(root).find((s) => s.name === 'envdump')

  let res = await runSkill(skill, {}, root)
  assert.equal(res.output, 'from-config/from-config')

  res = await runSkill(skill, {}, root, { env: { BAR: 'from-override' } })
  assert.equal(res.output, 'from-config/from-override')
})

test('setSkillEnabled: toggles "disabled", leaving other fields intact', (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  setSkillsConfig(root, { secrets: { 'web-search': { BRAVE_API_KEY: 'k' } }, config: { foo: { X: '1' } } })

  setSkillEnabled(root, 'web-search', false)
  assert.deepEqual(loadSkillsConfig(root).disabled, ['web-search'])
  setSkillEnabled(root, 'web-search', false) // idempotent
  assert.deepEqual(loadSkillsConfig(root).disabled, ['web-search'])

  setSkillEnabled(root, 'web-search', true)
  const cfg = loadSkillsConfig(root)
  assert.deepEqual(cfg.disabled, [])
  assert.deepEqual(cfg.secrets, { 'web-search': { BRAVE_API_KEY: 'k' } }, 'secrets untouched')
  assert.deepEqual(cfg.config, { foo: { X: '1' } }, 'config untouched')
})

test('load/saveSearchSettings: backend in config, keys in secrets, disabled untouched', (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  assert.deepEqual(loadSearchSettings(root), { backend: 'duckduckgo', braveApiKey: '', tavilyApiKey: '' })

  setSkillEnabled(root, 'docx', false) // pre-existing unrelated state

  saveSearchSettings(root, { backend: 'brave', braveApiKey: 'sk-brave' })
  let raw = JSON.parse(fs.readFileSync(path.join(root, '.henhouse', 'skills.json'), 'utf8'))
  assert.equal(raw.config['web-search'].SEARCH_BACKEND, 'brave')
  assert.equal(raw.secrets['web-search'].BRAVE_API_KEY, 'sk-brave')
  assert.deepEqual(raw.disabled, ['docx'], 'disabled list preserved')
  assert.deepEqual(loadSearchSettings(root), { backend: 'brave', braveApiKey: 'sk-brave', tavilyApiKey: '' })

  // clearing a key removes it; junk backend falls back
  saveSearchSettings(root, { backend: 'nonsense', braveApiKey: '' })
  raw = JSON.parse(fs.readFileSync(path.join(root, '.henhouse', 'skills.json'), 'utf8'))
  assert.equal(raw.config['web-search'].SEARCH_BACKEND, 'duckduckgo')
  assert.ok(!raw.secrets || !raw.secrets['web-search'], 'empty secrets entry pruned')
})

test('describeSkills: content-free, includes disabled ones', (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  setSkillEnabled(root, 'web-search', false)

  const list = describeSkills(root)
  const ws = list.find((s) => s.name === 'web-search')
  assert.equal(ws.enabled, false)
  assert.equal(ws.dir, undefined, 'no filesystem path leaks')
  assert.equal(ws.entryPath, undefined)
  assert.ok(list.find((s) => s.name === 'xlsx-csv').enabled)
})
