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
 * `source` (coop-relative path of the document this page was derived from)
 * and `summary` (the LLM one-liner) are provenance/metadata: on create they
 * land in the frontmatter so the markdown stays the source of truth
 * (rebuild-roost reads `summary:` back); on update `source` is refreshed
 * (the page was just re-derived from that document) and `tags` are MERGED
 * into the existing ones rather than dropped — a peck answer filed onto an
 * existing page keeps its `from-peck` marker visible.
 *
 * @param {{type: 'entity'|'concept'|'source', title: string, body: string, tags?: string[], vaultRoot?: string, source?: string|null, summary?: string|null}} args
 * @returns {{action: 'create'|'update', slug: string, path: string, type: string, tags: string[]}}
 */
function resolvePage ({ type, title, body, tags = [], vaultRoot = DEFAULT_VAULT_ROOT, source = null, summary = null }) {
  const today = new Date().toISOString().slice(0, 10)
  const similar = findSimilarSlug(title, vaultRoot)

  // A source page is a per-document hub; it must never be collapsed into an
  // existing entity/concept that happens to share its name (kip-app#113) —
  // that would append the hub onto an unrelated page instead of creating the
  // trace target. Same-name, different-type -> create the hub in its own dir.
  const typeMismatch = similar && similar.score >= SIMILARITY_THRESHOLD && type === 'source'

  if (similar && similar.score >= SIMILARITY_THRESHOLD && !typeMismatch) {
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

    data.updated = today
    if (source) {
      data.source = source
      data.source_hatched = today
    }
    if (Array.isArray(tags) && tags.length) {
      data.tags = [...new Set([...(Array.isArray(data.tags) ? data.tags : []), ...tags])]
    }
    const updatedContent = `${content.trimEnd()}\n\n---\n_Update ${today}:_\n\n${body.trim()}\n`
    fs.writeFileSync(filePath, matter.stringify(updatedContent, data))

    const mergedTags = Array.isArray(data.tags) ? data.tags : []
    return { action: 'update', slug: similar.slug, path: row.path, type: data.type, tags: mergedTags }
  }

  const slug = slugify(title)
  const relPath = relPathFor(type, slug)
  const filePath = path.join(vaultRoot, relPath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })

  const frontmatter = { type, created: today, updated: today, tags }
  if (source) {
    frontmatter.source = source
    frontmatter.source_hatched = today
  }
  if (summary) frontmatter.summary = summary
  fs.writeFileSync(filePath, matter.stringify(`${body.trim()}\n`, frontmatter))

  return { action: 'create', slug, path: relPath, type, tags }
}

module.exports = { resolvePage, SIMILARITY_THRESHOLD }
