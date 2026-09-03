const fs = require('node:fs')
const path = require('node:path')
const Database = require('better-sqlite3')
const { dbPath, DEFAULT_VAULT_ROOT } = require('./paths')

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

/** Opens (creating if needed) the meta.db for a coop and ensures the schema exists. */
function openDb (vaultRoot = DEFAULT_VAULT_ROOT) {
  const file = dbPath(vaultRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  return db
}

module.exports = { openDb }
