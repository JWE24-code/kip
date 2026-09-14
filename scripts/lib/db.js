const fs = require('node:fs')
const path = require('node:path')
const Database = require('better-sqlite3')
const { dbPath, DEFAULT_VAULT_ROOT, warnIfSynced } = require('./paths')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  slug    TEXT PRIMARY KEY,
  path    TEXT NOT NULL,
  type    TEXT NOT NULL,
  tags    TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  slug,
  body
);

-- The per-section index (kip-app#106 — index granularity below the page
-- level). Derived from each page's body by a deterministic heading split; the
-- 'summary' column is a one-line first-line extract, refined by hatch/groom
-- later.
CREATE TABLE IF NOT EXISTS sections (
  slug    TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  heading TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (slug, seq)
);

CREATE TABLE IF NOT EXISTS log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp     TEXT NOT NULL,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  pages_touched TEXT NOT NULL DEFAULT '[]'
);

-- Tracks which source files (pages/, journals/) have been hatched and
-- at what content, so "Hatch sources" can re-hatch only what's new or
-- changed. path is coop-relative, forward-slashed ("journals/2026_08_26.md").
CREATE TABLE IF NOT EXISTS hatched_sources (
  path    TEXT PRIMARY KEY,
  hash    TEXT NOT NULL,
  hatched TEXT NOT NULL
);
`

// The SQLite sidecars that travel with meta.db.
const DB_SIDECARS = ['', '-wal', '-shm']

/**
 * One-time migration off the old in-coop index (kip#67): if a `.roost/meta.db`
 * exists inside the coop, move it (and its -wal/-shm) to the workspace before
 * the new db is created, so exactly one database exists. When a healthy index
 * already lives in the workspace, a leftover legacy file is a stale duplicate
 * and is dropped rather than left to drift.
 */
function migrateLegacyDb (vaultRoot, destFile) {
  const legacy = path.join(path.resolve(vaultRoot), '.roost', 'meta.db')
  if (path.resolve(legacy) === path.resolve(destFile)) return
  if (!fs.existsSync(legacy)) return

  if (fs.existsSync(destFile)) {
    for (const ext of DB_SIDECARS) fs.rmSync(legacy + ext, { force: true })
    console.error(`Warning: removed the stale legacy index at ${legacy}; using ${destFile}.`)
    return
  }

  let moved = 0
  for (const ext of DB_SIDECARS) {
    const src = legacy + ext
    if (!fs.existsSync(src)) continue
    const dest = destFile + ext
    try {
      fs.renameSync(src, dest)
    } catch (err) {
      // A coop under a symlink/mount can be a different filesystem than the
      // state dir; rename across devices fails with EXDEV, so copy + unlink.
      if (err.code !== 'EXDEV') throw err
      fs.copyFileSync(src, dest)
      fs.rmSync(src, { force: true })
    }
    moved++
  }
  if (moved) {
    console.error(`Warning: moved the roost index out of the coop: ${legacy} -> ${destFile}.`)
  }
}

/** Opens (creating if needed) the meta.db for a coop and ensures the schema exists. */
function openDb (vaultRoot = DEFAULT_VAULT_ROOT) {
  const file = dbPath(vaultRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  migrateLegacyDb(vaultRoot, file)
  warnIfSynced(vaultRoot)
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  return db
}

module.exports = { openDb, migrateLegacyDb }
