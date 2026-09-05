#!/usr/bin/env node
// Log an interaction (an email, call, meeting…) against a person page — the
// CLI behind Kip's local /interactions capture endpoint, and the manual-logging
// equivalent for a shell. One format, shared by the future Outlook/Gmail
// add-ins, so a cross-add-in dedupe question can't diverge (kip-app#127).
//
// Resolves the person by canonical email (findPersonByEmail), creating a
// person page when unknown, then appends a line to the page's "## Interactions"
// section. The section + full body are re-indexed into FTS so Peck can find
// interactions.
//
//   node log-interaction.js --email jane@example.com --name "Jane Doe" \
//     --subject "Re: the timeline" --direction out --date 2026-09-05
//
// Prints { action, slug, path, type, interaction: { date, direction, subject } }.
const fs = require('node:fs')
const path = require('node:path')
const matter = require('gray-matter')
const { resolvePage, findPersonByEmail } = require('./lib/pages')
const { upsertPage, regenerateIndexMd } = require('./lib/roost')
const { DEFAULT_VAULT_ROOT } = require('./lib/paths')

function arg (name) {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null
}

// Accept the loose variants an add-in might send ("incoming"/"received"/"sent"),
// collapse to the canonical in/out.
function normalizeDirection (raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (['in', 'incoming', 'received', 'recv'].includes(s)) return 'in'
  if (['out', 'outgoing', 'sent'].includes(s)) return 'out'
  return 'out'
}

// Insert `line` at the end of the page's "## Interactions" section, creating
// the section when absent.
function appendInteraction (content, line) {
  const trimmed = content.trimEnd()
  const lines = trimmed.split('\n')
  const idx = lines.findIndex((l) => /^##\s+Interactions\s*$/i.test(l))
  if (idx === -1) {
    return `${trimmed}\n\n## Interactions\n\n${line}\n`
  }
  // Section runs from idx+1 to the next "## " heading (or EOF).
  let end = idx + 1
  while (end < lines.length && !/^##\s/.test(lines[end])) end++
  // Drop trailing blank lines inside the section before appending.
  while (end > idx + 1 && lines[end - 1].trim() === '') end--
  return [...lines.slice(0, end), line, ...lines.slice(end)].join('\n')
}

const email = (arg('--email') || '').trim()
const subject = (arg('--subject') || '').trim()
if (!subject) {
  console.error('--subject is required')
  process.exit(1)
}
if (!email) {
  console.error('--email is required (the person a new interaction belongs to)')
  process.exit(1)
}

const direction = normalizeDirection(arg('--direction'))
const date = (arg('--date') || new Date().toISOString().slice(0, 10)).trim()
const vaultRoot = DEFAULT_VAULT_ROOT

// Resolve the person, creating the page when there's no page for this email yet.
const existing = findPersonByEmail(email, vaultRoot)
const result = existing
  ? { action: 'update', slug: existing.slug, path: existing.path, type: 'person' }
  : resolvePage({
      type: 'person',
      title: (arg('--name') || '').trim() || email.split('@')[0] || 'Person',
      body: '',
      person: { email },
      vaultRoot,
    })

const filePath = path.join(vaultRoot, result.path)
const { data, content } = matter(fs.readFileSync(filePath, 'utf8'))
const line = `- ${date} · ${direction} · ${subject}`
const updated = appendInteraction(content, line)
fs.writeFileSync(filePath, matter.stringify(updated, data))

// Re-index: FTS picks up the new interaction line; sections stay in sync.
upsertPage(result.slug, result.path, 'person', data.tags || [], data.summary || '', updated, vaultRoot, data.aliases || [])
regenerateIndexMd(vaultRoot)

console.log(JSON.stringify({ ...result, interaction: { date, direction, subject } }))
