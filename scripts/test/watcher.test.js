const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { startVaultWatcher, isIgnoredPath, classifyPath, readPageBody } = require('../lib/watcher')
const { createHashedEmbedder } = require('../lib/embeddings')
const { countVectors, isVectorAvailable } = require('../lib/vector-index')

const skip = !isVectorAvailable()

function makeTempVault () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-watch-'))
  for (const dir of ['nest/entities', 'nest/concepts', 'nest/sources', 'pages', 'journals', '.roost']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  return root
}

function writePage (root, dir, slug, body) {
  const rel = path.join('nest', dir, `${slug}.md`)
  fs.writeFileSync(path.join(root, rel), `---\ntype: concept\n---\n\n${body}\n`)
  return path.join(root, rel)
}

test('isIgnoredPath: sync-engine and editor artifacts are not vault content', () => {
  assert.equal(isIgnoredPath('/v/.hidden.md'), true)
  assert.equal(isIgnoredPath('/v/~$budget.docx'), true)
  assert.equal(isIgnoredPath('/v/note.tmp'), true)
  assert.equal(isIgnoredPath('/v/note.md~'), true)
  assert.equal(isIgnoredPath('/v/.note.md.swp'), true)
  assert.equal(isIgnoredPath('/v/note (Conflicted copy 2026-01-02).md'), true)
  assert.equal(isIgnoredPath('/v/note.md'), false)
  assert.equal(isIgnoredPath('/v/budget.docx'), false)
})

test('classifyPath: only nest type-dir markdown is a page; pages/journals are sources', () => {
  const root = '/vault'
  assert.equal(classifyPath(root, '/vault/nest/concepts/x.md'), 'page')
  assert.equal(classifyPath(root, '/vault/nest/entities/y.md'), 'page')
  assert.equal(classifyPath(root, '/vault/nest/index.md'), null, 'generated root index is not a page')
  assert.equal(classifyPath(root, '/vault/nest/concepts/readme.txt'), null)
  assert.equal(classifyPath(root, '/vault/pages/drop.md'), 'source')
  assert.equal(classifyPath(root, '/vault/journals/2026_01_01.md'), 'source')
  assert.equal(classifyPath(root, '/vault/exports/deck.pptx'), null)
})

test('readPageBody: returns the body, or null once the file is gone', { skip }, async () => {
  const root = makeTempVault()
  try {
    const abs = writePage(root, 'concepts', 'sleep', '- Consistent bedtime')
    const body = await readPageBody(abs)
    assert.match(body, /Consistent bedtime/)
    fs.rmSync(abs)
    assert.equal(await readPageBody(abs), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('watcher: boot reconcile indexes the vault, and handlePath tracks edits', { skip }, async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const embedder = createHashedEmbedder({ dimensions: 128 })

  const abs = writePage(root, 'concepts', 'sleep', '- Consistent bedtime')
  const handle = startVaultWatcher({ vaultRoot: root, embedder, debounceMs: 20, awaitWriteMs: 30, pollMs: 10 })
  t.after(() => handle.close())

  const boot = await handle.reconcile()
  assert.equal(boot.pages, 1)
  assert.equal(countVectors({ vaultRoot: root, embedder }), 1)

  // An edit through the same path re-embeds exactly the changed block.
  fs.writeFileSync(abs, '---\ntype: concept\n---\n\n- Consistent bedtime\n- No screens after 22:00\n')
  await handle.handlePath(abs)
  assert.equal(countVectors({ vaultRoot: root, embedder }), 2)

  // Removing the page drops its vectors.
  fs.rmSync(abs)
  await handle.handlePath(abs)
  assert.equal(countVectors({ vaultRoot: root, embedder }), 0)
})

test('watcher: a live write is reindexed without any manual call', { skip }, async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const embedder = createHashedEmbedder({ dimensions: 128 })

  let resolveIndexed
  const indexed = new Promise((resolve) => { resolveIndexed = resolve })
  const handle = startVaultWatcher({
    vaultRoot: root,
    embedder,
    debounceMs: 20,
    awaitWriteMs: 30,
    pollMs: 10,
    onPageIndexed: (e) => resolveIndexed(e)
  })
  t.after(() => handle.close())
  await handle.ready

  writePage(root, 'concepts', 'live-edit', '- A freshly written fact')
  const event = await Promise.race([
    indexed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('watcher did not emit within 5s')), 5000))
  ])
  assert.equal(event.slug, 'live-edit')
  assert.equal(event.embedded, 1)
  assert.equal(countVectors({ vaultRoot: root, embedder }), 1)
})
