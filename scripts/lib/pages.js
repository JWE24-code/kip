// Shared create-vs-update resolution for anything that writes a new page into
// coop/nest/ (peck.js's "file this answer" step, and hatch.js). Lives here,
// not in either script, so there is exactly one place implementing the
// duplicate-prevention rule from coop/schema.md.
const fs = require('node:fs')
const path = require('node:path')
const matter = require('gray-matter')
const { findSimilarSlug, slugify, getPage, SIMILARITY_THRESHOLD } = require('./roost')
const { DEFAULT_VAULT_ROOT, TYPE_DIRS } = require('./paths')

function relPathFor (type, slug) {
  const dir = TYPE_DIRS[type]
  if (!dir) throw new Error(`Unknown page type: ${type} (expected entity, concept, source, or person)`)
  return `nest/${dir}/${slug}.md`
}

// The contact fields a `person` page carries beyond the title (which is the
// name). Written to frontmatter when a hatch proposes them; the tail of
// free-form fields stays in `properties::` lines in the body.
const PERSON_FIELDS = ['email', 'org', 'role', 'phone', 'aliases']

/** Finds an existing person page by canonical email (case-insensitive). */
function findPersonByEmail (email, vaultRoot = DEFAULT_VAULT_ROOT) {
  if (!email) return null
  const dir = path.join(vaultRoot, 'nest', 'people')
  if (!fs.existsSync(dir)) return null
  const want = String(email).trim().toLowerCase()
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue
    try {
      const { data } = matter(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (data.email && String(data.email).trim().toLowerCase() === want) {
        return { slug: f.slice(0, -3), path: `nest/people/${f}` }
      }
    } catch { /* an unreadable page is not a person */ }
  }
  return null
}

// meta.db keys pages by slug alone, so one slug = one page. Long titles (raw
// questions, long filenames — CJK is ~3 bytes/char) would blow past filename
// limits, so derived slugs are capped. Matches web-sources.js SLUG_MAX.
const SLUG_MAX = 60

/**
 * First free slug derived from `baseSlug` — the pages table is keyed by slug,
 * so a slug that already exists (as another page type, or as a stray file) must
 * never be reused: the new write would steal the old page's row. Source-hub
 * creates get a readable `-source` suffix before falling back to numbering.
 */
function nextFreeSlug (baseSlug, type, vaultRoot = DEFAULT_VAULT_ROOT) {
  let slug = String(baseSlug || '').slice(0, SLUG_MAX) || slugify('page')
  if (!getPage(slug, vaultRoot) && !fs.existsSync(path.join(vaultRoot, relPathFor(type, slug)))) {
    return slug
  }
  const stem = type === 'source' ? `${slug}-source` : `${slug}-`
  for (let n = 1; ; n++) {
    const candidate = type === 'source' && n === 1 ? stem : `${stem}${n}`
    if (!getPage(candidate, vaultRoot) && !fs.existsSync(path.join(vaultRoot, relPathFor(type, candidate)))) {
      return candidate
    }
  }
}

/** True when a source page may NOT update the matched near-duplicate: a
 *  per-document hub must never be appended onto an entity/concept that
 *  happens to share its name — same-name, different-type means create the
 *  hub in its own directory (kip-app#113). A same-type match (re-hatching
 *  the same document's hub) is a normal update. */
function sourceHubMustCreate (matchedType, incomingType) {
  return incomingType === 'source' && matchedType !== 'source'
}

/**
 * Finds a document's existing trace hub by its `source:` frontmatter — the
 * authoritative identity of a hub. Title similarity can't do this job: once
 * a same-named entity pushes the hub to a `-source` slug, that slug scores
 * below the similarity threshold and the hub would never re-find itself.
 */
function findSourceHubByPath (source, vaultRoot = DEFAULT_VAULT_ROOT) {
  if (!source) return null
  const dir = path.join(vaultRoot, 'nest', 'sources')
  if (!fs.existsSync(dir)) return null
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue
    try {
      const { data } = matter(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (data.source === source) return { slug: f.slice(0, -3), path: `nest/sources/${f}` }
    } catch { /* an unreadable page is not a hub */ }
  }
  return null
}

/**
 * The set of coop-relative source paths that have already been hatched —
 * every document whose trace hub exists in nest/sources/ with a matching
 * `source:` frontmatter. Unlike `hatched_sources` (a .roost/meta.db cache that
 * lives on ONE device and is not what Dropbox syncs), the nest is synced graph
 * markdown, so this is the cross-device-authoritative "already hatched" signal:
 * a source hatched on device A is recognized as hatched on device B after a
 * sync, and is not re-hatched.
 */
function hatchedSourcePaths (vaultRoot = DEFAULT_VAULT_ROOT) {
  const out = new Set()
  const dir = path.join(vaultRoot, 'nest', 'sources')
  if (!fs.existsSync(dir)) return out
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue
    try {
      const { data } = matter(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (typeof data.source === 'string' && data.source.trim()) out.add(data.source.trim())
    } catch { /* an unreadable page is not a hub */ }
  }
  return out
}

