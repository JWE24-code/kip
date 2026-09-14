import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import git from 'isomorphic-git'
import { Workspace, WorkspaceError, UNDO_UNAVAILABLE } from '../workspace/git.ts'

function TMP (): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kip-workspace-'))
}

function write (dir: string, rel: string, data: string | Buffer): void {
  const full = path.join(dir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, data)
}

function read (dir: string, rel: string): Buffer {
  return fs.readFileSync(path.join(dir, rel))
}

async function rejection (promise: Promise<unknown>): Promise<WorkspaceError> {
  try {
    await promise
  } catch (err) {
    assert.ok(err instanceof WorkspaceError, `expected WorkspaceError, got ${String(err)}`)
    return err
  }
  throw new Error('expected the promise to reject')
}

test('undo restores the exact prior file state, byte for byte', async () => {
  const dir = TMP()
  const workspace = new Workspace(dir)
  try {
    await workspace.init()
    write(dir, 'entities/a.md', 'A v1\n')
    write(dir, 'entities/b.md', 'B v1\n')
    write(dir, 'assets/logo.bin', Buffer.from([0x00, 0xff, 0x10, 0x00, 0x7f]))
    await workspace.commit({ message: 'add a, b, logo', sessionId: 's1', files: ['entities/a.md', 'entities/b.md', 'assets/logo.bin'] })

    const aBefore = read(dir, 'entities/a.md')
    const bBefore = read(dir, 'entities/b.md')
    const logoBefore = read(dir, 'assets/logo.bin')

    // Two more commits: edit a, delete b, add c, then edit c again.
    write(dir, 'entities/a.md', 'A v2 — changed\n')
    fs.rmSync(path.join(dir, 'entities/b.md'))
    write(dir, 'concepts/c.md', 'C v1\n')
    await workspace.commit({ message: 'edit a, delete b, add c', sessionId: 's1' })
    write(dir, 'concepts/c.md', 'C v2\n')
    await workspace.commit({ message: 'edit c', sessionId: 's1' })

    const result = await workspace.undo({ sessionId: 's1', count: 2 })

    assert.deepEqual(read(dir, 'entities/a.md'), aBefore)
    assert.deepEqual(read(dir, 'entities/b.md'), bBefore, 'the deleted file comes back')
    assert.deepEqual(read(dir, 'assets/logo.bin'), logoBefore, 'binary bytes are identical')
    assert.equal(fs.existsSync(path.join(dir, 'concepts/c.md')), false, 'the added file is gone')
    assert.deepEqual(result.restoredFiles, ['concepts/c.md', 'entities/a.md', 'entities/b.md'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('undo.applied data names the revert commit and the restored paths', async () => {
  const dir = TMP()
  const workspace = new Workspace(dir)
  try {
    await workspace.init()
    write(dir, 'entities/a.md', 'one\n')
    await workspace.commit({ message: 'create a', sessionId: 's1' })
    write(dir, 'entities/a.md', 'two\n')
    await workspace.commit({ message: 'edit a', sessionId: 's1' })

    const result = await workspace.undo({ sessionId: 's1', count: 1 })

    assert.equal(await workspace.head(), result.revertedSha, 'revertedSha is the new HEAD')
    const [head] = await workspace.log(1)
    assert.equal(head.oid, result.revertedSha)
    assert.match(head.message, /^undo: revert last 1 commit\(s\)/)
    assert.deepEqual(result.restoredFiles, ['entities/a.md'])
    assert.equal(read(dir, 'entities/a.md').toString(), 'one\n')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('undo refuses to cross into another session\'s commits', async () => {
  const dir = TMP()
  const workspace = new Workspace(dir)
  try {
    await workspace.init()
    write(dir, 'entities/a.md', 'one\n')
    await workspace.commit({ message: 'session one write', sessionId: 's1' })
    write(dir, 'entities/a.md', 'two\n')
    await workspace.commit({ message: 'session two write', sessionId: 's2' })

    const err = await rejection(workspace.undo({ sessionId: 's1', count: 1 }))
    assert.equal(err.code, UNDO_UNAVAILABLE)
    assert.match(err.message, /not written by this session/)
    assert.equal(read(dir, 'entities/a.md').toString(), 'two\n', 'a refused undo changes nothing')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('undo refuses when there is not enough history', async () => {
  const dir = TMP()
  const workspace = new Workspace(dir)
  try {
    await workspace.init()
    write(dir, 'entities/a.md', 'one\n')
    await workspace.commit({ message: 'only commit', sessionId: 's1' })

    const err = await rejection(workspace.undo({ sessionId: 's1', count: 5 }))
    assert.equal(err.code, UNDO_UNAVAILABLE)
    assert.equal(await workspace.head(), (await workspace.log(1))[0].oid, 'HEAD is unchanged')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('undo needs no system git binary on PATH', async () => {
  const dir = TMP()
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-empty-path-'))
  const workspace = new Workspace(dir)
  const originalPath = process.env.PATH
  try {
    await workspace.init()
    write(dir, 'entities/a.md', 'one\n')
    await workspace.commit({ message: 'create a', sessionId: 's1' })
    write(dir, 'entities/a.md', 'two\n')
    await workspace.commit({ message: 'edit a', sessionId: 's1' })

    process.env.PATH = emptyPath
    const result = await workspace.undo({ sessionId: 's1', count: 1 })
    assert.ok(result.revertedSha)
    assert.equal(read(dir, 'entities/a.md').toString(), 'one\n')
  } finally {
    process.env.PATH = originalPath
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(emptyPath, { recursive: true, force: true })
  }
})

test('undo finishes well within 2s on a realistic nest', async () => {
  const dir = TMP()
  const workspace = new Workspace(dir)
  try {
    await workspace.init()
    const files: string[] = []
    for (let i = 0; i < 250; i += 1) {
      const rel = `entities/page-${String(i).padStart(3, '0')}.md`
      files.push(rel)
      write(dir, rel, Buffer.from(`# Page ${i}\n\n${'lorem ipsum dolor sit amet. '.repeat(40)}\n`))
    }
    await workspace.commit({ message: 'seed 250 pages', sessionId: 's1', files })
    for (const rel of files) write(dir, rel, Buffer.from(`# Edited\n\n${rel}\n`))
    await workspace.commit({ message: 'rewrite every page', sessionId: 's1', files })

    const started = Date.now()
    const result = await workspace.undo({ sessionId: 's1', count: 1 })
    const elapsed = Date.now() - started

    assert.equal(result.restoredFiles.length, 250)
    assert.ok(elapsed < 2000, `undo took ${elapsed}ms, expected < 2000ms`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pending changes are all committed when no file list is given', async () => {
  const dir = TMP()
  const workspace = new Workspace(dir)
  try {
    await workspace.init()
    write(dir, 'entities/a.md', 'one\n')
    write(dir, 'concepts/b.md', 'two\n')
    await workspace.commit({ message: 'two pages', sessionId: 's1' })
    const tracked = await git.listFiles({ fs, dir, ref: 'HEAD' })
    assert.deepEqual(tracked.sort(), ['concepts/b.md', 'entities/a.md'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
