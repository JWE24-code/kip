// The block-level vector index (AD-8, AD-16), backed by sqlite-vec in its own
// `.roost/vectors.db`. It is deliberately separate from meta.db: the FTS index
// stays usable when sqlite-vec's native extension is unavailable (the app's
// packaged runtime), and the two derived stores can be rebuilt independently.
//
// Incremental contract: indexing a page re-embeds only the blocks whose
// heading+content hash changed, and never touches an unchanged block. All
// writes for one page happen in a single transaction, so a torn read never
// leaves a half-updated page behind.
const fs = require('node:fs')
const path = require('node:path')
const matter = require('gray-matter')
const Database = require('better-sqlite3')
const { splitBlocks, blockId, hashBlockText } = require('./blocks')
const { getEmbedder } = require('./embeddings')
const { DEFAULT_VAULT_ROOT, nestPath, DIR_TYPES } = require('./paths')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vec_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blocks (
  block_id    TEXT PRIMARY KEY,
  slug        TEXT NOT NULL,
  path        TEXT NOT NULL,
  block_index INTEGER NOT NULL,
  heading     TEXT NOT NULL DEFAULT '',
  text        TEXT NOT NULL DEFAULT '',
  text_hash   TEXT NOT NULL,
  updated     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS blocks_slug ON blocks(slug);
CREATE INDEX IF NOT EXISTS blocks_path ON blocks(path);
`

let sqliteVec
let sqliteVecError
function loadSqliteVec () {
  if (sqliteVec !== undefined) return sqliteVec
  try {
    sqliteVec = require('sqlite-vec')
  } catch (err) {
    sqliteVec = null
    sqliteVecError = err
  }
  return sqliteVec
}

/** True when the sqlite-vec native extension can actually be loaded on this host. */
function isVectorAvailable () {
  const vec = loadSqliteVec()
  if (!vec) return false
  try {
    vec.getLoadablePath()
    return true
  } catch {
    return false
  }
}

function vectorDbPath (vaultRoot = DEFAULT_VAULT_ROOT) {
  return path.join(vaultRoot, '.roost', 'vectors.db')
}

/** The text actually embedded for a block: heading context + content. */
function embedInput (block) {
  return block.heading ? `${block.heading}\n${block.text}` : block.text
}

function setMeta (db, key, value) {
  db.prepare('INSERT INTO vec_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(key, String(value))
}

function getMeta (db, key) {
  const row = db.prepare('SELECT v FROM vec_meta WHERE k = ?').get(key)
  return row ? row.v : null
}

/**
 * Opens vectors.db and guarantees the schema matches `embedder`. A changed
 * embedder id or vector width drops the old vectors and blocks — mixing two
 * vector spaces in one vec0 table would silently corrupt ranking.
 */
function openVectorDb (vaultRoot = DEFAULT_VAULT_ROOT, embedder = getEmbedder()) {
  const vec = loadSqliteVec()
  if (!vec) {
    throw new Error(
      'sqlite-vec is not installed; vector search is unavailable. ' +
      `(${sqliteVecError && sqliteVecError.message})`
    )
  }
  const file = vectorDbPath(vaultRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  vec.load(db)
  db.exec(SCHEMA)

  const dims = Math.floor(embedder.dimensions)
  const storedId = getMeta(db, 'embedder_id')
  const storedDims = Number(getMeta(db, 'dimensions'))
  if (storedId !== embedder.id || storedDims !== dims) {
    db.exec('DROP TABLE IF EXISTS vec_blocks')
    db.exec('DELETE FROM blocks')
    setMeta(db, 'embedder_id', embedder.id)
    setMeta(db, 'dimensions', dims)
  }
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_blocks USING vec0(block_id TEXT PRIMARY KEY, embedding FLOAT[${dims}])`)

  return db
}

/**
 * Indexes one page from its in-memory body, re-embedding only changed blocks.
 * Assumes the caller already holds an open db (see indexPage).
 * Returns { total, embedded, deleted }.
 */
function indexPageDb (db, slug, filePath, body, embedder) {
  const wanted = splitBlocks(body).map((b) => ({
    block_id: blockId({ explicitId: b.explicitId, path: filePath, index: b.index }),
    block_index: b.index,
    heading: b.heading,
    text: b.text,
    text_hash: hashBlockText(embedInput(b))
  }))

  const existing = new Map(
    db.prepare('SELECT block_id, text_hash FROM blocks WHERE slug = ?').all(slug).map((r) => [r.block_id, r])
  )
  const wantedIds = new Set(wanted.map((w) => w.block_id))
  const changed = wanted.filter((w) => {
    const prev = existing.get(w.block_id)
    return !prev || prev.text_hash !== w.text_hash
  })
  const removed = [...existing.keys()].filter((id) => !wantedIds.has(id))

  let vectors = []
  if (changed.length) {
    vectors = embedder.embed(changed.map((w) => (w.heading ? `${w.heading}\n${w.text}` : w.text)))
    if (!Array.isArray(vectors) || vectors.length !== changed.length) {
      throw new Error(`embedder "${embedder.id}" returned ${vectors && vectors.length} vectors for ${changed.length} blocks`)
    }
  }

  const tx = db.transaction(() => {
    const delVec = db.prepare('DELETE FROM vec_blocks WHERE block_id = ?')
    const insVec = db.prepare('INSERT INTO vec_blocks (block_id, embedding) VALUES (?, ?)')
    const upsertBlock = db.prepare(`
      INSERT INTO blocks (block_id, slug, path, block_index, heading, text, text_hash, updated)
      VALUES (@block_id, @slug, @path, @block_index, @heading, @text, @text_hash, @updated)
      ON CONFLICT(block_id) DO UPDATE SET
        slug = excluded.slug,
        path = excluded.path,
        block_index = excluded.block_index,
        heading = excluded.heading,
        text = excluded.text,
        text_hash = excluded.text_hash,
        updated = excluded.updated
    `)
    const delBlock = db.prepare('DELETE FROM blocks WHERE block_id = ?')
    const now = new Date().toISOString()

    if (changed.length) {
      changed.forEach((w, i) => {
        delVec.run(w.block_id)
        insVec.run(w.block_id, vectors[i])
        upsertBlock.run({ ...w, slug, path: filePath, updated: now })
      })
    }
    for (const id of removed) {
      delVec.run(id)
      delBlock.run(id)
    }
  })
  tx()

  return { total: wanted.length, embedded: changed.length, deleted: removed.length }
}

