// Acceptance tests for undo (P4, kip#74): restoring the exact prior file
// state, reporting the revert commit and the restored paths, refusing when it
// cannot honour the request, and staying inside NFR-4's 2s on a realistic
// nest — all with no system `git` binary anywhere in the path.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  UndoUnavailableError,
  commitAction,
  history,
  undo,
  type WorkspacePaths
} from '../workspace/git.ts'

interface Fixture extends WorkspacePaths {
  root: string
}

function makeFixture (): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-undo-'))
  return { root, dir: path.join(root, 'nest'), gitdir: path.join(root, 'nest.git') }
}

function write (dir: string, rel: string, data: string | Buffer): void {
  const full = path.join(dir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, data)
}

async function rejection (promise: Promise<unknown>): Promise<UndoUnavailableError> {
  try {
    await promise
  } catch (err) {
    assert.ok(err instanceof UndoUnavailableError, `expected UndoUnavailableError, got ${String(err)}`)
    return err
  }
  throw new Error('expected the promise to reject')
}

test('undo restores the exact prior file state, byte for byte', async (t) => {
  const { root, dir, gitdir } = makeFixture()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  write(dir, 'entities/a.md', 'A v1\n')
  write(dir, 'entities/b.md', 'B v1\n')
  write(dir, 'assets/logo.bin', Buffer.from([0x00, 0xff, 0x10, 0x00, 0x7f]))
  await commitAction({ vaultRoot: root, dir, gitdir, message: 'add a, b, logo' })

  const aBefore = fs.readFileSync(path.join(dir, 'entities/a.md'))
  const bBefore = fs.readFileSync(path.join(dir, 'entities/b.md'))
  const logoBefore = fs.readFileSync(path.join(dir, 'assets/logo.bin'))

  // Two more commits: edit a, delete b, add c, then edit c again.
  write(dir, 'entities/a.md', 'A v2 — changed content\n')
  fs.rmSync(path.join(dir, 'entities/b.md'))
  write(dir, 'concepts/c.md', 'C v1\n')
  await commitAction({ vaultRoot: root, dir, gitdir, message: 'edit a, delete b, add c' })
  write(dir, 'concepts/c.md', 'C v2 — even longer content\n')
  await commitAction({ vaultRoot: root, dir, gitdir, message: 'edit c' })

  const result = await undo({ dir, gitdir }, { count: 2 })

  assert.deepEqual(fs.readFileSync(path.join(dir, 'entities/a.md')), aBefore)
  assert.deepEqual(fs.readFileSync(path.join(dir, 'entities/b.md')), bBefore, 'the deleted file comes back')
  assert.deepEqual(fs.readFileSync(path.join(dir, 'assets/logo.bin')), logoBefore, 'binary bytes are identical')
  assert.equal(fs.existsSync(path.join(dir, 'concepts/c.md')), false, 'the added file is gone')
  assert.deepEqual(result.restoredFiles, ['concepts/c.md', 'entities/a.md', 'entities/b.md'])
})

test('undo reports the revert commit sha and the restored paths', async (t) => {
  const { root, dir, gitdir } = makeFixture()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  write(dir, 'entities/a.md', 'one\n')
  await commitAction({ vaultRoot: root, dir, gitdir, message: 'create a' })
  write(dir, 'entities/a.md', 'two — changed\n')
  await commitAction({ vaultRoot: root, dir, gitdir, message: 'edit a' })

  const result = await undo({ dir, gitdir }, { count: 1 })

  const [head] = await history({ dir, gitdir }, { depth: 1 })
  assert.equal(head.sha, result.revertedSha, 'revertedSha is the new HEAD')
  assert.match(head.message, /^undo: revert last 1 commit\(s\)/)
  assert.deepEqual(result.restoredFiles, ['entities/a.md'])
  assert.equal(fs.readFileSync(path.join(dir, 'entities/a.md'), 'utf8'), 'one\n')
})

test('undo refuses when there is not enough history', async (t) => {
  const { root, dir, gitdir } = makeFixture()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  write(dir, 'entities/a.md', 'one\n')
  await commitAction({ vaultRoot: root, dir, gitdir, message: 'only commit' })

  const err = await rejection(undo({ dir, gitdir }, { count: 5 }))
  assert.match(err.message, /only 1 in history/)
  const [head] = await history({ dir, gitdir }, { depth: 1 })
  assert.equal(fs.readFileSync(path.join(dir, 'entities/a.md'), 'utf8'), 'one\n')
  assert.ok(head.sha)
})

test('undo can revert the very first agent write back to an empty nest', async (t) => {
  const { root, dir, gitdir } = makeFixture()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  write(dir, 'entities/only.md', 'the first thing the agent wrote\n')
  await commitAction({ vaultRoot: root, dir, gitdir, message: 'first write' })

  const result = await undo({ dir, gitdir }, { count: 1 })

  assert.equal(fs.existsSync(path.join(dir, 'entities/only.md')), false)
  assert.deepEqual(result.restoredFiles, ['entities/only.md'])
  assert.equal((await history({ dir, gitdir })).length, 2, 'the undo is itself a commit')
})

test('undo on a workspace that is not a repo is UNDO_UNAVAILABLE', async (t) => {
  const { root, dir, gitdir } = makeFixture()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const err = await rejection(undo({ dir, gitdir }, { count: 1 }))
  assert.equal(err.code, 'UNDO_UNAVAILABLE')
})

test('undo needs no system git binary on PATH', async (t) => {
  const { root, dir, gitdir } = makeFixture()
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-empty-path-'))
  const originalPath = process.env.PATH
  t.after(() => {
    process.env.PATH = originalPath
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(emptyPath, { recursive: true, force: true })
  })

  write(dir, 'entities/a.md', 'one\n')
  await commitAction({ vaultRoot: root, dir, gitdir, message: 'create a' })
  write(dir, 'entities/a.md', 'two — changed\n')
  await commitAction({ vaultRoot: root, dir, gitdir, message: 'edit a' })

  process.env.PATH = emptyPath
  const result = await undo({ dir, gitdir }, { count: 1 })
  assert.ok(result.revertedSha)
  assert.equal(fs.readFileSync(path.join(dir, 'entities/a.md'), 'utf8'), 'one\n')
})

test('undo finishes well within 2s on a realistic nest', async (t) => {
  const { root, dir, gitdir } = makeFixture()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const files: string[] = []
  for (let i = 0; i < 250; i += 1) {
    const rel = `entities/page-${String(i).padStart(3, '0')}.md`
    files.push(rel)
    write(dir, rel, Buffer.from(`# Page ${i}\n\n${'lorem ipsum dolor sit amet. '.repeat(40)}\n`))
  }
  await commitAction({ vaultRoot: root, dir, gitdir, message: 'seed 250 pages' })
  for (const rel of files) write(dir, rel, Buffer.from(`# Edited ${rel}\n\n${'changed '.repeat(48)}\n`))
  await commitAction({ vaultRoot: root, dir, gitdir, message: 'rewrite every page' })

  const started = Date.now()
  const result = await undo({ dir, gitdir }, { count: 1 })
  const elapsed = Date.now() - started

  assert.equal(result.restoredFiles.length, 250)
  assert.ok(elapsed < 2000, `undo took ${elapsed}ms, expected < 2000ms`)
})
