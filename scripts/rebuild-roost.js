#!/usr/bin/env node
// One-time / re-runnable migration: rebuilds coop/.roost/meta.db from the
// markdown files under coop/nest/. The markdown files are the source of
// truth; meta.db (and nest/index.md) are derived and safe to delete/rebuild
// by running this script again.
const fs = require('node:fs')
const path = require('node:path')
const matter = require('gray-matter')
const { upsertPage, regenerateIndexMd } = require('./lib/roost')
const { DEFAULT_VAULT_ROOT, nestPath, DIR_TYPES } = require('./lib/paths')
const { openDb } = require('./lib/db')

function deriveSummary (content) {
  const paragraph = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'))
  if (!paragraph) return ''
  return paragraph.length > 200 ? paragraph.slice(0, 197) + '...' : paragraph
}

function rebuildRoost (vaultRoot = DEFAULT_VAULT_ROOT) {
  const nest = nestPath(vaultRoot)
  const found = new Set()

  for (const [dirName, defaultType] of Object.entries(DIR_TYPES)) {
    const dir = path.join(nest, dirName)
    if (!fs.existsSync(dir)) continue

    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue
      const slug = file.slice(0, -3)
      const filePath = path.join(dir, file)
      const raw = fs.readFileSync(filePath, 'utf8')
      const { data, content } = matter(raw)
      const relPath = path.relative(vaultRoot, filePath).split(path.sep).join('/')

      upsertPage(
        slug,
        relPath,
        data.type || defaultType,
        data.tags || [],
        data.summary || deriveSummary(content),
        content,
        vaultRoot
      )
      found.add(slug)
    }
  }

  // Drop rows for pages that no longer exist on disk, so a rerun always
  // brings meta.db back in sync with coop/nest/ exactly.
  const db = openDb(vaultRoot)
  try {
    const existingSlugs = db.prepare('SELECT slug FROM pages').all().map((r) => r.slug)
    const stale = existingSlugs.filter((slug) => !found.has(slug))
    const deletePage = db.prepare('DELETE FROM pages WHERE slug = ?')
    const deleteFts = db.prepare('DELETE FROM pages_fts WHERE slug = ?')
    const deleteSections = db.prepare('DELETE FROM sections WHERE slug = ?')
    for (const slug of stale) {
      deletePage.run(slug)
      deleteFts.run(slug)
      deleteSections.run(slug)
    }
  } finally {
    db.close()
  }

  regenerateIndexMd(vaultRoot)
  return { indexed: found.size }
}

if (require.main === module) {
  const result = rebuildRoost()
  console.log(`Rebuilt the roost from ${result.indexed} page(s).`)
}

module.exports = { rebuildRoost }
