const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')

const {
  parseWhen, parseLead, parseSound, deriveTitle, looksLikeReminder,
  addReminder, listReminders, cancelReminder, setReminderSound, dueReminders, markNotified,
  loadReminders, describeReminder
} = require('../lib/reminders')
const { generateMeetingPrep } = require('../lib/prompts')
const { discoverSkills, runSkill } = require('../lib/skills')

const REF = new Date('2026-08-26T09:00:00') // a Wednesday

function makeCoop () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-rem-test-'))
  fs.mkdirSync(path.join(root, '.roost'), { recursive: true })
  fs.mkdirSync(path.join(root, 'clucks'), { recursive: true })
  return root
}

const CLI = path.join(__dirname, '..', 'reminders.js')
function cli (root, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, KIP_COOP_ROOT: root } },
      (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}

// ---------------------------------------------------------------------------
// natural-language interpretation
// ---------------------------------------------------------------------------

test('parseWhen: "Friday at 15h" -> next Friday 15:00', () => {
  const r = parseWhen('meeting with Acme on friday at 15h', REF)
  assert.equal(r.hadTime, true)
  const d = new Date(r.eventAt)
  assert.equal(d.getFullYear(), 2026)
  assert.equal(d.getMonth(), 7)     // August
  assert.equal(d.getDate(), 28)     // Friday after Wed the 26th
  assert.equal(d.getHours(), 15)
})

test('parseWhen: dateless "on Friday" defaults to 09:00', () => {
  const r = parseWhen('review on friday', REF)
  assert.equal(r.hadTime, false)
  assert.equal(new Date(r.eventAt).getHours(), 9)
})

test('parseWhen: "in 2 hours" is relative to the reference', () => {
  const r = parseWhen('call in 2 hours', REF)
  assert.equal(new Date(r.eventAt).getTime(), REF.getTime() + 2 * 3600_000)
})

test('parseWhen: bare "on the 20th" resolves (ordinal-day normalization)', () => {
  const r = parseWhen("don't forget the review on the 20th", REF)
  const d = new Date(r.eventAt)
  assert.equal(d.getMonth(), 8) // Sept — the 20th already passed in Aug
  assert.equal(d.getDate(), 20)
})

test('parseWhen: no time expression -> null', () => {
  assert.equal(parseWhen('lunch with a friend', REF).eventAt, null)
})

test('parseLead', () => {
  assert.equal(parseLead('remind me a day before'), 1440)
  assert.equal(parseLead('30 minutes before'), 30)
  assert.equal(parseLead('2 hours prior'), 120)
  assert.equal(parseLead('half an hour before'), 30)
  assert.equal(parseLead('no lead phrase here'), null)
})

test('parseSound: false only when the text asks for silence', () => {
  assert.equal(parseSound('remind me silently about the call'), false)
  assert.equal(parseSound('meeting friday, no sound please'), false)
  assert.equal(parseSound('mute the dentist reminder'), false)
  assert.equal(parseSound('meeting with Acme friday at 15h'), null)
})

test('deriveTitle strips the date phrase, lead phrase, and framing', () => {
  const p = parseWhen('I have a meeting with Acme on friday at 15h, remind me a day before', REF)
  assert.equal(deriveTitle('I have a meeting with Acme on friday at 15h, remind me a day before', p.matchedText),
    'meeting with Acme')
})

test('looksLikeReminder', () => {
  for (const yes of ['I have a meeting on Friday at 15h', 'remind me to email Bob tomorrow',
    "don't let me forget the review on the 20th", 'dentist appointment next tuesday 9am']) {
    assert.equal(looksLikeReminder(yes), true, yes)
  }
  for (const no of ['what do I know about sleep?', 'the CDO of Acme is Jane Doe',
    'summarize my week', 'I had a meeting yesterday about budgets']) {
    assert.equal(looksLikeReminder(no), false, no)
  }
})

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

