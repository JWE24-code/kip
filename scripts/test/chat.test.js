// Tests for scripts/chat.js — the app's JSON entrypoint. Only the parts that
// need no LLM provider: the post-hoc --file-answer write (kip-app#112) and
// its failure modes. Spawned as a real subprocess so argv parsing, env
// handling and stdout purity are exercised the way the app exercises them.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const CHAT = path.join(__dirname, '..', 'chat.js')

function makeTempVault () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-chat-test-'))
  for (const dir of ['nest/entities', 'nest/concepts', 'nest/sources', 'clucks', '.roost']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  return root
}

function runChat (vaultRoot, args) {
  return execFileSync(process.execPath, [CHAT, ...args], {
    env: { ...process.env, KIP_COOP_ROOT: vaultRoot },
    encoding: 'utf8'
  })
}

test('chat.js --file-answer', async (t) => {
  t.test('files a settled answer as a from-peck concept page and logs nothing', () => {
    const root = makeTempVault()
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))

    const stdout = runChat(root, ['--file-answer', JSON.stringify({
      question: 'What do we know about project falcon?',
      answer: 'Falcon ships in Q4, per [[team-notes]].',
      candidateSlugs: ['team-notes']
    })])
    const result = JSON.parse(stdout.trim().split('\n').pop())
    assert.equal(result.filed, true)
    assert.equal(result.action, 'create')
    assert.equal(result.type, 'concept')

    const raw = fs.readFileSync(path.join(root, result.path), 'utf8')
    assert.ok(raw.includes('**Q:** What do we know about project falcon?'))
    assert.ok(raw.includes('from-peck'))

    const clucksDir = path.join(root, 'clucks')
    const clucks = fs.existsSync(clucksDir)
      ? fs.readdirSync(clucksDir).map((f) => fs.readFileSync(path.join(clucksDir, f), 'utf8')).join('')
      : ''
    assert.ok(!clucks.includes('peck |'), 'log:false — the ask-time turn owns the audit row')
  })

  t.test('a 300-character CJK question files fine with a capped slug', () => {
    const root = makeTempVault()
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))

    const longQuestion = '这是什么意思呢'.repeat(60)
    const stdout = runChat(root, ['--file-answer', JSON.stringify({ question: longQuestion, answer: 'ok' })])
    const result = JSON.parse(stdout.trim().split('\n').pop())
    assert.equal(result.filed, true)
    assert.ok(result.slug.length <= 60, 'slug capped by resolvePage SLUG_MAX')
    assert.ok(fs.existsSync(path.join(root, result.path)))
  })

  t.test('bad JSON / missing fields exit 1 with usage on stderr', () => {
    const root = makeTempVault()
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))

    assert.throws(() => runChat(root, ['--file-answer', '{not json']),
      (err) => err.status === 1 && /Usage/.test(err.stderr))
    assert.throws(() => runChat(root, ['--file-answer', JSON.stringify({ question: 'no answer' })]),
      (err) => err.status === 1 && /Usage/.test(err.stderr))
  })
})
