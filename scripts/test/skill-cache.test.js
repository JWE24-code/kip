const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runSkill, discoverSkills, setSkillApproval } = require('../lib/skills')
const skillCache = require('../lib/skill-cache')

function makeTempCoop () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-skill-cache-test-'))
  fs.mkdirSync(path.join(root, '.henhouse', 'skills'), { recursive: true })
  fs.mkdirSync(path.join(root, 'pages'), { recursive: true })
  return root
}

/** Writes a user skill; run.js appends one 'x' to <coop>/count.txt so a test
 *  can assert how many times the child actually ran. */
function writeSkill (root, name, { frontmatter = {}, run, approve = true } = {}) {
  const dir = path.join(root, '.henhouse', 'skills', name)
  fs.mkdirSync(dir, { recursive: true })
  const fm = Object.assign({ name, description: `test skill ${name}`, entry: 'run.js' }, frontmatter)
  const yaml = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${yaml}\n---\n`)
  fs.writeFileSync(path.join(dir, 'run.js'), run || 'console.log("ok")')
  if (approve) setSkillApproval(root, name, 'always')
  return dir
}

function invocations (root) {
  try { return fs.readFileSync(path.join(root, 'count.txt'), 'utf8') } catch { return '' }
}

// ---------------------------------------------------------------------------
// skill-cache module (keying, secret detection, TTL)
// ---------------------------------------------------------------------------

test('skill-cache: key is order-insensitive and value-sensitive', () => {
  const a = skillCache.keyFor('web-search', { query: 'cats', count: 5 })
  const b = skillCache.keyFor('web-search', { count: 5, query: 'cats' })
  const c = skillCache.keyFor('web-search', { query: 'dogs', count: 5 })
  const d = skillCache.keyFor('other', { query: 'cats', count: 5 })
  assert.equal(a, b, 'same input in a different key order hashes the same')
  assert.notEqual(a, c, 'different value hashes differently')
  assert.notEqual(a, d, 'different skill hashes differently')
})

test('skill-cache: hasSecretish flags secret-ish keys, nested too', () => {
  assert.equal(skillCache.hasSecretish({ query: 'x', count: 1 }), false)
  assert.equal(skillCache.hasSecretish({ query: 'x', apiKey: 'sk' }), true)
  assert.equal(skillCache.hasSecretish({ query: 'x', BRAVE_TOKEN: 't' }), true)
  assert.equal(skillCache.hasSecretish({ items: [{ key: 'a' }] }), true)
  assert.equal(skillCache.hasSecretish('plain string'), false)
})

test('skill-cache: get/put round-trips, expires after the TTL, and stores no input', (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const skill = { name: 'lookup' }
  skillCache.put(skill, { query: 'cats' }, { ok: true, output: 'results', error: null }, { ttl: 60_000, vaultRoot: root, now: 1000 })

  // fresh hit
  const hit = skillCache.get(skill, { query: 'cats' }, { ttl: 60_000, vaultRoot: root, now: 1000 + 59_999 })
  assert.ok(hit, 'fresh entry is a hit')
  assert.equal(hit.ok, true)
  assert.equal(hit.output, 'results')

  // expired
  assert.equal(skillCache.get(skill, { query: 'cats' }, { ttl: 60_000, vaultRoot: root, now: 1000 + 60_000 }), null)

  // the on-disk file holds output, never the raw input
  const raw = fs.readFileSync(path.join(root, '.roost', 'peck-skill-cache.json'), 'utf8')
  assert.equal(raw.includes('"cats"'), false, 'input is never persisted')
  assert.equal(raw.includes('results'), true)
})

test('skill-cache: caps entries at MAX_ENTRIES, dropping the oldest first', (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const skill = { name: 'lookup' }
  for (let i = 0; i < skillCache.MAX_ENTRIES + 10; i++) {
    skillCache.put(skill, { query: `q${i}` }, { ok: true, output: `o${i}` }, { ttl: 60_000, vaultRoot: root, now: 1000 + i })
  }
  const raw = JSON.parse(fs.readFileSync(path.join(root, '.roost', 'peck-skill-cache.json'), 'utf8'))
  assert.ok(Object.keys(raw.entries).length <= skillCache.MAX_ENTRIES, 'entry count is capped')
  // the very first (oldest) was evicted; the latest survived
  assert.ok(!Object.values(raw.entries).some((e) => e.output === 'o0'), 'oldest entry evicted')
  assert.ok(Object.values(raw.entries).some((e) => e.output === `o${skillCache.MAX_ENTRIES + 9}`), 'newest entry kept')
})

// ---------------------------------------------------------------------------
// runSkill integration
// ---------------------------------------------------------------------------

test('runSkill: cache_ttl returns a cached result without re-running the child', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeSkill(root, 'lookup', {
    frontmatter: { cache_ttl: 60 },
    run: 'require("fs").appendFileSync(process.env.KIP_COOP_ROOT + "/count.txt", "x"); console.log("cached-me")'
  })
  const skill = discoverSkills(root).find((s) => s.name === 'lookup')

  const first = await runSkill(skill, { query: 'cats' }, root)
  assert.equal(first.ok, true)
  assert.equal(first.cached, undefined)

  const second = await runSkill(skill, { query: 'cats' }, root)
  assert.equal(second.ok, true)
  assert.equal(second.cached, true, 'second identical call is served from cache')
  assert.equal(second.output, 'cached-me')
  assert.equal(second.ms, 0)

  assert.equal(invocations(root), 'x', 'the child ran exactly once')

  // a different input is a miss and runs again
  const third = await runSkill(skill, { query: 'dogs' }, root)
  assert.equal(third.cached, undefined)
  assert.equal(invocations(root), 'xx')
})

test('runSkill: a skill without cache_ttl is never cached', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeSkill(root, 'plain', { run: 'require("fs").appendFileSync(process.env.KIP_COOP_ROOT + "/count.txt", "x"); console.log("ok")' })
  const skill = discoverSkills(root).find((s) => s.name === 'plain')

  await runSkill(skill, { q: 1 }, root)
  await runSkill(skill, { q: 1 }, root)
  assert.equal(invocations(root), 'xx', 'both calls ran the child')
})

test('runSkill: input with a secret-ish value is never cached', async (t) => {
  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeSkill(root, 'secy', {
    frontmatter: { cache_ttl: 60 },
    run: 'require("fs").appendFileSync(process.env.KIP_COOP_ROOT + "/count.txt", "x"); console.log("ok")'
  })
  const skill = discoverSkills(root).find((s) => s.name === 'secy')

  await runSkill(skill, { query: 'x', apiKey: 'sk-secret' }, root)
  await runSkill(skill, { query: 'x', apiKey: 'sk-secret' }, root)
  assert.equal(invocations(root), 'xx', 'secret-ish inputs bypass the cache')
})

test('runSkill: KIP_SKILL_CACHE=0 disables caching entirely', async (t) => {
  const prev = process.env.KIP_SKILL_CACHE
  process.env.KIP_SKILL_CACHE = '0'
  t.after(() => { if (prev === undefined) delete process.env.KIP_SKILL_CACHE; else process.env.KIP_SKILL_CACHE = prev })

  const root = makeTempCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeSkill(root, 'lookup', {
    frontmatter: { cache_ttl: 60 },
    run: 'require("fs").appendFileSync(process.env.KIP_COOP_ROOT + "/count.txt", "x"); console.log("ok")'
  })
  const skill = discoverSkills(root).find((s) => s.name === 'lookup')

  await runSkill(skill, { query: 'cats' }, root)
  const second = await runSkill(skill, { query: 'cats' }, root)
  assert.equal(second.cached, undefined)
  assert.equal(invocations(root), 'xx', 'cache disabled → both calls ran')
})