/**
 * Decides whether `title` should become a new nest page or an update to an
 * existing near-duplicate (per coop/schema.md's duplicate-prevention rule),
 * and writes the markdown file either way.
 *
 * Provenance / metadata (kip-app#113):
 * - `source` (coop-relative path of the document this page was derived from)
 *   is written to the frontmatter on create and refreshed on update (the
 *   page was just re-derived from that document). On a source page's create
 *   the body also gets a `## Source` block naming the file, hash and date —
 *   the trace lives in the page, not just its metadata. A source page whose
 *   `source` path already has a hub updates that hub, whatever its title.
 * - `summary` (the LLM one-liner) goes to the frontmatter on create AND
 *   update, so rebuild-roost (which reads `summary:` back) never silently
 *   degrades it to the first body paragraph.
 * - `tags` are merged into the existing page's tags on update only when the
 *   caller asks (`mergeTags`) — a filed peck answer keeps its `from-peck`
 *   marker; a routine hatch update doesn't accumulate invented tags.
 *
 * @param {{type: 'entity'|'concept'|'source'|'person', title: string, body: string, tags?: string[], vaultRoot?: string, source?: string|null, sourceHash?: string|null, sourceOriginal?: string|null, summary?: string|null, mergeTags?: boolean, person?: {email?: string, org?: string, role?: string, phone?: string, aliases?: string[]}|null}} args
 * @returns {{action: 'create'|'update', slug: string, path: string, type: string, tags: string[]}}
 */
function resolvePage ({ type, title, body, tags = [], vaultRoot = DEFAULT_VAULT_ROOT, source = null, sourceHash = null, sourceOriginal = null, summary = null, mergeTags = false, person = null }) {
  const today = new Date().toISOString().slice(0, 10)
  const similar = findSimilarSlug(title, vaultRoot)
  let matched = similar && similar.score >= SIMILARITY_THRESHOLD ? getPage(similar.slug, vaultRoot) : null
  let mustCreate = matched ? sourceHubMustCreate(matched.type, type) : false

  // A document's own hub wins over any title match: re-hatching `pages/x.md`
  // updates the page whose frontmatter says `source: pages/x.md`, even when a
  // same-named entity scores higher or the hub's slug drifted to `-source`.
  if (type === 'source' && source) {
    const hub = findSourceHubByPath(source, vaultRoot)
    if (hub) {
      matched = { ...getPage(hub.slug, vaultRoot), ...hub }
      mustCreate = false
    }
  }

  // A person resolves by canonical email first — same email = same person page,
  // whatever the title variant (kip-app#125).
  if (type === 'person' && person && person.email) {
    const byEmail = findPersonByEmail(person.email, vaultRoot)
    if (byEmail) {
      matched = { ...getPage(byEmail.slug, vaultRoot), ...byEmail }
      mustCreate = false
    }
  }

  if (matched && !mustCreate) {
    const filePath = path.join(vaultRoot, matched.path)
    const raw = fs.readFileSync(filePath, 'utf8')
    const { data, content } = matter(raw)

    data.updated = today
    if (source) {
      data.source = source
      data.source_hatched = today
      if (sourceOriginal) data.source_original = sourceOriginal
    }
    if (summary) data.summary = summary
    if (person) {
      for (const f of PERSON_FIELDS) if (person[f] != null && person[f] !== '') data[f] = person[f]
    }
    if (mergeTags && Array.isArray(tags) && tags.length) {
      const existing = Array.isArray(data.tags) ? data.tags : (data.tags ? [data.tags] : [])
      data.tags = [...new Set([...existing, ...tags])]
    }
    const updatedContent = `${content.trimEnd()}\n\n---\n_Update ${today}:_\n\n${body.trim()}\n`
    fs.writeFileSync(filePath, matter.stringify(updatedContent, data))

    const finalTags = Array.isArray(data.tags) ? data.tags : []
    return { action: 'update', slug: matched.slug, path: matched.path, type: data.type || type, tags: finalTags }
  }

  const slug = nextFreeSlug(slugify(title), type, vaultRoot)
  const relPath = relPathFor(type, slug)
  const filePath = path.join(vaultRoot, relPath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })

  let bodyText = `${body.trim()}\n`
  const frontmatter = { type, created: today, updated: today, tags }
  if (source) {
    frontmatter.source = source
    frontmatter.source_hatched = today
    if (sourceOriginal) frontmatter.source_original = sourceOriginal
    // The vault-pattern trace lives in the page itself: every source page
    // names the document it came from (and the original, for converted Office
    // siblings) on create — keyed on what actually happened (a create), not
    // on the plan's guess.
    if (type === 'source' && !body.trim().startsWith('## Source')) {
      bodyText = `## Source\n\n- Source file: \`${source}\`` +
        (sourceOriginal ? `\n- Original document: \`${sourceOriginal}\`` : '') +
        (sourceHash ? `\n- Content hash at hatch: \`${sourceHash.slice(0, 12)}…\`` : '') +
        `\n- Hatched: ${today}\n\n` + bodyText
    }
  }
  if (summary) frontmatter.summary = summary
  if (person) {
    for (const f of PERSON_FIELDS) if (person[f] != null && person[f] !== '') frontmatter[f] = person[f]
  }
  fs.writeFileSync(filePath, matter.stringify(bodyText, frontmatter))

  return { action: 'create', slug, path: relPath, type, tags }
}

module.exports = { resolvePage, nextFreeSlug, sourceHubMustCreate, findSourceHubByPath, findPersonByEmail, hatchedSourcePaths, SIMILARITY_THRESHOLD }
