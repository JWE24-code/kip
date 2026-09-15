// Live vault watcher (AD-15). Watcher events are only *hints* — every event
// is re-checked against the disk, which is the source of truth. On boot (and
// on any watcher overflow / large burst) the whole vault is reconciled, so a
// kill mid-burst can never leave a phantom page behind.
//
// Two independent jobs share one watcher:
//   - nest/      -> change the derived index immediately (index the page /
//                   drop its vectors), no LLM involved.
//   - pages/ +   -> source material the user dropped/edited; we don't hatch
//     journals/     here (that's the app's call), we hand the dirty paths to
//                   `onSourceDirty` so the sidecar can batch a Hatch.
const fs = require('node:fs')
const path = require('node:path')
const chokidar = require('chokidar')
const matter = require('gray-matter')
const { indexPage, removePageVectors, reconcileVectors } = require('./vector-index')
const { upsertPage, removePage, summarizeSection } = require('./roost')
const { rebuildRoost } = require('../rebuild-roost')
const { getEmbedder } = require('./embeddings')
const { DEFAULT_VAULT_ROOT, nestPath, pagesPath, DIR_TYPES } = require('./paths')

const DEFAULT_DEBOUNCE_MS = 500
const AWAIT_WRITE_STABILITY_MS = 400
const AWAIT_WRITE_POLL_MS = 100
const PARSE_RETRY_DELAYS = [0, 200, 500]
const MAX_BURST = 200

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const NEST_DIRS = new Set(Object.keys(DIR_TYPES))

/**
 * Files that are never vault content: editor swap/backup files, the temp file
 * an atomic save writes before the rename, Office lock files, and the
 * sync-engine duplicate that a conflict creates. Watching them would index
 * half-written state or an entire parallel copy of the vault.
 */
