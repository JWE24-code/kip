const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { rebuildRoost } = require('../rebuild-roost')
const { planCandidates, ensureInEggs, humanizeFilename, collectPendingSources, meaningfulTextLength, mapLimit, commitHatchPlan, hatchAllSources, hatchWhiteboard } = require('../lib/hatch')
const { recordHatchedSource, getPage } = require('../lib/roost')
const { saveLLMConfig } = require('../lib/llm')
const { proposeAndDraftPages } = require('../lib/prompts')

/** Stub global.fetch (local OpenAI-compatible provider) to return `content` for every call; records request bodies. */
function stubFetch (respond) {
  const calls = []
  const original = global.fetch
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    const content = respond(body, calls.length)
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }) }
  }
  return { calls, restore: () => { global.fetch = original } }
}

function makeTempVault () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-hatch-test-'))
  for (const dir of ['nest/entities', 'nest/concepts', 'nest/sources', 'eggs', 'journals', 'pages', 'whiteboards', 'clucks', '.roost']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  return root
}

const MINI_BOARD = `{:blocks [
{:block/properties {:logseq.tldraw.shape {:type "box" :id "n1" :label "Idea" :point [0 0]}}}
{:block/properties {:logseq.tldraw.shape {:type "box" :id "n2" :label "Detail" :point [200 0]}}}
{:block/properties {:logseq.tldraw.shape {:type "line" :id "l1" :decorations {:end "arrow"} :handles {:start {:bindingId "s"} :end {:bindingId "e"}}}}}]
:pages [{:block/type "whiteboard" :block/name "brainstorm" :block/original-name "Brainstorm"
:block/properties {:logseq.tldraw.page {:name "Brainstorm" :bindings {:s {:fromId "l1" :toId "n1"} :e {:fromId "l1" :toId "n2"}}}}}]}`

function writePage (root, dir, slug, { type, tags = [], body = '' }) {
  const frontmatter = ['---', `type: ${type}`, 'created: 2026-01-01', 'updated: 2026-01-01', `tags: [${tags.join(', ')}]`, '---', ''].join('\n')
  fs.writeFileSync(path.join(root, 'nest', dir, `${slug}.md`), frontmatter + body + '\n')
}

test('humanizeFilename', () => {
  assert.equal(humanizeFilename('some-journal_export.md'), 'Some Journal Export')
})

test('ensureInEggs', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  await t.test('copies an external file into coop/eggs/', () => {
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hatch-src-'))
    const externalFile = path.join(externalDir, 'clipping.md')
    fs.writeFileSync(externalFile, 'some source content')

    const result = ensureInEggs(externalFile, root)
    assert.equal(result, path.join(root, 'eggs', 'clipping.md'))
    assert.equal(fs.readFileSync(result, 'utf8'), 'some source content')

    fs.rmSync(externalDir, { recursive: true, force: true })
  })

  await t.test('does not error when the source is already inside coop/eggs/', () => {
    const alreadyInEggs = path.join(root, 'eggs', 'already-there.md')
    fs.writeFileSync(alreadyInEggs, 'already here')
    const result = ensureInEggs(alreadyInEggs, root)
    assert.equal(result, alreadyInEggs)
    assert.equal(fs.readFileSync(result, 'utf8'), 'already here')
  })
})

test('mapLimit runs with bounded concurrency and preserves order', async () => {
  let active = 0
  let peak = 0
  const out = await mapLimit([10, 20, 30, 40, 50], 2, async (n) => {
    active++
    peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 5))
    active--
    return n * 2
  })
  assert.deepEqual(out, [20, 40, 60, 80, 100])
  assert.ok(peak <= 2, `peak concurrency ${peak} exceeded limit 2`)
  assert.deepEqual(await mapLimit([], 3, async () => 1), [])
})

test('meaningfulTextLength ignores frontmatter and list/markdown punctuation', () => {
  assert.equal(meaningfulTextLength('- \n'), 0)
  assert.equal(meaningfulTextLength('---\ntype: page\n---\n- \n'), 0)
  assert.ok(meaningfulTextLength('- a real sentence with some words in it') > 20)
})

