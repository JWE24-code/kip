#!/usr/bin/env node
// Live vault watcher / vector-index reconcile entry point.
//
//   node scripts/watch.js          watch coop/ and reindex on change
//   node scripts/watch.js --once   boot reconcile once, then exit
//   node scripts/watch.js --json   emit one JSON object per line (for the app)
const { startVaultWatcher } = require('./lib/watcher')
const { reconcileVectors, isVectorAvailable } = require('./lib/vector-index')
const { getEmbedder } = require('./lib/embeddings')
const { DEFAULT_VAULT_ROOT } = require('./lib/paths')

const args = new Set(process.argv.slice(2))
const once = args.has('--once')
const json = args.has('--json')
const embedder = getEmbedder()

function emit (event) {
  if (json) process.stdout.write(JSON.stringify(event) + '\n')
  else if (event.event === 'error') console.error(`watcher error: ${event.message}`)
  else console.log(JSON.stringify(event))
}

async function main () {
  if (!isVectorAvailable()) {
    emit({ event: 'warning', message: 'sqlite-vec is not available; running without the vector index.' })
  }

  if (once) {
    const result = reconcileVectors(DEFAULT_VAULT_ROOT, { embedder })
    emit({ event: 'reconciled', model: embedder.id, ...result })
    return
  }

  const handle = startVaultWatcher({
    vaultRoot: DEFAULT_VAULT_ROOT,
    embedder,
    onPageIndexed: (e) => emit({ event: 'indexed', ...e }),
    onSourceDirty: (paths) => emit({ event: 'sources-dirty', paths }),
    onError: (err) => emit({ event: 'error', message: String((err && err.message) || err) })
  })
  await handle.ready
  emit({ event: 'watching', root: DEFAULT_VAULT_ROOT, model: embedder.id })

  const shutdown = () => { handle.close().finally(() => process.exit(0)) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  emit({ event: 'error', message: err.message })
  process.exitCode = 1
})
