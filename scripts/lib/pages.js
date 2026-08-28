// Shared create-vs-update resolution for anything that writes a new page into
// coop/nest/ (peck.js's "file this answer" step, and hatch.js). Lives here,
// not in either script, so there is exactly one place implementing the
// duplicate-prevention rule from coop/schema.md.
const fs = require('node:fs')
const path = require('node:path')
const matter = require('gray-matter')
const { findSimilarSlug, slugify, SIMILARITY_THRESHOLD } = require('./roost')
const { openDb } = require('./db')
const { DEFAULT_VAULT_ROOT, TYPE_DIRS } = require('./paths')

function relPathFor (type, slug) {
  const dir = TYPE_DIRS[type]
  if (!dir) throw new Error(`Unknown page type: ${type} (expected entity, concept, or source)`)
  return `nest/${dir}/${slug}.md`
}

/**
 * Decides whether `title` should become a new nest page or an update to an
 * existing near-duplicate (per coop/schema.md's duplicate-prevention rule),
 * and writes the markdown file either way.
 *
 * @param {{type: 'entity'|'concept'|'source', title: string, body: string, tags?: string[], vaultRoot?: string}} args
 * @returns {{action: 'create'|'update', slug: string, path: string, type: string, tags: string[]}}
 */
function resolvePage ({ type, title, body, tags = [], vaultRoot = DEFAULT_VAULT_ROOT }) {
  const similar = findSimilarSlug(title, vaultRoot)

  if (similar && similar.score >= SIMILARITY_THRESHOLD) {
    const db = openDb(vaultRoot)
    let row
    try {
      row = db.prepare('SELECT path, type, tags FROM pages WHERE slug = ?').get(similar.slug)
    } finally {
      db.close()
    }

    const filePath = path.join(vaultRoot, row.path)
    const raw = fs.readFileSync(filePath, 'utf8')
    const { data, content } = matter(raw)
    const today = new Date().toISOString().slice(0, 10)

    data.updated = today
    const updatedContent = `${content.trimEnd()}\n\n---\n_Update ${today}:_\n\n${body.trim()}\n`
    fs.writeFileSync(filePath, matter.stringify(updatedContent, data))

    return { action: 'update', slug: similar.slug, path: row.path, type: data.type, tags: JSON.parse(row.tags) }
  }

  const slug = slugify(title)
  const relPath = relPathFor(type, slug)
  const filePath = path.join(vaultRoot, relPath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })

  const today = new Date().toISOString().slice(0, 10)
  const frontmatter = { type, created: today, updated: today, tags }
  fs.writeFileSync(filePath, matter.stringify(`${body.trim()}\n`, frontmatter))

  return { action: 'create', slug, path: relPath, type, tags }
}

module.exports = { resolvePage, SIMILARITY_THRESHOLD }