test('addReminder / listReminders / cancelReminder round-trip', (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const row = addReminder(root, { text: 'meeting with Acme on friday at 15h, remind me a day before', ref: REF })
  assert.equal(row.id, 1)
  assert.equal(row.title, 'meeting with Acme')
  assert.equal(row.leadMin, 1440)
  assert.equal(row.status, 'pending')
  // notifyAt = eventAt - lead
  assert.equal(new Date(row.notifyAt).getTime(), new Date(row.eventAt).getTime() - 1440 * 60_000)

  assert.ok(fs.existsSync(path.join(root, 'reminders.json')))
  assert.equal(listReminders(root).length, 1)

  const two = addReminder(root, { text: 'call bob tomorrow at 10:00', ref: REF })
  assert.equal(two.id, 2)
  assert.equal(two.leadMin, 60) // default

  cancelReminder(root, 1)
  assert.equal(loadReminders(root).find((r) => r.id === 1).status, 'canceled')
  assert.equal(listReminders(root, { status: 'pending' }).length, 1)
})

test('addReminder: explicit leadMin and title win', (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const row = addReminder(root, { title: 'Board sync', when: 'friday 14:00', lead: '2h', ref: REF })
  assert.equal(row.title, 'Board sync')
  assert.equal(row.leadMin, 120)
})

test('addReminder / setReminderSound: sound defaults on, mutable', (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const a = addReminder(root, { text: 'call bob friday 10:00', ref: REF })
  assert.equal(a.sound, true)

  const b = addReminder(root, { text: 'call sam friday 11:00, remind me silently', ref: REF })
  assert.equal(b.sound, false)

  const c = addReminder(root, { text: 'call amy friday 12:00', sound: false, ref: REF })
  assert.equal(c.sound, false)

  setReminderSound(root, a.id, false)
  assert.equal(loadReminders(root).find((r) => r.id === a.id).sound, false)
  setReminderSound(root, a.id, true)
  assert.equal(loadReminders(root).find((r) => r.id === a.id).sound, true)

  assert.match(describeReminder(b), /silent/)
})

test('addReminder: throws when no date can be parsed', (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.throws(() => addReminder(root, { text: 'lunch sometime' }), /date\/time/)
})

test('dueReminders: only pending + notifyAt in the past', (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const past = addReminder(root, { title: 'past', when: 'in 10 minutes', lead: 30, ref: REF }) // notify 20m before REF
  addReminder(root, { title: 'future', when: 'friday 15:00', lead: 30, ref: REF })
  const due = dueReminders(root, REF)
  assert.equal(due.length, 1)
  assert.equal(due[0].id, past.id)

  markNotified(root, past.id, { relatedSlugs: ['x'], context: 'brief' })
  assert.equal(dueReminders(root, REF).length, 0)
  const saved = loadReminders(root).find((r) => r.id === past.id)
  assert.equal(saved.status, 'notified')
  assert.deepEqual(saved.relatedSlugs, ['x'])
  assert.equal(saved.context, 'brief')
})

test('describeReminder is a single confirmation line', () => {
  const line = describeReminder({ title: 'x', eventAt: '2026-08-28T13:00:00Z', notifyAt: '2026-08-27T13:00:00Z', leadMin: 1440 })
  assert.match(line, /^⏰ Reminder set:.*1d before "x"/)
})

// ---------------------------------------------------------------------------
// generateMeetingPrep
// ---------------------------------------------------------------------------

