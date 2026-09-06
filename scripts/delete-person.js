#!/usr/bin/env node
// Delete a person page from the nest — the "delete" action behind the People
// panel (kip-app#126). Removes nest/people/<slug>.md and its meta.db rows
// (pages + pages_fts + sections), then regenerates nest/index.md.
//
// [[wikilinks]] to the person elsewhere in the coop are left as-is: the
// mention in a source or journal is still valid history, and a dead-end
// link is already something groom flags.
//
//   node delete-person.js --slug jane-doe
//   node delete-person.js --email jane@example.com
//
// Prints { deleted, slug, path, deindexed } on success; exits 1 (with a
// message on stderr) when no matching person page exists.
const fs = require('node:fs')
const path = require('node:path')
const { removePage, regenerateIndexMd } = require('./lib/roost')
const { findPersonByEmail } = require('./lib/pages')
const { DEFAULT_VAULT_ROOT } = require('./lib/paths')

function arg (name) {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null
}

const vaultRoot = DEFAULT_VAULT_ROOT
let slug = (arg('--slug') || '').trim()
const email = (arg('--email') || '').trim()

if (!slug && email) {
  const hit = findPersonByEmail(email, vaultRoot)
  if (hit) slug = hit.slug
}

if (!slug) {
  console.error('--slug (or --email of an existing person) is required')
  process.exit(1)
}

const relPath = `nest/people/${slug}.md`
const abs = path.join(vaultRoot, 'nest', 'people', `${slug}.md`)

if (!fs.existsSync(abs)) {
  console.error(`No person page at ${relPath}`)
  process.exit(1)
}

fs.rmSync(abs)
const deindexed = removePage(slug, vaultRoot)
regenerateIndexMd(vaultRoot)

console.log(JSON.stringify({ deleted: true, slug, path: relPath, deindexed }))
