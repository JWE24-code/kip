#!/usr/bin/env node
// Add (or dedupe) a person page in the nest from structured input — the
// "add person" hatch action behind the People panel. Writes a well-formed
// nest/people/<slug>.md (type/name/email/org/role/phone/aliases frontmatter)
// and indexes it, reusing resolvePage's slugify + email dedupe so the same
// email always resolves to the same page.
//
//   node add-person.js --name "Jane Doe" --email jane@example.com \
//     --org Acme --role CFO --phone "+32 123 45 67" --aliases "JD,J. Doe"
//     --note "Met at the summit."
//
// Prints { action, slug, path, type } on success.
const { resolvePage } = require('./lib/pages')
const { upsertPage, regenerateIndexMd } = require('./lib/roost')
const { DEFAULT_VAULT_ROOT } = require('./lib/paths')

function arg (name) {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null
}

const name = (arg('--name') || '').trim()
if (!name) {
  console.error('--name is required')
  process.exit(1)
}

const person = {}
for (const [flag, key] of [['--email', 'email'], ['--org', 'org'], ['--role', 'role'], ['--phone', 'phone']]) {
  const v = (arg(flag) || '').trim()
  if (v) person[key] = v
}
const aliases = (arg('--aliases') || '').split(',').map((s) => s.trim()).filter(Boolean)
if (aliases.length) person.aliases = aliases

const note = (arg('--note') || '').trim()
const vaultRoot = DEFAULT_VAULT_ROOT

const result = resolvePage({
  type: 'person',
  title: name,
  body: note,
  person,
  vaultRoot,
})

upsertPage(result.slug, result.path, 'person', result.tags || [], '', note, vaultRoot, aliases)
regenerateIndexMd(vaultRoot)

console.log(JSON.stringify(result))