test('collectPendingSources: buckets eggs/journals/pages by new-or-changed, size, and emptiness', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  fs.writeFileSync(path.join(root, 'eggs', 'clipping.md'), 'a source document with real content')
  fs.writeFileSync(path.join(root, 'journals', '2026_08_26.md'), '- had a meeting about the roadmap today')
  fs.writeFileSync(path.join(root, 'pages', 'Some Note.md'), '- a page with some genuine notes on it')
  fs.writeFileSync(path.join(root, 'pages', 'stub.md'), '- ') // near-empty — skipped
  fs.writeFileSync(path.join(root, 'pages', 'huge.md'), 'x'.repeat(1024 * 1024 + 1)) // over the ~1 MB backstop — skipped
  fs.writeFileSync(path.join(root, 'pages', 'notes.txt'), 'not markdown, outside eggs/ — ignored')
  fs.writeFileSync(path.join(root, 'journals', '.DS_Store'), '') // dotfile — ignored

  let { pending, oversized, empty } = collectPendingSources(root)
  assert.deepEqual(pending.map((p) => p.relPath), ['eggs/clipping.md', 'journals/2026_08_26.md', 'pages/Some Note.md'])
  assert.deepEqual(oversized.map((o) => o.relPath), ['pages/huge.md'])
  assert.deepEqual(empty, ['pages/stub.md'])

  // Record one as hatched at its current content -> it drops out of pending.
  const { hashContent } = require('../lib/roost')
  recordHatchedSource('eggs/clipping.md', hashContent(fs.readFileSync(path.join(root, 'eggs', 'clipping.md'), 'utf8')), root)
  ;({ pending } = collectPendingSources(root))
  assert.deepEqual(pending.map((p) => p.relPath), ['journals/2026_08_26.md', 'pages/Some Note.md'])

  // Change its content -> it comes back as pending.
  fs.writeFileSync(path.join(root, 'eggs', 'clipping.md'), 'a source document with real content, now extended')
  ;({ pending } = collectPendingSources(root))
  assert.ok(pending.map((p) => p.relPath).includes('eggs/clipping.md'))
})

test('collectPendingSources: no source dirs -> everything empty', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-bare-'))
  try {
    assert.deepEqual(collectPendingSources(root), { pending: [], oversized: [], empty: [] })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('commitHatchPlan: regenIndex:false skips the index.md rewrite (batch callers regen once)', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  rebuildRoost(root)

  const indexPath = path.join(root, 'nest', 'index.md')
  if (fs.existsSync(indexPath)) fs.rmSync(indexPath)

  // An empty plan makes no LLM calls and writes no pages — enough to prove
  // whether the index.md rewrite fires.
  await commitHatchPlan({ plan: [], sourceTitle: 'X', sourceContent: 'x' }, root, { regenIndex: false })
  assert.equal(fs.existsSync(indexPath), false, 'index.md must not be written when regenIndex:false')

  await commitHatchPlan({ plan: [], sourceTitle: 'X', sourceContent: 'x' }, root)
  assert.equal(fs.existsSync(indexPath), true, 'index.md is written by default')
})

test('collectPendingSources buckets a whiteboards/*.edn as kind "whiteboard"', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  fs.writeFileSync(path.join(root, 'whiteboards', 'Brainstorm.edn'), MINI_BOARD)
  fs.writeFileSync(path.join(root, 'whiteboards', 'notes.md'), '# not an edn') // ignored — .edn only here

  const { pending } = collectPendingSources(root)
  const wb = pending.find((p) => p.relPath === 'whiteboards/Brainstorm.edn')
  assert.ok(wb, 'the .edn is pending')
  assert.equal(wb.kind, 'whiteboard')
  assert.ok(!pending.some((p) => p.relPath.endsWith('notes.md')))
})

test('hatchWhiteboard: deterministic Outline + LLM Context section, full replace on re-run', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writePage(root, 'concepts', 'idea', { type: 'concept', body: 'An idea being tracked.' })
  rebuildRoost(root)
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  const boardPath = path.join(root, 'whiteboards', 'Brainstorm.edn')
  fs.writeFileSync(boardPath, MINI_BOARD)

  const { calls, restore } = stubFetch(() => JSON.stringify({
    summary: 'A two-node brainstorm about the idea and its detail.',
    context: 'The map is one idea broken into a single detail. Relates to [[idea]].'
  }))
  try {
    const r1 = await hatchWhiteboard(boardPath, root)
    assert.equal(r1.action, 'create')
    assert.equal(r1.path, 'nest/sources/brainstorm.md')
    assert.equal(r1.enriched, true)
    assert.equal(calls.length, 1, 'one LLM call for the Context section')
    // the related-page search fed the matched concept page into the prompt
    assert.match(calls[0].messages[1].content, /Outline:\n- Idea/)
    assert.match(calls[0].messages[1].content, /matched node labels:\n- idea/)

    const md1 = fs.readFileSync(path.join(root, r1.path), 'utf8')
    assert.match(md1, /type: source/)
    assert.match(md1, /## Context\n\nThe map is one idea/)
    assert.match(md1, /## Outline\n\n- Idea\n {2}- Detail/)
    assert.match(md1, /\[\[idea\]\]/)
    assert.match(getPage('brainstorm', root).summary, /two-node brainstorm/, 'LLM summary used for meta.db')

    // change the board, re-hatch -> a full replace, not an _Update_ append
    fs.writeFileSync(boardPath, MINI_BOARD.replace('Detail', 'Refined detail'))
    const r2 = await hatchWhiteboard(boardPath, root)
    assert.equal(r2.action, 'update')
    const md2 = fs.readFileSync(path.join(root, r2.path), 'utf8')
    assert.match(md2, /- Idea\n {2}- Refined detail/)
    assert.ok(!md2.includes('_Update'), 'replace, not append')
    assert.ok(!md2.includes('- Detail\n'), 'old outline gone')
  } finally {
    restore()
  }
})

test('hatchWhiteboard: falls back to an outline-only page when the LLM call fails', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  rebuildRoost(root)
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  const boardPath = path.join(root, 'whiteboards', 'Brainstorm.edn')
  fs.writeFileSync(boardPath, MINI_BOARD)

  const { restore } = stubFetch(() => 'not json — the model flubbed it')
  try {
    const r = await hatchWhiteboard(boardPath, root)
    assert.equal(r.enriched, false)
    const md = fs.readFileSync(path.join(root, r.path), 'utf8')
    assert.ok(!md.includes('## Context'), 'no Context section')
    assert.match(md, /- Idea\n {2}- Detail/, 'outline still written')
    assert.equal(getPage('brainstorm', root).summary, 'Whiteboard: Brainstorm')
  } finally {
    restore()
  }
})

