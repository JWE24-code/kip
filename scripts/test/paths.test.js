const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Database = require('better-sqlite3')

const { dbPath, roostPath, workspaceRoot, coopKey, detectSyncFolder, warnIfSynced } = require('../lib/paths')
const { openDb, migrateLegacyDb } = require('../lib/db')

function tmp (prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function withEnv (key, value, fn) {
  const prev = process.env[key]
  process.env[key] = value
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
}

test('dbPath lives under <workspace>/roost, never inside the coop (kip#67)', () => {
  const coop = tmp('coop-paths-')
  try {
    const db = dbPath(coop)
    assert.equal(db, path.join(roostPath(coop), 'meta.db'))
    assert.ok(db.startsWith(workspaceRoot(coop) + path.sep), 'index resolves under the workspace root')
    assert.ok(!db.startsWith(path.resolve(coop) + path.sep), 'index must never sit inside KIP_COOP_ROOT')
  } finally {
    fs.rmSync(coop, { recursive: true, force: true })
  }
})

test('two coops get two distinct workspaces — no index cross-contamination', () => {
  const a = tmp('coop-det-a-')
  const b = tmp('coop-det-b-')
  try {
    assert.notEqual(coopKey(a), coopKey(b))
    assert.notEqual(dbPath(a), dbPath(b))
  } finally {
    fs.rmSync(a, { recursive: true, force: true })
    fs.rmSync(b, { recursive: true, force: true })
  }
})

test('KIP_WORKSPACE_ROOT overrides the base the per-coop workspace derives from', () => {
  const coop = tmp('coop-env-')
  const base = tmp('kip-ws-')
  try {
    const expected = path.join(base, 'coops', coopKey(coop), 'roost', 'meta.db')
    withEnv('KIP_WORKSPACE_ROOT', base, () => {
      assert.equal(dbPath(coop), expected)
    })
  } finally {
    fs.rmSync(coop, { recursive: true, force: true })
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('openDb puts meta.db + its WAL sidecar in the workspace, not the coop', () => {
  const coop = tmp('coop-wal-')
  try {
    const db = openDb(coop)
    try {
      db.prepare('INSERT INTO log (timestamp, kind, title, pages_touched) VALUES (?, ?, ?, ?)')
        .run('2026-01-01T00:00:00.000Z', 'test', 'wal check', '[]')
      assert.ok(fs.existsSync(dbPath(coop)), 'index written to the workspace')
      assert.ok(fs.existsSync(dbPath(coop) + '-wal'), 'WAL sidecar written beside it')
    } finally {
      db.close()
    }
    assert.ok(!fs.existsSync(path.join(coop, '.roost', 'meta.db')), 'nothing left in the coop')
  } finally {
    fs.rmSync(coop, { recursive: true, force: true })
  }
})

test('openDb migrates a legacy in-coop index into the workspace, preserving rows', () => {
  const coop = tmp('coop-migrate-')
  try {
    const legacy = path.join(coop, '.roost', 'meta.db')
    fs.mkdirSync(path.dirname(legacy), { recursive: true })
    const old = new Database(legacy)
    old.exec(`CREATE TABLE pages (
      slug TEXT PRIMARY KEY, path TEXT NOT NULL, type TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '',
      created TEXT NOT NULL, updated TEXT NOT NULL
    )`)
    old.prepare('INSERT INTO pages VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('keep-me', 'nest/concepts/keep-me.md', 'concept', '[]', 'kept summary', 't', 't')
    old.close()

    const db = openDb(coop)
    try {
      const row = db.prepare('SELECT slug, summary FROM pages WHERE slug = ?').get('keep-me')
      assert.ok(row, 'the existing row survives the move')
      assert.equal(row.summary, 'kept summary')
    } finally {
      db.close()
    }

    assert.ok(fs.existsSync(dbPath(coop)), 'index now lives in the workspace')
    assert.ok(!fs.existsSync(legacy), 'legacy index removed — never leave two databases')
  } finally {
    fs.rmSync(coop, { recursive: true, force: true })
  }
})

test('migrateLegacyDb carries the -wal and -shm files across with the db', () => {
  const coop = tmp('coop-sidecars-')
  try {
    const legacy = path.join(coop, '.roost', 'meta.db')
    fs.mkdirSync(path.dirname(legacy), { recursive: true })
    fs.writeFileSync(legacy, 'db')
    fs.writeFileSync(legacy + '-wal', 'wal')
    fs.writeFileSync(legacy + '-shm', 'shm')

    const dest = dbPath(coop)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    migrateLegacyDb(coop, dest)

    assert.equal(fs.readFileSync(dest, 'utf8'), 'db')
    assert.equal(fs.readFileSync(dest + '-wal', 'utf8'), 'wal')
    assert.equal(fs.readFileSync(dest + '-shm', 'utf8'), 'shm')
    assert.ok(!fs.existsSync(legacy), 'legacy files gone')
  } finally {
    fs.rmSync(coop, { recursive: true, force: true })
  }
})

test('a stale in-coop index is dropped when a workspace index already exists', () => {
  const coop = tmp('coop-stale-')
  try {
    const dest = dbPath(coop)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, 'current')

    const legacy = path.join(coop, '.roost', 'meta.db')
    fs.mkdirSync(path.dirname(legacy), { recursive: true })
    fs.writeFileSync(legacy, 'stale')

    migrateLegacyDb(coop, dest)
    assert.equal(fs.readFileSync(dest, 'utf8'), 'current', 'the workspace index wins')
    assert.ok(!fs.existsSync(legacy), 'the duplicate is removed')
  } finally {
    fs.rmSync(coop, { recursive: true, force: true })
  }
})

test('detectSyncFolder flags known sync engines on a whole path segment', () => {
  assert.equal(detectSyncFolder('/home/u/Dropbox/notes/coop'), 'Dropbox')
  assert.equal(detectSyncFolder('/home/u/Dropbox (Personal)/coop'), 'Dropbox')
  assert.equal(detectSyncFolder('/home/u/OneDrive - Acme/coop'), 'OneDrive')
  assert.equal(detectSyncFolder('/Users/u/Library/Mobile Documents/com~apple~CloudDocs/coop'), 'iCloud Drive')
  assert.equal(detectSyncFolder('/Users/u/Google Drive/coop'), 'Google Drive')
  assert.equal(detectSyncFolder('/home/u/Projects/coop'), null)
  assert.equal(detectSyncFolder('/home/u/dropbox-notes-export/coop'), null, 'no false positives on similar names')
})

test('warnIfSynced logs once to stderr and returns the engine, without throwing', () => {
  const coop = path.join(tmp('coop-synced-'), 'Dropbox', 'coop')
  fs.mkdirSync(coop, { recursive: true })
  const calls = []
  const original = console.error
  console.error = (...args) => calls.push(args.join(' '))
  try {
    assert.equal(warnIfSynced(coop), 'Dropbox')
    assert.equal(warnIfSynced(coop), 'Dropbox', 'still reports the engine')
    assert.equal(calls.length, 1, 'but warns only once per coop root')
    assert.match(calls[0], /Dropbox/)
  } finally {
    console.error = original
    fs.rmSync(path.dirname(path.dirname(coop)), { recursive: true, force: true })
  }
})
