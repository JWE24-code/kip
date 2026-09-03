#!/usr/bin/env node
// One-time migration: fold coop/eggs/ into coop/pages/ (the unified source
// folder — see docs/DESIGN.md "The nest"). Moves every file, de-dupes
// byte-identical copies, and rewrites the hatched_sources paths so an
// already-hatched source isn't re-hatched at its new location.
//
//   node scripts/migrate-eggs-to-pages.js
//
// Set KIP_COOP_ROOT to point at a graph other than this repo's ./coop.
// Safe to re-run: a graph with no eggs/ is a no-op. Print a JSON summary.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { DEFAULT_VAULT_ROOT, pagesPath } = require('./lib/paths')
const { openDb } = require('./lib/db')

function sha1 (buf) {
  return crypto.createHash('sha1').update(buf).digest('hex')
}

function migrate (vaultRoot = DEFAULT_VAULT_ROOT) {
  const eggsDir = path.join(vaultRoot, 'eggs')
  if (!fs.existsSync(eggsDir)) {
    return { moved: [], deduped: [], conflicts: [] }
  }
  const sourcesDir = pagesPath(vaultRoot)
  fs.mkdirSync(sourcesDir, { recursive: true })

  const db = openDb(vaultRoot)
  const moved = []
  const deduped = []
  const conflicts = []

  try {
    for (const name of fs.readdirSync(eggsDir)) {
      const src = path.join(eggsDir, name)
      if (!fs.statSync(src).isFile() || name.startsWith('.')) continue
      const eggHash = sha1(fs.readFileSync(src))

      const target = path.join(sourcesDir, name)
      if (fs.existsSync(target)) {
        if (sha1(fs.readFileSync(target)) === eggHash) {
          // Identical — the pages/ copy is canonical; drop the duplicate.
          fs.rmSync(src)
          deduped.push(name)
          db.prepare('DELETE FROM hatched_sources WHERE path = ?').run(`eggs/${name}`)
          continue
        }
        // Same name, different content — keep both by suffixing the egg copy.
        const ext = path.extname(name)
        const altName = `${path.basename(name, ext)}-egg${ext}`
        fs.renameSync(src, path.join(sourcesDir, altName))
        conflicts.push({ from: name, to: altName })
        db.prepare('UPDATE hatched_sources SET path = ? WHERE path = ?').run(`pages/${altName}`, `eggs/${name}`)
        continue
      }

      fs.renameSync(src, target)
      moved.push(name)
      db.prepare('UPDATE hatched_sources SET path = ? WHERE path = ?').run(`pages/${name}`, `eggs/${name}`)
    }

    if (fs.readdirSync(eggsDir).length === 0) fs.rmdirSync(eggsDir)
  } finally {
    db.close()
  }

  return { moved, deduped, conflicts }
}

if (require.main === module) {
  const result = migrate()
  console.log(JSON.stringify(result, null, 2))
}

module.exports = { migrate }