/** Opens vectors.db, indexes one page, closes. Public entry point. */
function indexPage (slug, filePath, body, { vaultRoot = DEFAULT_VAULT_ROOT, embedder = getEmbedder() } = {}) {
  const db = openVectorDb(vaultRoot, embedder)
  try {
    return indexPageDb(db, slug, filePath, body, embedder)
  } finally {
    db.close()
  }
}

/** Removes every block vector that belongs to a slug. Returns blocks removed. */
function removePageVectors (slug, { vaultRoot = DEFAULT_VAULT_ROOT, embedder = getEmbedder() } = {}) {
  const db = openVectorDb(vaultRoot, embedder)
  try {
    const ids = db.prepare('SELECT block_id FROM blocks WHERE slug = ?').all(slug).map((r) => r.block_id)
    const tx = db.transaction(() => {
      const delVec = db.prepare('DELETE FROM vec_blocks WHERE block_id = ?')
      for (const id of ids) delVec.run(id)
      db.prepare('DELETE FROM blocks WHERE slug = ?').run(slug)
    })
    tx()
    return ids.length
  } finally {
    db.close()
  }
}

/** Number of indexed blocks (0 when the store or extension is missing). */
function countVectors ({ vaultRoot = DEFAULT_VAULT_ROOT, embedder = getEmbedder() } = {}) {
  if (!isVectorAvailable()) return 0
  const db = openVectorDb(vaultRoot, embedder)
  try {
    return db.prepare('SELECT count(*) AS n FROM blocks').get().n
  } finally {
    db.close()
  }
}

/** Whether the vector index has anything to search. */
function hasVectors (opts = {}) {
  return countVectors(opts) > 0
}

/**
 * Brute-force KNN over the block vectors (AD-8 accepts this up to ~50k notes).
 * Returns the nearest blocks as
 * `[{ block_id, slug, path, block_index, heading, text, distance }]`.
 */
function vectorSearch (embedding, { vaultRoot = DEFAULT_VAULT_ROOT, embedder = getEmbedder(), limit = 20 } = {}) {
  if (!isVectorAvailable()) return []
  const db = openVectorDb(vaultRoot, embedder)
  try {
    if (!db.prepare('SELECT count(*) AS n FROM blocks').get().n) return []
    return db.prepare(`
      SELECT v.block_id, b.slug, b.path, b.block_index, b.heading, b.text, v.distance
      FROM vec_blocks v
      JOIN blocks b ON b.block_id = v.block_id
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance
    `).all(new Float32Array(embedding), limit)
  } finally {
    db.close()
  }
}

/** Indexed slugs + their block count. */
function indexedSlugs (db) {
  return new Map(db.prepare('SELECT slug, count(*) AS n FROM blocks GROUP BY slug').all().map((r) => [r.slug, r.n]))
}

/**
 * Boot/repair reconcile (AD-15): treats the disk as truth. Walks every nest
 * page, indexes it (changed blocks only), and drops vectors for slugs whose
 * file is gone. Stable fallback ids mean a mid-burst kill heals with no
 * phantom deletes or duplicate upserts. Returns
 * `{ pages, embedded, deleted }`.
 */
function reconcileVectors (vaultRoot = DEFAULT_VAULT_ROOT, { embedder = getEmbedder() } = {}) {
  if (!isVectorAvailable()) return { pages: 0, embedded: 0, deleted: 0, skipped: 'sqlite-vec unavailable' }
  const db = openVectorDb(vaultRoot, embedder)
  try {
    const nest = nestPath(vaultRoot)
    const found = new Set()
    let embedded = 0
    for (const dirName of Object.keys(DIR_TYPES)) {
      const dir = path.join(nest, dirName)
      if (!fs.existsSync(dir)) continue
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.md')) continue
        const slug = file.slice(0, -3)
        const abs = path.join(dir, file)
        const raw = fs.readFileSync(abs, 'utf8')
        const { content } = matter(raw)
        const relPath = path.relative(vaultRoot, abs).split(path.sep).join('/')
        embedded += indexPageDb(db, slug, relPath, content, embedder).embedded
        found.add(slug)
      }
    }
    const stale = [...indexedSlugs(db).keys()].filter((slug) => !found.has(slug))
    let deleted = 0
    for (const slug of stale) {
      const ids = db.prepare('SELECT block_id FROM blocks WHERE slug = ?').all(slug).map((r) => r.block_id)
      const delVec = db.prepare('DELETE FROM vec_blocks WHERE block_id = ?')
      for (const id of ids) delVec.run(id)
      db.prepare('DELETE FROM blocks WHERE slug = ?').run(slug)
      deleted += ids.length
    }
    return { pages: found.size, embedded, deleted }
  } finally {
    db.close()
  }
}

module.exports = {
  isVectorAvailable,
  vectorDbPath,
  openVectorDb,
  indexPage,
  indexPageDb,
  removePageVectors,
  countVectors,
  hasVectors,
  vectorSearch,
  reconcileVectors
}
