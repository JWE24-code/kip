// Unit tests for the capability manifest (P6, kip#77): the frontmatter shape is
// unchanged, but network/mounts/limits/hostcalls now normalize into the exact
// vocabulary the executor enforces. Includes the traversal-safe mount resolver
// and the hostcall allowlist — the two "declared capability" boundaries.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_LIMITS,
  HOSTCALL_NAMES,
  KNOWN_HOSTCALLS,
  LIMIT_CAPS,
  MountEscapeError,
  createRunMounts,
  discoverSkills,
  hostAllowed,
  isInside,
  loadSkillPolicy,
  materializeSnapshot,
  parseLimits,
  parseManifestData,
  parseMemMb,
  parseMounts,
  parseNetwork,
  parseOutputBytes,
  parseWallMs,
  readSkillManifest,
  resolveMountPath
} from '../henhouse/index.ts'

function makeCoop (): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'henhouse-unit-'))
  for (const dir of ['pages', 'nest', 'exports', '.henhouse/skills']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  return root
}

function writeSkill (
  root: string,
  name: string,
  { frontmatter = {}, body = '', run = 'process.exit(0)', dir = root }: {
    frontmatter?: Record<string, unknown>
    body?: string
    run?: string
    dir?: string
  } = {}
): string {
  const skillDir = path.join(dir, name)
  fs.mkdirSync(skillDir, { recursive: true })
  const fm = Object.assign({ name, description: `test skill ${name}`, entry: 'run.js' }, frontmatter)
  const yaml = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${yaml}\n---\n${body}\n`)
  fs.writeFileSync(path.join(skillDir, 'run.js'), run)
  return skillDir
}

// ---- normalizers -----------------------------------------------------------

test('parseNetwork: fail-closed defaults, all, and host allowlists', () => {
  assert.deepEqual(parseNetwork(undefined), { mode: 'none', hosts: [] })
  assert.deepEqual(parseNetwork(false), { mode: 'none', hosts: [] })
  assert.deepEqual(parseNetwork('none'), { mode: 'none', hosts: [] })
  assert.deepEqual(parseNetwork(true), { mode: 'all', hosts: [] })
  assert.deepEqual(parseNetwork('all'), { mode: 'all', hosts: [] })
  assert.deepEqual(parseNetwork(['api.example.com', ' *.foo.dev ']), { mode: 'hosts', hosts: ['api.example.com', '*.foo.dev'] })
  assert.deepEqual(parseNetwork({ hosts: ['a.test'] }), { mode: 'hosts', hosts: ['a.test'] })
  assert.deepEqual(parseNetwork({ allow: true }), { mode: 'all', hosts: [] })
  assert.deepEqual(parseNetwork({ nonsense: 1 }), { mode: 'none', hosts: [] })
})

test('parseWallMs / parseMemMb / parseOutputBytes: units and caps', () => {
  assert.equal(parseWallMs(60), 60_000)          // bare number = seconds (old `timeout`)
  assert.equal(parseWallMs('500ms'), 500)
  assert.equal(parseWallMs('2m'), 120_000)
  assert.equal(parseWallMs(9999), LIMIT_CAPS.wallMs)
  assert.equal(parseWallMs('junk'), null)

  assert.equal(parseMemMb(128), 128)
  assert.equal(parseMemMb('1gb'), LIMIT_CAPS.memMb)
  assert.equal(parseMemMb('64mb'), 64)
  assert.equal(parseMemMb(1), 8)                 // floor
  assert.equal(parseMemMb('nope'), null)

  assert.equal(parseOutputBytes(65536), 65_536)
  assert.equal(parseOutputBytes('1kb'), 1024)
  assert.equal(parseOutputBytes(1), 256)         // floor
  assert.equal(parseOutputBytes(10 * 1024 * 1024), LIMIT_CAPS.outputBytes)
  assert.equal(parseOutputBytes('nope'), null)
})

test('parseLimits: falls back to top-level timeout, clamps everything else', () => {
  assert.deepEqual(parseLimits({}), DEFAULT_LIMITS)
  assert.deepEqual(parseLimits({ timeout: 30 }), { ...DEFAULT_LIMITS, wallMs: 30_000 })
  assert.deepEqual(
    parseLimits({ limits: { wall: '500ms', mem: '64mb', output: '1kb' } }),
    { wallMs: 500, memMb: 64, outputBytes: 1024 }
  )
})

test('parseMounts: only input/exports exist; input is always read-only', () => {
  assert.deepEqual(parseMounts(undefined), [{ name: 'input', mode: 'ro' }, { name: 'exports', mode: 'rw' }])
  assert.deepEqual(parseMounts(['exports']), [{ name: 'exports', mode: 'rw' }])
  assert.deepEqual(parseMounts([{ name: 'input', mode: 'rw' }]), [{ name: 'input', mode: 'ro' }])
  assert.deepEqual(parseMounts(['/etc', 'host-vault']), [{ name: 'input', mode: 'ro' }, { name: 'exports', mode: 'rw' }])
})

// ---- manifest reader -------------------------------------------------------

test('parseManifestData: keeps the SKILL.md shape and normalizes capabilities', (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = writeSkill(root, 'cap', {
    frontmatter: {
      network: { hosts: ['api.example.com'] },
      mounts: ['input', 'exports'],
      hostcalls: ['fetch_url'],
      limits: { wall: 5, mem: 32, output: 2048 },
      cache_ttl: 30
    },
    body: 'instructions here'
  })
  const manifest = readSkillManifest(dir, 'builtin')
  assert.ok(manifest)
  assert.equal(manifest.name, 'cap')
  assert.equal(manifest.description, 'test skill cap')
  assert.deepEqual(manifest.network, { mode: 'hosts', hosts: ['api.example.com'] })
  assert.deepEqual(manifest.mounts, [{ name: 'input', mode: 'ro' }, { name: 'exports', mode: 'rw' }])
  assert.deepEqual(manifest.hostcalls, ['fetch_url'])
  assert.deepEqual(manifest.limits, { wallMs: 5000, memMb: 32, outputBytes: 2048 })
  assert.equal(manifest.cacheTtlMs, 30_000)
  assert.equal(manifest.instructions, 'instructions here')
})

test('manifest: missing name/description/entry are refused with a warning', (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const noName = writeSkill(root, 'no-name', { frontmatter: { name: '' } })
  assert.equal(readSkillManifest(noName, 'user'), null)

  const noDescription = writeSkill(root, 'no-desc', { frontmatter: { description: '' } })
  assert.equal(readSkillManifest(noDescription, 'user'), null)

  const noEntryDir = path.join(root, 'missing-entry')
  fs.mkdirSync(noEntryDir)
  fs.writeFileSync(path.join(noEntryDir, 'SKILL.md'), '---\nname: missing-entry\ndescription: x\nentry: gone.js\n---\n')
  assert.equal(readSkillManifest(noEntryDir, 'user'), null)

  const parsed = parseManifestData({ name: 'Bad Name', description: 'x' }, '', root, 'user')
  assert.equal(parsed.manifest, null)
  assert.match(parsed.warnings.join(' '), /invalid "name"/)
})

test('manifest: an unknown hostcall is kept but warned about', (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = writeSkill(root, 'odd', { frontmatter: { hostcalls: ['fetch_url', 'make_coffee'] } })
  const parsed = parseManifestData(
    { name: 'odd', description: 'x', hostcalls: ['fetch_url', 'make_coffee'] },
    '',
    dir,
    'builtin'
  )
  assert.deepEqual(parsed.manifest?.hostcalls, ['fetch_url', 'make_coffee'])
  assert.match(parsed.warnings.join(' '), /unknown hostcall "make_coffee"/)
})

// ---- discovery + policy ----------------------------------------------------

test('discoverSkills: built-ins, user overrides, disabled + approval gating', (t) => {
  const root = makeCoop()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const builtinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'henhouse-builtin-'))
  t.after(() => fs.rmSync(builtinDir, { recursive: true, force: true }))
  const userDir = path.join(root, '.henhouse', 'skills')

  writeSkill(builtinDir, 'alpha', { frontmatter: { description: 'builtin alpha' }, dir: builtinDir })
  writeSkill(root, 'alpha', { frontmatter: { description: 'user alpha' }, dir: userDir })
  writeSkill(root, 'beta', { dir: userDir })

  let skills = discoverSkills({ vaultRoot: root, builtinDir, includeDisabled: true })
  const alpha = skills.find((s) => s.name === 'alpha')
  assert.equal(alpha?.source, 'user', 'user skill overrides the built-in')
  assert.equal(alpha?.description, 'user alpha')
  assert.equal(alpha?.approval, 'pending')
  assert.ok(skills.some((s) => s.name === 'beta'))

  skills = discoverSkills({ vaultRoot: root, builtinDir })
  assert.ok(!skills.some((s) => s.name === 'alpha'), 'unapproved user skill is not offered')
  assert.ok(!skills.some((s) => s.name === 'beta'), 'unapproved user skill is not offered')

  fs.writeFileSync(path.join(root, '.henhouse', 'skills.json'), JSON.stringify({ disabled: ['beta'], approved: { alpha: 'always' } }))
  skills = discoverSkills({ vaultRoot: root, builtinDir })
  assert.ok(skills.some((s) => s.name === 'alpha'))
  assert.ok(!skills.some((s) => s.name === 'beta'))
  assert.deepEqual(loadSkillPolicy(root).disabled, ['beta'])
})

// ---- mount safety ----------------------------------------------------------

test('resolveMountPath: refuses `..`, absolute paths, and NUL; allows nesting', () => {
  const mounts = createRunMounts(path.join(os.tmpdir(), 'henhouse-mounts'))
  assert.equal(resolveMountPath(mounts, 'input', 'notes/a.md'), path.join(mounts.input, 'notes/a.md'))
  assert.equal(resolveMountPath(mounts, 'exports', 'deck.pptx'), path.join(mounts.exports, 'deck.pptx'))

  for (const bad of ['../secret.md', '../../etc/passwd', '/etc/passwd', 'a/../../b', '..', 'nul\0byte', 'C:\\Windows']) {
    assert.throws(() => resolveMountPath(mounts, 'input', bad), MountEscapeError, `expected "${bad}" to be refused`)
  }
  assert.throws(() => resolveMountPath(mounts, 'exports', '../outside'), MountEscapeError)
})

test('materializeSnapshot writes into input and refuses an escaping key', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'henhouse-snap-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const mounts = createRunMounts(path.join(root, 'run'))

  const written = await materializeSnapshot(mounts, {
    'note.md': '# note\n',
    'sub/other.txt': 'other'
  })
  assert.deepEqual(written, ['note.md', 'sub/other.txt'])
  assert.equal(fs.readFileSync(path.join(mounts.input, 'note.md'), 'utf8'), '# note\n')

  await assert.rejects(
    materializeSnapshot(mounts, { '../escape.md': 'x' }),
    MountEscapeError
  )
})

test('isInside: containment is path-segment aware', () => {
  assert.equal(isInside('/a/b', '/a/b/c'), true)
  assert.equal(isInside('/a/b', '/a/b'), true)
  assert.equal(isInside('/a/b', '/a/bc'), false)
  assert.equal(isInside('/a/b', '/a'), false)
})

// ---- hostcall allowlist ----------------------------------------------------

test('hostAllowed: none/none, all/all, exact and wildcard hosts', () => {
  assert.equal(hostAllowed({ mode: 'none', hosts: [] }, 'example.com'), false)
  assert.equal(hostAllowed({ mode: 'all', hosts: [] }, 'anything.test'), true)
  assert.equal(hostAllowed({ mode: 'hosts', hosts: ['Example.com'] }, 'example.com'), true)
  assert.equal(hostAllowed({ mode: 'hosts', hosts: ['*.example.com'] }, 'api.example.com'), true)
  assert.equal(hostAllowed({ mode: 'hosts', hosts: ['*.example.com'] }, 'example.com'), true)
  assert.equal(hostAllowed({ mode: 'hosts', hosts: ['*.example.com'] }, 'evil-example.com'), false)
})

test('the manifest vocabulary and the hostcall registry stay in sync', () => {
  assert.deepEqual([...KNOWN_HOSTCALLS].sort(), Object.values(HOSTCALL_NAMES).sort())
})