test('generateMeetingPrep: null with no pages; one LLM call with pages', async (t) => {
  assert.equal(await generateMeetingPrep({ title: 't' }, [], '/tmp/none'), null)

  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  require('../lib/llm').saveLLMConfig({ provider: 'local', providers: { local: { model: 'm' } } }, root)

  const original = global.fetch
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: '- Meeting with [[acme]] about renewal.' } }] })
  })
  try {
    const brief = await generateMeetingPrep({ title: 'Acme renewal', eventAt: '2026-08-28T13:00:00Z' },
      [{ slug: 'acme', type: 'entity', content: 'Acme is a customer.' }], root)
    assert.match(brief, /\[\[acme\]\]/)
  } finally {
    global.fetch = original
  }
})

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test('CLI: add -> list -> --due -> --check', async (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  let r = await cli(root, ['add', 'meeting with Acme on friday at 15h'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /Reminder set/)

  r = await cli(root, ['list', '--json'])
  assert.equal(JSON.parse(r.stdout).reminders.length, 1)

  // backdate the notify time so --due fires it
  const store = JSON.parse(fs.readFileSync(path.join(root, 'reminders.json'), 'utf8'))
  store.reminders[0].notifyAt = new Date(Date.now() - 60_000).toISOString()
  fs.writeFileSync(path.join(root, 'reminders.json'), JSON.stringify(store))

  r = await cli(root, ['--due', '--json'])
  const fired = JSON.parse(r.stdout).fired
  assert.equal(fired.length, 1)
  assert.equal(fired[0].status, 'notified')
  assert.ok(fired[0].context, 'a context brief (pages-only fallback here) is attached')

  // clucks entry written
  const clucks = fs.readdirSync(path.join(root, 'clucks'))
  assert.ok(clucks.length >= 1)

  r = await cli(root, ['--check', '--json'])
  assert.equal(JSON.parse(r.stdout).pending, 0)

  r = await cli(root, ['--due', '--json'])
  assert.equal(JSON.parse(r.stdout).fired.length, 0, 'a notified reminder does not fire again')
})

test('CLI: cancel', async (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  await cli(root, ['add', 'call bob tomorrow 10:00'])
  const r = await cli(root, ['cancel', '1', '--json'])
  assert.equal(JSON.parse(r.stdout).canceled, true)
})

test('CLI: --silent add, then mute/unmute', async (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let r = await cli(root, ['add', 'call bob tomorrow 10:00', '--silent', '--json'])
  assert.equal(JSON.parse(r.stdout).reminder.sound, false)

  r = await cli(root, ['add', 'call sam tomorrow 11:00', '--json'])
  assert.equal(JSON.parse(r.stdout).reminder.sound, true)
  r = await cli(root, ['mute', '2', '--json'])
  assert.equal(JSON.parse(r.stdout).reminder.sound, false)
  r = await cli(root, ['unmute', '2', '--json'])
  assert.equal(JSON.parse(r.stdout).reminder.sound, true)
})

// ---------------------------------------------------------------------------
// the skill (real subprocess)
// ---------------------------------------------------------------------------

test('reminders skill: create / list / cancel', async (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const skill = discoverSkills(root, { includeDisabled: true }).find((s) => s.name === 'reminders')
  assert.ok(skill, 'the reminders skill is a discoverable built-in')
  assert.equal(skill.source, 'builtin')

  let res = await runSkill(skill, { action: 'create', text: 'meeting with Acme on friday at 15h, remind me a day before' }, root)
  assert.equal(res.ok, true)
  assert.match(res.output, /Reminder set:.*meeting with Acme/)
  assert.equal(listReminders(root).length, 1)

  res = await runSkill(skill, { action: 'list' }, root)
  assert.match(res.output, /#1.*meeting with Acme/)

  res = await runSkill(skill, { action: 'mute', id: 1 }, root)
  assert.match(res.output, /Muted reminder #1/)
  assert.equal(loadReminders(root).find((r) => r.id === 1).sound, false)
  res = await runSkill(skill, { action: 'unmute', id: 1 }, root)
  assert.match(res.output, /Unmuted reminder #1/)

  res = await runSkill(skill, { action: 'cancel', id: 1 }, root)
  assert.match(res.output, /Canceled reminder #1/)

  res = await runSkill(skill, { action: 'create', text: 'lunch with a friend' }, root)
  assert.equal(res.ok, true)
  assert.match(res.output, /could not work out a date/) // relayed, not a crash
})
