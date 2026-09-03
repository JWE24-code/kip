#!/usr/bin/env node
// CLI for the "Hatch workflow" (coop/schema.md) — a thin wrapper around
// scripts/lib/hatch.js's proposeHatchPlan()/commitHatchPlan(): argv
// parsing, printing, and the interactive confirm-before-writing prompt. No
// workflow logic lives here; see scripts/lib/hatch.js for
// copy-to-pages -> propose -> plan -> generate -> write.
//
// Usage: node scripts/hatch.js <path-to-source> [--classic]
//   --classic (or KIP_HATCH_CLASSIC=1): old path — one propose call plus one
//   generate call per page. Default is combined: a single LLM call that
//   proposes the pages and drafts every body at once.
//   A .edn path is a Logseq whiteboard: a deterministic outline of its shapes
//   plus one LLM call for a "Context" section, same as "Hatch sources" does
//   for whiteboards/. Falls back to outline-only with no provider configured.
require('dotenv').config()
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline/promises')

const { describeProvider } = require('./lib/llm')
const { proposeHatchPlan, commitHatchPlan, hatchWhiteboard } = require('./lib/hatch')
const { hashContent } = require('./lib/roost')
const { DEFAULT_VAULT_ROOT } = require('./lib/paths')

function printPlan (plan) {
  console.log('\nProposed pages:')
  for (const p of plan) {
    const label = p.action === 'update'
      ? `UPDATE ${p.slug} (similarity ${p.similarity.toFixed(2)})`
      : `CREATE ${p.slug}`
    console.log(`  - [${label}] "${p.title}" (${p.type})`)
  }
  console.log('')
}

async function main () {
  const combined = !(process.argv.includes('--classic') || process.env.KIP_HATCH_CLASSIC === '1')
  const sourceArg = process.argv.slice(2).find((a) => !a.startsWith('--'))
  if (!sourceArg) {
    console.error('Usage: node scripts/hatch.js <path-to-source> [--classic]')
    process.exitCode = 1
    return
  }
  if (!fs.existsSync(sourceArg) || !fs.statSync(sourceArg).isFile()) {
    console.error(`No such file: ${sourceArg}`)
    process.exitCode = 1
    return
  }

  const vaultRoot = DEFAULT_VAULT_ROOT

  // A whiteboard .edn becomes an outline page (deterministic) plus an
  // LLM-written Context section — no plan review, no y/n prompt.
  if (sourceArg.toLowerCase().endsWith('.edn')) {
    console.error(describeProvider(vaultRoot))
    const result = await hatchWhiteboard(sourceArg, vaultRoot)
    const verb = result.action === 'create' ? 'Created' : 'Updated'
    console.log(`${verb} ${result.path}${result.enriched ? '' : ' (outline only — no LLM context added)'}`)
    return
  }

  console.error(describeProvider())

  const { sourceTitle, sourceContent, sourceFilePath, plan } = await proposeHatchPlan(sourceArg, vaultRoot, { combined })
  if (plan.length === 0) {
    console.log('The LLM proposed no usable candidate pages for this source. Nothing to do.')
    return
  }

  printPlan(plan)
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  let reply
  try {
    reply = (await rl.question('Write these pages? (y/n) ')).trim().toLowerCase()
  } finally {
    rl.close()
  }
  if (reply !== 'y' && reply !== 'yes') {
    console.log('Aborted — nothing written.')
    return
  }

  const { results } = await commitHatchPlan({
    plan,
    sourceTitle,
    sourceContent,
    sourceRelPath: path.relative(vaultRoot, sourceFilePath).split(path.sep).join('/'),
    sourceHash: hashContent(sourceContent)
  }, vaultRoot)

  console.log('\nDone:')
  for (const r of results) {
    console.log(`  ${r.action === 'create' ? 'Created' : 'Updated'} ${r.path}`)
  }
}

main().catch((err) => {
  console.error(err.message || err)
  process.exitCode = 1
})