test('hatchAllSources — combined mode makes one LLM call per file and drafts bodies inline', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  rebuildRoost(root)
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  fs.writeFileSync(path.join(root, 'eggs', 'clinic-visit.md'),
    'Saw Dr. Alvarez on 2026-08-20 about sleep. Resting heart rate is trending down.')

  const { calls, restore } = stubFetch(() => JSON.stringify({
    pages: [
      { title: 'Clinic Visit', type: 'source', tags: ['health'], summary: 's', body: 'Visit notes. See [[dr-alvarez]].' },
      { title: 'Dr. Alvarez', type: 'entity', tags: ['doctor'], summary: 's', body: 'A physician the user sees.' }
    ]
  }))

  try {
    const summary = await hatchAllSources(root, { limit: 1 })
    assert.equal(calls.length, 1, 'exactly one LLM call for the file (propose + draft together)')
    assert.equal(summary.hatched.length, 1)
    assert.equal(summary.failed.length, 0)
    assert.deepEqual(summary.hatched[0].results.map((r) => r.slug).sort(), ['clinic-visit', 'dr-alvarez'])
    assert.match(fs.readFileSync(path.join(root, 'nest', 'entities', 'dr-alvarez.md'), 'utf8'), /A physician the user sees\./)
  } finally {
    restore()
  }
})

test('hatchAllSources — classic mode makes one propose call plus one generate call per page', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  rebuildRoost(root)
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  fs.writeFileSync(path.join(root, 'eggs', 'note.md'), 'Bought a Gaggia Classic espresso machine. It works well.')

  const kinds = []
  const { restore } = stubFetch((body) => {
    if (/three page types/.test(body.messages[0].content)) {
      kinds.push('propose')
      return JSON.stringify({ candidates: [
        { title: 'Note', type: 'source', tags: [], summary: 's' },
        { title: 'Gaggia Classic', type: 'entity', tags: [], summary: 's' }
      ] })
    }
    kinds.push('generate')
    return 'Some page body content.'
  })

  try {
    const summary = await hatchAllSources(root, { limit: 1, combined: false })
    assert.equal(summary.hatched.length, 1)
    assert.equal(kinds.filter((k) => k === 'propose').length, 1)
    assert.equal(kinds.filter((k) => k === 'generate').length, 2, 'one generate call per proposed page')
  } finally {
    restore()
  }
})

test('proposeAndDraftPages returns [] when the model never produces usable JSON', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  const { restore } = stubFetch(() => 'not json at all')
  try {
    assert.deepEqual(await proposeAndDraftPages('Some Title', 'some body text', root), [])
  } finally {
    restore()
  }
})

test('planCandidates reuses findSimilarSlug for create-vs-update, without writing anything', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  writePage(root, 'concepts', 'sleep-hygiene', {
    type: 'concept',
    tags: ['health'],
    body: 'Notes on sleep hygiene.'
  })
  rebuildRoost(root)

  const candidates = [
    { title: 'sleep-quality', type: 'concept', tags: ['health'], summary: 'about sleep quality' }, // near-duplicate of sleep-hygiene
    { title: 'Quarterly Tax Filing', type: 'concept', tags: ['finance'], summary: 'unrelated' } // genuinely new
  ]

  const plan = planCandidates(candidates, root)

  const sleepPlan = plan.find((p) => p.title === 'sleep-quality')
  assert.equal(sleepPlan.action, 'update')
  assert.equal(sleepPlan.slug, 'sleep-hygiene')
  assert.ok(sleepPlan.similarity > 0.3)

  const taxPlan = plan.find((p) => p.title === 'Quarterly Tax Filing')
  assert.equal(taxPlan.action, 'create')
  assert.equal(taxPlan.slug, 'quarterly-tax-filing')

  // planCandidates must be pure planning — confirm nothing was written to disk.
  assert.equal(fs.existsSync(path.join(root, 'nest', 'concepts', 'quarterly-tax-filing.md')), false)
  const untouched = fs.readFileSync(path.join(root, 'nest', 'concepts', 'sleep-hygiene.md'), 'utf8')
  assert.ok(!untouched.includes('_Update'), 'existing page must be untouched until confirmation + write phase')
})
