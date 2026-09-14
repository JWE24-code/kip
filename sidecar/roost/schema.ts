// The roost schema and its workspace location — a direct port of the schema
// in `scripts/lib/db.js` (kip#70, P2). The tables are unchanged: pages,
// pages_fts (FTS5), sections, log, hatched_sources. The index itself already
// lives outside the synced coop (kip#67): `paths.dbPath()` resolves to
// `<workspace>/coops/<coop-key>/roost/meta.db`, never `.roost/` inside the
// coop.
//
// The writer worker owns the only write connection and opens through
// `openWriterConnection`; readers open their own WAL connection (reader.ts).
// One schema string, so both always agree on the shape.

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, renameSync, rmSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const paths = require('../../scripts/lib/paths.js') as {
  DEFAULT_VAULT_ROOT: string
  dbPath: (vaultRoot?: string) => string
  warnIfSynced: (vaultRoot?: string) => string | null
}

const Database = require('better-sqlite3') as new (
  file: string,
  options?: { readonly?: boolean, fileMustExist?: boolean }
) => DatabaseConnection

export const DEFAULT_VAULT_ROOT: string = paths.DEFAULT_VAULT_ROOT

export const SCHEMA = `
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

export interface PreparedStatement {
  run: (...params: unknown[]) => { changes: number, lastInsertRowid: number | bigint }
  get: (...params: unknown[]) => unknown
  all: (...params: unknown[]) => unknown[]
}

export interface DatabaseConnection {
  prepare: (sql: string) => PreparedStatement
  exec: (sql: string) => void
  pragma: (source: string) => unknown
  transaction: <T>(fn: () => T) => () => T
  close: () => void
}

/** The SQLite sidecars that travel with meta.db. */
const DB_SIDECARS = ['', '-wal', '-shm']

/**
 * One-time migration off the old in-coop index (kip#67): if a `.roost/meta.db`
 * exists inside the coop, move it (and its -wal/-shm) to the workspace before
 * the new db is created, so exactly one database exists. When a healthy index
 * already lives in the workspace, a leftover legacy file is a stale duplicate
 * and is dropped rather than left to drift.
 */
export function migrateLegacyDb (vaultRoot: string, destFile: string): void {
  const legacy = join(resolve(vaultRoot), '.roost', 'meta.db')
  if (resolve(legacy) === resolve(destFile)) return
  if (!existsSync(legacy)) return

  if (existsSync(destFile)) {
    for (const ext of DB_SIDECARS) rmSync(legacy + ext, { force: true })
    console.error(`Warning: removed the stale legacy index at ${legacy}; using ${destFile}.`)
    return
  }

  let moved = 0
  for (const ext of DB_SIDECARS) {
    const src = legacy + ext
    if (!existsSync(src)) continue
    const dest = destFile + ext
    try {
      renameSync(src, dest)
    } catch (err) {
      // A coop under a symlink/mount can be a different filesystem than the
      // state dir; rename across devices fails with EXDEV, so copy + unlink.
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      copyFileSync(src, dest)
      rmSync(src, { force: true })
    }
    moved++
  }
  if (moved) {
    console.error(`Warning: moved the roost index out of the coop: ${legacy} -> ${destFile}.`)
  }
}

/** Opens (creating if needed) the writer's meta.db and ensures the schema exists. */
export function openWriterConnection (vaultRoot: string = DEFAULT_VAULT_ROOT): DatabaseConnection {
  const file = paths.dbPath(vaultRoot)
  mkdirSync(dirname(file), { recursive: true })
  migrateLegacyDb(vaultRoot, file)
  paths.warnIfSynced(vaultRoot)
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  return db
}

/**
 * Opens a reader's meta.db. Read-only when the file already exists, so a
 * reader can never be the one to create or mutate the index (the writer owns
 * that). Returns null when there is no index yet — every read then degrades
 * to "empty", exactly as a fresh nest did.
 *
 * WAL is a persistent database property, so the reader inherits it; the
 * separate connection means an in-flight write on the worker thread never
 * blocks a read snapshot.
 */
export function openReaderConnection (
  vaultRoot: string = DEFAULT_VAULT_ROOT
): DatabaseConnection | null {
  const file = paths.dbPath(vaultRoot)
  if (!existsSync(file)) return null
  const db = new Database(file, { readonly: true, fileMustExist: true })
  db.pragma('busy_timeout = 5000')
  return db
}

/** True when the meta.db file exists on disk. */
export function indexExists (vaultRoot: string = DEFAULT_VAULT_ROOT): boolean {
  return existsSync(paths.dbPath(vaultRoot))
}

/** The absolute meta.db path for a coop (exposed for diagnostics/tests). */
export function roostDbPath (vaultRoot: string = DEFAULT_VAULT_ROOT): string {
  return paths.dbPath(vaultRoot)
}