function isIgnoredPath (filePath) {
  const base = path.basename(String(filePath))
  if (!base) return true
  if (base.startsWith('.')) return true
  if (base.startsWith('~$')) return true
  if (base.endsWith('~')) return true
  if (/\.(tmp|temp|swp|swx|part|crdownload|lock)$/i.test(base)) return true
  if (/\(conflicted copy/i.test(base)) return true
  return false
}

/** 'page' for a nest .md inside a known type dir, 'source' for pages/journals. */
function classifyPath (vaultRoot, filePath) {
  const abs = path.resolve(filePath)
  const nest = path.resolve(nestPath(vaultRoot))
  if (abs === nest || abs.startsWith(nest + path.sep)) {
    if (!abs.endsWith('.md')) return null
    const rel = path.relative(nest, abs).split(path.sep)
    if (rel.length !== 2 || !NEST_DIRS.has(rel[0])) return null
    return 'page'
  }
  for (const dir of [pagesPath(vaultRoot), path.join(vaultRoot, 'journals')]) {
    const root = path.resolve(dir)
    if (abs === root || abs.startsWith(root + path.sep)) return 'source'
  }
  return null
}

/**
 * Reads and parses a nest page, retrying a torn/parse-failing write at
 * +200/+500ms (SPEC-1 FR-10). Returns `{ data, content }`, or null when the
 * file is gone — callers treat null as "remove from the index". Throws only
 * after all retries fail, and the caller keeps the last-good index then.
 */
async function readPageDocument (abs) {
  let lastErr
  for (const delay of PARSE_RETRY_DELAYS) {
    if (delay) await sleep(delay)
    try {
      return matter(fs.readFileSync(abs, 'utf8'))
    } catch (err) {
      lastErr = err
      if (err.code === 'ENOENT') continue
    }
  }
  if (lastErr && lastErr.code === 'ENOENT') return null
  throw lastErr
}

/** The body of a nest page (frontmatter stripped), or null when it's gone. */
async function readPageBody (abs) {
  const doc = await readPageDocument(abs)
  return doc ? doc.content : null
}

/**
 * Starts the watcher. Returns a handle:
 *   { watcher, ready, reconcile(), handlePath(abs), close() }
 * `ready` resolves once chokidar has scanned the initial tree; `reconcile()` is
 * kicked off immediately (boot reconcile) and can be awaited.
 */
function startVaultWatcher ({
  vaultRoot = DEFAULT_VAULT_ROOT,
  embedder = getEmbedder(),
  debounceMs = DEFAULT_DEBOUNCE_MS,
  awaitWriteMs = AWAIT_WRITE_STABILITY_MS,
  pollMs = AWAIT_WRITE_POLL_MS,
  maxBurst = MAX_BURST,
  onPageIndexed = null,
  onSourceDirty = null,
  onError = null,
  logger = console
} = {}) {
  const roots = [nestPath(vaultRoot), pagesPath(vaultRoot), path.join(vaultRoot, 'journals')]
    .filter((dir) => fs.existsSync(dir))

  const pending = new Map()
  let debounceTimer = null
  let closed = false
  let reconciling = null

  const report = (err) => {
    if (onError) onError(err)
    else logger.error(`Warning: vault watcher error (${err && err.message ? err.message : err})`)
  }

  async function handlePage (abs) {
    const slug = path.basename(abs, '.md')
    const doc = await readPageDocument(abs)
    if (doc === null) {
      // Disk is truth: the file is gone, so both derived stores drop it.
      removePage(slug, vaultRoot)
      const removed = removePageVectors(slug, { vaultRoot, embedder })
      if (onPageIndexed) onPageIndexed({ slug, path: abs, removed, embedded: 0, deletedPage: true })
      return
    }
    const relPath = path.relative(vaultRoot, abs).split(path.sep).join('/')
    const dir = path.basename(path.dirname(abs))
    const type = doc.data.type || DIR_TYPES[dir] || 'concept'
    // Keep meta.db (pages + FTS + sections) in step with the file, then the
    // vectors — so a freshly edited page is searchable by both halves at once.
    upsertPage(
      slug, relPath, type, doc.data.tags || [],
      doc.data.summary || summarizeSection(doc.content),
      doc.content, vaultRoot, doc.data.aliases || []
    )
    const result = indexPage(slug, relPath, doc.content, { vaultRoot, embedder })
    if (onPageIndexed) onPageIndexed({ slug, path: relPath, ...result })
  }

  async function drain () {
    debounceTimer = null
    const items = [...pending.entries()]
    pending.clear()
    if (!items.length) return
    if (items.length > maxBurst) {
      // Watcher overflow / mass change: rescan instead of trusting the burst.
      await reconcile()
      return
    }
    const pages = []
    const sources = []
    for (const [abs, kind] of items) (kind === 'page' ? pages : sources).push(abs)
    for (const abs of pages) {
      try {
        await handlePage(abs)
      } catch (err) {
        // Keep the last-good index; the next event or the boot reconcile heals it.
        report(err)
      }
    }
    if (sources.length && onSourceDirty) {
      try {
        onSourceDirty(sources)
      } catch (err) {
        report(err)
      }
    }
  }

  const watcher = chokidar.watch(roots, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: awaitWriteMs, pollInterval: pollMs },
    ignored: (p) => isIgnoredPath(p)
  })

  const onEvent = (abs) => {
    if (closed) return
    const kind = classifyPath(vaultRoot, abs)
    if (!kind) return
    pending.set(abs, kind)
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => { drain().catch(report) }, debounceMs)
  }

  watcher.on('add', onEvent)
  watcher.on('change', onEvent)
  // 'unlink' is just another hint: drain() re-stats the path and removes it if
  // it is still gone, so a replace-by-rename settles on the final disk state.
  watcher.on('unlink', onEvent)
  watcher.on('error', report)

  const ready = new Promise((resolve) => watcher.once('ready', resolve))

  function reconcile () {
    if (!reconciling) {
      reconciling = Promise.resolve()
        .then(() => {
          // Full boot reconcile treats the disk as truth for both stores:
          // meta.db (rebuild-roost) and the block vectors.
          const roost = rebuildRoost(vaultRoot)
          const vectors = reconcileVectors(vaultRoot, { embedder })
          return { ...roost, ...vectors }
        })
        .finally(() => { reconciling = null })
    }
    return reconciling
  }

  async function close () {
    closed = true
    if (debounceTimer) clearTimeout(debounceTimer)
    await watcher.close()
    await reconciling
  }

  // Boot reconcile is the source of truth; don't await it here so callers can
  // set up before a large vault finishes scanning.
  reconcile().catch(report)

  return {
    watcher,
    ready,
    reconcile,
    handlePath: async (abs) => {
      const kind = classifyPath(vaultRoot, abs)
      if (kind === 'page') await handlePage(abs)
      else if (kind === 'source' && onSourceDirty) onSourceDirty([abs])
    },
    close
  }
}

module.exports = {
  startVaultWatcher,
  isIgnoredPath,
  classifyPath,
  readPageDocument,
  readPageBody,
  DEFAULT_DEBOUNCE_MS,
  MAX_BURST
}
