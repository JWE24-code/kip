const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { rebuildRoost } = require('../rebuild-roost')
const { planCandidates, ensureInSources, humanizeFilename, collectPendingSources, meaningfulTextLength, mapLimit, groupByByteBudget, commitHatchPlan, hatchAllSources, hatchWhiteboard, proposeNextPending, commitReviewedPlan, proposeNextPendingGroup, commitReviewedPlanGroup, pendingSourcesSummary, prepareSources, MAX_GROUP_BYTES } = require('../lib/hatch')
const { recordHatchedSource, getPage } = require('../lib/roost')
const { saveLLMConfig } = require('../lib/llm')
const { proposeAndDraftPages, proposeAndDraftPagesBatch } = require('../lib/prompts')

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

/** A propose+draft stub that answers both the single-source and the batched
 *  prompt shapes, one type:'source' page per source (titled after its label). */
function proposeResponse (body) {
  const system = (body.messages[0] && body.messages[0].content) || ''
  const prompt = (body.messages[1] && body.messages[1].content) || ''
  const pageFor = (title) => ({ title, type: 'source', tags: [], summary: 's', body: `${title} body.` })
  if (/ingesting MULTIPLE/.test(system)) {
    const titles = [...prompt.matchAll(/--- Source \d+: "([^"]+)"/g)].map((m) => m[1])
    return JSON.stringify({ sources: titles.map((title) => ({ pages: [pageFor(title)] })) })
  }
  const m = prompt.match(/Source title: ([^\n]+)/)
  return JSON.stringify({ pages: m ? [pageFor(m[1].trim())] : [] })
}

function makeTempVault () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-hatch-test-'))
  for (const dir of ['nest/entities', 'nest/concepts', 'nest/sources', 'pages', 'journals', 'whiteboards', 'clucks', '.roost']) {
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

test('ensureInSources', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  await t.test('copies an external file into coop/pages/', () => {
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hatch-src-'))
    const externalFile = path.join(externalDir, 'clipping.md')
    fs.writeFileSync(externalFile, 'some source content')

    const result = ensureInSources(externalFile, root)
    assert.equal(result, path.join(root, 'pages', 'clipping.md'))
    assert.equal(fs.readFileSync(result, 'utf8'), 'some source content')

    fs.rmSync(externalDir, { recursive: true, force: true })
  })

  await t.test('does not error when the source is already inside coop/pages/', () => {
    const alreadyInSources = path.join(root, 'pages', 'already-there.md')
    fs.writeFileSync(alreadyInSources, 'already here')
    const result = ensureInSources(alreadyInSources, root)
    assert.equal(result, alreadyInSources)
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

test('groupByByteBudget packs in order under the budget, solos the oversized, never groups a whiteboard', () => {
  const f = (name, bytes, kind = 'pages') => ({ relPath: name, bytes, kind })

  // exactly at budget stays in one group; one byte over splits
  assert.deepEqual(
    groupByByteBudget([f('a', 100), f('b', 100)], 200),
    [[f('a', 100), f('b', 100)]]
  )
  assert.deepEqual(
    groupByByteBudget([f('a', 100), f('b', 101)], 200),
    [[f('a', 100)], [f('b', 101)]]
  )

  // a file over budget is its own group and doesn't drag its neighbours in
  assert.deepEqual(
    groupByByteBudget([f('small', 10), f('huge', 500), f('small2', 10)], 200),
    [[f('small', 10)], [f('huge', 500)], [f('small2', 10)]]
  )

  // a whiteboard is always solo, even when it would fit with neighbours
  assert.deepEqual(
    groupByByteBudget([f('a', 10), f('board', 10, 'whiteboard'), f('b', 10)], 200),
    [[f('a', 10)], [f('board', 10, 'whiteboard')], [f('b', 10)]]
  )

  assert.deepEqual(groupByByteBudget([], MAX_GROUP_BYTES), [])
})

test('meaningfulTextLength ignores frontmatter and list/markdown punctuation', () => {
  assert.equal(meaningfulTextLength('- \n'), 0)
  assert.equal(meaningfulTextLength('---\ntype: page\n---\n- \n'), 0)
  assert.ok(meaningfulTextLength('- a real sentence with some words in it') > 20)
})

test('collectPendingSources: buckets pages/journals by new-or-changed, size, and emptiness', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  fs.writeFileSync(path.join(root, 'pages', 'clipping.md'), 'a source document with real content')
  fs.writeFileSync(path.join(root, 'journals', '2026_08_26.md'), '- had a meeting about the roadmap today')
  fs.writeFileSync(path.join(root, 'pages', 'Some Note.md'), '- a page with some genuine notes on it')
  fs.writeFileSync(path.join(root, 'pages', 'stub.md'), '- ') // near-empty — skipped
  fs.writeFileSync(path.join(root, 'pages', 'huge.md'), 'x'.repeat(1024 * 1024 + 1)) // over the ~1 MB backstop — skipped
  fs.writeFileSync(path.join(root, 'pages', 'notes.txt'), 'not markdown — skipped by the scan (prepareSources turns it into a stub in the full flow)')
  fs.writeFileSync(path.join(root, 'journals', '.DS_Store'), '') // dotfile — ignored

  let { pending, oversized, empty } = collectPendingSources(root)
  assert.deepEqual(pending.map((p) => p.relPath), ['journals/2026_08_26.md', 'pages/clipping.md', 'pages/Some Note.md'])
  assert.deepEqual(oversized.map((o) => o.relPath), ['pages/huge.md'])
  assert.deepEqual(empty, ['pages/stub.md'])

  // Record one as hatched at its current content -> it drops out of pending.
  const { hashContent } = require('../lib/roost')
  recordHatchedSource('pages/clipping.md', hashContent(fs.readFileSync(path.join(root, 'pages', 'clipping.md'), 'utf8')), root)
  ;({ pending } = collectPendingSources(root))
  assert.deepEqual(pending.map((p) => p.relPath), ['journals/2026_08_26.md', 'pages/Some Note.md'])

  // Change its content -> it comes back as pending.
  fs.writeFileSync(path.join(root, 'pages', 'clipping.md'), 'a source document with real content, now extended')
  ;({ pending } = collectPendingSources(root))
  assert.ok(pending.map((p) => p.relPath).includes('pages/clipping.md'))
})

test('collectPendingSources: no source dirs -> everything empty', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-bare-'))
  try {
    assert.deepEqual(collectPendingSources(root), { pending: [], oversized: [], empty: [], errors: [] })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('collectPendingSources: skips a source whose trace hub exists (Dropbox-sync idempotency)', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  // A source hatched on another device: the source file AND its trace hub
  // synced over, but this device's hatched_sources cache is empty (it isn't
  // what Dropbox syncs — the nest is).
  fs.writeFileSync(path.join(root, 'pages', 'report.md'), 'a report with real content worth hatching')
  const hub = [
    '---', 'type: source', 'source: pages/report.md',
    'created: 2026-01-01', 'updated: 2026-01-01', 'tags: []', '---',
    '', '## Source', '', '- Source file: `pages/report.md`', ''
  ].join('\n')
  fs.writeFileSync(path.join(root, 'nest', 'sources', 'report.md'), hub)

  // No hatched_sources row — this device never hatched it locally. The trace
  // hub is the cross-device signal that it's already hatched, so it's skipped.
  let { pending } = collectPendingSources(root)
  assert.deepEqual(pending, [])

  // A manual re-hatch (--force) still picks it up.
  ;({ pending } = collectPendingSources(root, { force: true }))
  assert.deepEqual(pending.map((p) => p.relPath), ['pages/report.md'])
})

test('prepareSources: unsupported formats become a reference-only .md stub (idempotent)', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  fs.writeFileSync(path.join(root, 'pages', 'archive.zip'), 'PK\u0003\u0004 some binary bytes')

  const first = await prepareSources(root)
  assert.equal(first.converted.length, 0)
  assert.equal(first.failed.length, 0)
  assert.deepEqual(first.stubbed.map((s) => s.source), ['archive.zip'])

  const stub = fs.readFileSync(path.join(root, 'pages', 'archive.md'), 'utf8')
  assert.match(stub, /source: "archive\.zip"/)
  assert.match(stub, /source_format: binary/)
  assert.match(stub, /## Source\n\n- Original file: `archive\.zip`/)
  assert.match(stub, /No extractable text for this format/)

  // a second run must not re-stub: the up-to-date .md is left alone
  const second = await prepareSources(root)
  assert.deepEqual(second.stubbed, [])
  assert.equal(second.converted.length, 0)
  assert.equal(second.failed.length, 0)
})

test('migrate-eggs-to-pages: moves files, dedupes identical copies, rewrites hatched_sources', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'eggs'), { recursive: true })
  const { migrate } = require('../migrate-eggs-to-pages')
  const { hashContent } = require('../lib/roost')

  // a source that was already hatched (has a hatched_sources row)
  fs.writeFileSync(path.join(root, 'eggs', 'clipping.md'), 'a source with content')
  recordHatchedSource('eggs/clipping.md', hashContent('a source with content'), root)
  // …and its trace hub names the old eggs/ path (frontmatter + body)
  fs.writeFileSync(path.join(root, 'nest', 'sources', 'clipping.md'),
    '---\ntype: source\nsource: eggs/clipping.md\ncreated: 2026-01-01\nupdated: 2026-01-01\ntags: []\n---\n## Source\n\n- Source file: `eggs/clipping.md`\n')

  // an identical duplicate already in pages/
  fs.writeFileSync(path.join(root, 'pages', 'dup.md'), 'duplicate content')
  fs.writeFileSync(path.join(root, 'eggs', 'dup.md'), 'duplicate content')

  // a name collision with different content
  fs.writeFileSync(path.join(root, 'pages', 'conflict.md'), 'pages version')
  fs.writeFileSync(path.join(root, 'eggs', 'conflict.md'), 'eggs version')

  const result = migrate(root)
  assert.deepEqual(result.moved, ['clipping.md'])
  assert.deepEqual(result.deduped, ['dup.md'])
  assert.deepEqual(result.conflicts, [{ from: 'conflict.md', to: 'conflict-egg.md' }])

  assert.ok(fs.existsSync(path.join(root, 'pages', 'clipping.md')))
  assert.ok(!fs.existsSync(path.join(root, 'eggs')), 'eggs/ removed once empty')
  assert.equal(fs.readFileSync(path.join(root, 'pages', 'conflict.md'), 'utf8'), 'pages version')
  assert.equal(fs.readFileSync(path.join(root, 'pages', 'conflict-egg.md'), 'utf8'), 'eggs version')

  // hatched_sources path moved with the file → not re-hatched
  const { hatchedSourceHashes } = require('../lib/roost')
  assert.ok(hatchedSourceHashes(root).has('pages/clipping.md'))
  assert.ok(!hatchedSourceHashes(root).has('eggs/clipping.md'))

  // the trace hub's `source:` frontmatter + body reference moved too → the
  // 0.4.8 trace-hub idempotency check still recognizes it as already hatched
  const { hatchedSourcePaths } = require('../lib/pages')
  assert.ok(hatchedSourcePaths(root).has('pages/clipping.md'))
  assert.ok(!hatchedSourcePaths(root).has('eggs/clipping.md'))
  const hub = fs.readFileSync(path.join(root, 'nest', 'sources', 'clipping.md'), 'utf8')
  assert.ok(hub.includes('source: pages/clipping.md'))
  assert.ok(hub.includes('`pages/clipping.md`'))
  assert.ok(!hub.includes('eggs/clipping.md'))
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

test('commitHatchPlan applies the combined draft\'s section one-liners to the section index', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  rebuildRoost(root)

  const plan = [{
    slug: 'sleep',
    title: 'sleep',
    type: 'concept',
    action: 'create',
    tags: [],
    summary: 'Sleep habits',
    body: 'Intro line.\n\n## Hygiene\nKeep a consistent bedtime.\n\n## Screens\nNo screens late.',
    sections: [{ heading: 'Hygiene', summary: 'The user keeps a fixed bedtime and wake time.' }]
  }]

  await commitHatchPlan({ plan, sourceTitle: 'Sleep Notes', sourceContent: 'notes', sourceRelPath: 'pages/sleep.md' }, root)

  const { getPageSections } = require('../lib/roost')
  const sections = getPageSections('sleep', root)
  assert.equal(sections.find((s) => s.heading === 'Hygiene').summary, 'The user keeps a fixed bedtime and wake time.')
  assert.equal(sections.find((s) => s.heading === 'Screens').summary, 'No screens late.', 'unmatched heading keeps its first-line summary')
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

  fs.writeFileSync(path.join(root, 'pages', 'clinic-visit.md'),
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

test('hatchAllSources — groups small pending files into one combined call and commits them all', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  rebuildRoost(root)
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  fs.writeFileSync(path.join(root, 'pages', 'a.md'), 'About the Alpha project and its launch plans.')
  fs.writeFileSync(path.join(root, 'pages', 'b.md'), 'About the Beta initiative and its rollout.')

  const { calls, restore } = stubFetch((body) => {
    const system = (body.messages[0] && body.messages[0].content) || ''
    const prompt = (body.messages[1] && body.messages[1].content) || ''
    // The combined prompt lists the group's sources in order; echo one source
    // entry per label so the batch stays aligned 1:1.
    if (/ingesting MULTIPLE/.test(system)) {
      const titles = [...prompt.matchAll(/--- Source \d+: "([^"]+)"/g)].map((m) => m[1])
      return JSON.stringify({ sources: titles.map((title) => ({
        pages: [{ title: title === 'A' ? 'Alpha' : 'Beta', type: 'source', tags: [], summary: 's', body: `${title} notes.` }]
      })) })
    }
    return JSON.stringify({ pages: [] })
  })

  try {
    const summary = await hatchAllSources(root, { limit: 2 })
    assert.equal(summary.hatched.length, 2, 'both files hatched')
    assert.equal(summary.failed.length, 0)
    assert.equal(calls.length, 1, 'both small files share one grouped propose+draft call')
    assert.ok(summary.hatched.some((h) => h.source === 'A') && summary.hatched.some((h) => h.source === 'B'))
  } finally {
    restore()
  }
})

test('hatchAllSources — one LLM call per byte group, ceil(N/groupSize)', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  rebuildRoost(root)
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  // Four equal 300-byte files; a 600-byte budget fits exactly two per group.
  for (const name of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(root, 'pages', `${name}.md`), 'x'.repeat(300))

  const { calls, restore } = stubFetch(proposeResponse)
  try {
    const summary = await hatchAllSources(root, { limit: 4, groupBytes: 600 })
    assert.equal(summary.hatched.length, 4)
    assert.equal(summary.failed.length, 0)
    assert.equal(calls.length, 2, 'ceil(4 files / 2 per group) = 2 combined calls')
    assert.ok(calls.every((c) => /ingesting MULTIPLE/.test(c.messages[0].content)), 'both calls use the combined prompt')
  } finally {
    restore()
  }
})

test('hatchAllSources — an over-budget file is proposed solo and does not block grouping the rest', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  rebuildRoost(root)
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  fs.writeFileSync(path.join(root, 'pages', 'aaa.md'), 'small one '.repeat(5))
  fs.writeFileSync(path.join(root, 'pages', 'bbb.md'), 'small two '.repeat(5))
  // ~195 KB, over the 150 KB default budget but under the 1 MB backstop.
  fs.writeFileSync(path.join(root, 'pages', 'big.md'), 'big '.repeat(50000))
  fs.writeFileSync(path.join(root, 'pages', 'ccc.md'), 'small three '.repeat(5))

  const { calls, restore } = stubFetch(proposeResponse)
  try {
    const summary = await hatchAllSources(root, { limit: 4 })
    assert.equal(summary.hatched.length, 4, 'the oversized file still hatches, solo')
    const batched = calls.filter((c) => /ingesting MULTIPLE/.test(c.messages[0].content))
    const solo = calls.filter((c) => !/ingesting MULTIPLE/.test(c.messages[0].content))
    // aaa+bbb group (1 batched call), big solo, ccc solo.
    assert.equal(batched.length, 1, 'the small files around the oversized one still group')
    assert.equal(solo.length, 2, 'the oversized file takes the single-file path')
  } finally {
    restore()
  }
})

test('hatchAllSources — grouping is a call-count optimization: results match the per-file path', async (t) => {
  const make = () => {
    const root = makeTempVault()
    rebuildRoost(root)
    saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)
    fs.writeFileSync(path.join(root, 'pages', 'one.md'), 'Notes about the One project and its goals.')
    fs.writeFileSync(path.join(root, 'pages', 'two.md'), 'Notes about the Two project and its plans.')
    fs.writeFileSync(path.join(root, 'pages', 'three.md'), 'Notes about the Three project and its scope.')
    return root
  }
  const soloRoot = make()
  const groupedRoot = make()
  t.after(() => {
    fs.rmSync(soloRoot, { recursive: true, force: true })
    fs.rmSync(groupedRoot, { recursive: true, force: true })
  })

  // groupBytes: 1 forces every file into its own group — the pre-change
  // one-call-per-file path. The default groups all three into one call.
  let s = stubFetch(proposeResponse)
  let soloSummary
  try { soloSummary = await hatchAllSources(soloRoot, { limit: 3, groupBytes: 1 }) } finally { s.restore() }
  s = stubFetch(proposeResponse)
  let groupedSummary
  try { groupedSummary = await hatchAllSources(groupedRoot, { limit: 3 }) } finally { s.restore() }

  const shape = (summary) => summary.hatched
    .map((h) => ({ source: h.source, results: h.results.map((r) => `${r.action}:${r.slug}`).sort(), skipped: h.skipped }))
    .sort((a, b) => a.source.localeCompare(b.source))
  assert.deepEqual(shape(groupedSummary), shape(soloSummary))
  assert.deepEqual(groupedSummary.failed, soloSummary.failed)
})

test('hatchAllSources — no pending files makes no LLM calls', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  rebuildRoost(root)
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  const { calls, restore } = stubFetch(proposeResponse)
  try {
    const summary = await hatchAllSources(root, { limit: 5 })
    assert.equal(calls.length, 0)
    assert.deepEqual(summary.hatched, [])
    assert.deepEqual(summary.failed, [])
    assert.equal(summary.remaining, 0)
  } finally {
    restore()
  }
})

test('hatchAllSources — classic mode makes one propose call plus one generate call per page', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  rebuildRoost(root)
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  fs.writeFileSync(path.join(root, 'pages', 'note.md'), 'Bought a Gaggia Classic espresso machine. It works well.')

  const kinds = []
  const { restore } = stubFetch((body) => {
    if (/four page types/.test(body.messages[0].content)) {
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

test('combined-path update is regenerated against the existing page, not restated (#114)', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writePage(root, 'concepts', 'sleep-quality', { type: 'concept', tags: ['health'], body: 'Original notes: sleeping about 8h a night.' })
  rebuildRoost(root)
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  fs.writeFileSync(path.join(root, 'pages', 'sleep-log.md'), 'This month sleep dropped to 6h a night on average.')

  const seen = []
  const { restore } = stubFetch((body) => {
    const sys = body.messages.map((m) => m.content).join('\n')
    if (/in a single step/.test(sys)) {
      seen.push('draft')
      return JSON.stringify({ pages: [
        { title: 'sleep quality', type: 'concept', tags: ['health'], summary: 's', body: 'A full restatement of everything about the user\'s sleep, now 6h.' },
        { title: 'Sleep Log', type: 'source', tags: [], summary: 's', body: 'Log notes. See [[sleep-quality]].' }
      ] })
    }
    if (/extending an existing wiki page/.test(sys)) {
      seen.push('update-generate')
      assert.match(sys, /Original notes: sleeping about 8h a night\./, 'the update call is given the existing page body')
      return 'Sleep dropped to ~6h/night this month, down from the ~8h noted earlier.'
    }
    seen.push('unexpected')
    return 'x'
  })

  try {
    const summary = await hatchAllSources(root, { limit: 1 })
    assert.equal(summary.failed.length, 0)
    // one combined draft + one existing-content-aware regenerate for the
    // update; the pure-create source hub keeps its drafted body (no 2nd call).
    assert.deepEqual(seen.sort(), ['draft', 'update-generate'])

    const md = fs.readFileSync(path.join(root, 'nest', 'concepts', 'sleep-quality.md'), 'utf8')
    assert.match(md, /_Update \d{4}-\d{2}-\d{2}:_/, 'appended as a dated delta')
    assert.match(md, /down from the ~8h/, 'the delta body is written')
    assert.doesNotMatch(md, /A full restatement/, 'the source-only combined draft is not used for the update')
  } finally {
    restore()
  }
})

test('#114 does not touch source pages: a re-hatched source hub still uses its drafted body', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  rebuildRoost(root)
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)
  fs.writeFileSync(path.join(root, 'pages', 'report.md'), 'First version of the quarterly report.')

  const gen = () => JSON.stringify({ pages: [{ title: 'Report', type: 'source', tags: [], summary: 's', body: 'Report hub. Links [[q3-numbers]].' }] })
  let s = stubFetch(gen)
  try { await hatchAllSources(root, { limit: 1 }) } finally { s.restore() }

  // edit the source and re-hatch — the hub resolves to action=update
  fs.writeFileSync(path.join(root, 'pages', 'report.md'), 'Second version of the quarterly report, now with more detail.')
  const kinds = []
  s = stubFetch((body) => {
    const sys = body.messages.map((m) => m.content).join('\n')
    kinds.push(/in a single step/.test(sys) ? 'draft' : /extending an existing wiki page/.test(sys) ? 'generate-update' : 'other')
    return gen()
  })
  try {
    // A re-hatch is now opt-in (--force): by default a file with a trace hub
    // is left alone. Force it here to exercise the source-hub update path.
    await hatchAllSources(root, { limit: 1, force: true })
    assert.deepEqual(kinds, ['draft'], 'no existing-content generate call for a source-type update')
  } finally { s.restore() }
})

test('review mode: proposeNextPending stashes a plan and writes nothing; commitReviewedPlan honours keepSlugs', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  rebuildRoost(root)
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  fs.writeFileSync(path.join(root, 'pages', 'clinic-visit.md'),
    'Saw Dr. Alvarez on 2026-08-20 about sleep. Resting heart rate is trending down.')

  const { calls, restore } = stubFetch(() => JSON.stringify({
    pages: [
      { title: 'Clinic Visit', type: 'source', tags: ['health'], summary: 's', body: 'Visit notes. See [[dr-alvarez]].' },
      { title: 'Dr. Alvarez', type: 'entity', tags: ['doctor'], summary: 's', body: 'A physician the user sees.' }
    ]
  }))

  try {
    const proposal = await proposeNextPending(root, {})
    assert.equal(proposal.source, 'Clinic Visit')
    assert.equal(proposal.remaining, 0)
    assert.deepEqual(proposal.plan.map((p) => p.slug).sort(), ['clinic-visit', 'dr-alvarez'])
    assert.equal(calls.length, 1, 'one propose+draft call')
    // nothing written yet
    assert.ok(!fs.existsSync(path.join(root, 'nest', 'entities', 'dr-alvarez.md')))
    assert.ok(fs.existsSync(path.join(root, '.roost', 'hatch-plan.json')), 'plan stashed')

    // keep only the entity page
    const result = await commitReviewedPlan(root, { keepSlugs: ['dr-alvarez'] })
    assert.deepEqual(result.results.map((r) => r.slug), ['dr-alvarez'])
    assert.ok(fs.existsSync(path.join(root, 'nest', 'entities', 'dr-alvarez.md')))
    assert.ok(!fs.existsSync(path.join(root, 'nest', 'sources', 'clinic-visit.md')), 'unchecked page not written')
    assert.ok(!fs.existsSync(path.join(root, '.roost', 'hatch-plan.json')), 'stash cleaned up')

    // the source is recorded as hatched -> not proposed again
    const next = await proposeNextPending(root, {})
    assert.equal(next.done, true)
  } finally {
    restore()
  }
})

test('review mode: commitReviewedPlan with an empty keep list still records the source as handled', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  rebuildRoost(root)
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)
  fs.writeFileSync(path.join(root, 'pages', 'skip-me.md'), 'A short note that the user decides not to hatch after all.')

  const { restore } = stubFetch(() => JSON.stringify({
    pages: [{ title: 'Skip Me', type: 'source', tags: [], summary: 's', body: 'Body.' }]
  }))
  try {
    await proposeNextPending(root, {})
    const result = await commitReviewedPlan(root, { keepSlugs: [] })
    assert.equal(result.keptNone, true)
    assert.ok(!fs.existsSync(path.join(root, 'nest', 'sources', 'skip-me.md')))
    assert.equal((await proposeNextPending(root, {})).done, true, 'not re-proposed')
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

test('proposeAndDraftPagesBatch returns one entry per source, in order, from a single call', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  const { calls, restore } = stubFetch(() => JSON.stringify({
    sources: [
      { pages: [{ title: 'One', type: 'source', tags: [], summary: 's', body: 'a' }] },
      { pages: [{ title: 'Two', type: 'source', tags: [], summary: 's', body: 'b' }] }
    ]
  }))
  try {
    const out = await proposeAndDraftPagesBatch([
      { sourceTitle: 'One', sourceContent: 'first source' },
      { sourceTitle: 'Two', sourceContent: 'second source' }
    ], root)
    assert.equal(calls.length, 1, 'one combined call for the whole group')
    assert.equal(out.length, 2)
    assert.deepEqual(out.map((s) => s.pages[0].title), ['One', 'Two'])
  } finally {
    restore()
  }
})

test('proposeAndDraftPagesBatch falls back to per-source calls on a malformed batch response', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  const { calls, restore } = stubFetch((body) => {
    if (/ingesting MULTIPLE/.test(body.messages[0].content)) return 'not json — the model flubbed the batch'
    const title = body.messages[1].content.match(/Source title: ([^\n]+)/)[1].trim()
    return JSON.stringify({ pages: [{ title: `${title}-page`, type: 'source', tags: [], summary: 's', body: 'x' }] })
  })
  try {
    const out = await proposeAndDraftPagesBatch([
      { sourceTitle: 'One', sourceContent: 'first' },
      { sourceTitle: 'Two', sourceContent: 'second' }
    ], root)
    assert.equal(out.length, 2, 'batch shape preserved through the fallback')
    assert.deepEqual(out.map((s) => s.pages[0].title), ['One-page', 'Two-page'])
    // two failed batch attempts (initial + retry) then the two per-source calls.
    assert.equal(calls.length, 4)
  } finally {
    restore()
  }
})

test('proposeAndDraftPagesBatch falls back when the response has the wrong number of sources', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  const { restore } = stubFetch((body) => {
    if (/ingesting MULTIPLE/.test(body.messages[0].content)) {
      return JSON.stringify({ sources: [{ pages: [{ title: 'Only', type: 'source', body: 'b' }] }] }) // 1 of 2
    }
    const title = body.messages[1].content.match(/Source title: ([^\n]+)/)[1].trim()
    return JSON.stringify({ pages: [{ title: `${title}-page`, type: 'source', body: 'x' }] })
  })
  try {
    const out = await proposeAndDraftPagesBatch([
      { sourceTitle: 'One', sourceContent: 'first' },
      { sourceTitle: 'Two', sourceContent: 'second' }
    ], root)
    assert.equal(out.length, 2)
    assert.deepEqual(out.map((s) => s.pages[0].title), ['One-page', 'Two-page'])
  } finally {
    restore()
  }
})

test('proposeAndDraftPagesBatch is a no-op for an empty group', async () => {
  assert.deepEqual(await proposeAndDraftPagesBatch([], '/nonexistent'), [])
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

test('source lineage: ## Source block + frontmatter provenance + synthesized hub page (kip-app#113)', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  rebuildRoost(root)
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  // The stub proposes NO type:'source' page — the hub must be synthesized.
  fs.writeFileSync(path.join(root, 'pages', 'sleep-study.md'),
    'Slept 6.2h on average this week. Caffeine after 15:00 correlates with worse deep sleep.')
  const { restore } = stubFetch(() => JSON.stringify({
    pages: [
      { title: 'Sleep Study', type: 'concept', tags: ['health'], summary: 'Weekly sleep numbers', body: 'Average 6.2h; late caffeine hurts deep sleep.' }
    ]
  }))

  try {
    const summary = await hatchAllSources(root, { limit: 1 })
    assert.equal(summary.hatched.length, 1)
    const results = summary.hatched[0].results
    assert.equal(results.length, 2, 'one proposed page + the synthesized source hub')
    const hub = results.find((r) => r.type === 'source')
    const concept = results.find((r) => r.type === 'concept')
    assert.equal(concept.slug, 'sleep-study')
    // The hub must NOT steal the concept's slug: meta.db is keyed by slug,
    // so a second page under 'sleep-study' would make the concept vanish
    // from search, index and groom (kip-app#113 review).
    assert.equal(hub.slug, 'sleep-study-source')
    assert.equal(hub.path, 'nest/sources/sleep-study-source.md')

    const conceptRow = getPage('sleep-study', root)
    assert.equal(conceptRow.type, 'concept', 'concept row intact under its own slug')
    assert.equal(conceptRow.summary, 'Weekly sleep numbers', 'concept summary intact')

    const hubRaw = fs.readFileSync(path.join(root, hub.path), 'utf8')
    assert.match(hubRaw, /## Source\n\n- Source file: `pages\/sleep-study\.md`/)
    assert.match(hubRaw, /- Content hash at hatch: `[0-9a-f]{12}…`/)
    assert.match(hubRaw, /type: source/)
    assert.match(hubRaw, /source_hatched: '?\d{4}-\d{2}-\d{2}'?/)

    const conceptRaw = fs.readFileSync(path.join(root, 'nest', 'concepts', 'sleep-study.md'), 'utf8')
    assert.doesNotMatch(conceptRaw, /## Source/, 'no ## Source section on non-source pages')
    assert.match(conceptRaw, /source: pages\/sleep-study\.md/, 'but frontmatter provenance on all pages')

    // rebuild-roost must keep the LLM summary now that it lives in frontmatter
    const { rebuildRoost: rebuild } = require('../rebuild-roost')
    rebuild(root)
    assert.match(getPage('sleep-study-source', root).summary, /Hatched from pages\/sleep-study\.md/,
      'frontmatter summary survives a rebuild instead of degrading to the first paragraph')
    assert.equal(getPage('sleep-study', root).summary, 'Weekly sleep numbers',
      'and the concept keeps its own summary through a rebuild too')
  } finally {
    restore()
  }
})

test('collectPendingSources: status splits new drops from edited-since-hatch sources (kip-app#113)', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  fs.writeFileSync(path.join(root, 'pages', 'fresh.md'), 'A brand new drop of source content here.')
  fs.writeFileSync(path.join(root, 'pages', 'edited.md'), 'A source that was hatched and then edited in place.')
  const { recordHatchedSource, hashContent } = require('../lib/roost')
  recordHatchedSource('pages/edited.md', hashContent(fs.readFileSync(path.join(root, 'pages', 'edited.md'), 'utf8')), root)

  let { pending } = collectPendingSources(root)
  const byPath = new Map(pending.map((p) => [p.relPath, p.status]))
  assert.equal(byPath.get('pages/fresh.md'), 'new')
  // edited.md matches its recorded hash -> not pending at all
  assert.equal(byPath.get('pages/edited.md'), undefined)

  fs.writeFileSync(path.join(root, 'pages', 'edited.md'), 'A source that was hatched and then edited in place — twice now.')
  ;({ pending } = collectPendingSources(root))
  const edited = pending.find((p) => p.relPath === 'pages/edited.md')
  assert.equal(edited.status, 'changed', 'same path, different hash -> changed, not new')
})

test('pendingSourcesSummary surfaces changedCount (kip-app#113)', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  fs.writeFileSync(path.join(root, 'pages', 'a.md'), 'First source with enough prose to pass the empty gate easily.')
  fs.writeFileSync(path.join(root, 'pages', 'b.md'), 'Second source, also hatched before, also with prose.')
  const { recordHatchedSource, hashContent } = require('../lib/roost')
  recordHatchedSource('pages/a.md', hashContent(fs.readFileSync(path.join(root, 'pages', 'a.md'), 'utf8')), root)
  recordHatchedSource('pages/b.md', hashContent(fs.readFileSync(path.join(root, 'pages', 'b.md'), 'utf8')), root)
  fs.writeFileSync(path.join(root, 'pages', 'a.md'), 'First source edited after its hatch, with enough prose still.')
  fs.writeFileSync(path.join(root, 'pages', 'new.md'), 'A brand-new third drop with plenty of prose in it.')

  const summary = await pendingSourcesSummary(root)
  assert.equal(summary.changedCount, 1)
  assert.equal(summary.pending.find((p) => p.source === 'A').status, 'changed')
  assert.equal(summary.pending.find((p) => p.source === 'New').status, 'new')
})

test('recordHatchedSource prunes the orphan row left by a renamed source (kip-app#113)', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  fs.writeFileSync(path.join(root, 'pages', 'report-v1.md'), 'Version one of a report.')
  const { hashContent } = require('../lib/roost')
  recordHatchedSource('pages/report-v1.md', hashContent('Version one of a report.'), root)

  // The user renames per GETTING-STARTED's versioning guidance: new file, old one gone.
  fs.rmSync(path.join(root, 'pages', 'report-v1.md'))
  // The prune has a 48h grace period (a minutes-old missing file is a sync
  // race, not a rename) — backdate the row past it.
  const { openDb } = require('../lib/db')
  const db = openDb(root)
  try {
    db.prepare("UPDATE hatched_sources SET hatched = ? WHERE path = 'pages/report-v1.md'")
      .run(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString())
  } finally {
    db.close()
  }
  recordHatchedSource('pages/report-v2.md', hashContent('Version two of a report.'), root)
  const { hatchedSourceHashes } = require('../lib/roost')
  const hashes = hatchedSourceHashes(root)
  assert.ok(hashes.has('pages/report-v2.md'))
  assert.ok(!hashes.has('pages/report-v1.md'), 'old row pruned: file gone, its directory still there')

  // A missing *directory* means "maybe not synced yet" — the row must stay.
  recordHatchedSource('dropbox/report-v2.md', hashContent('Version two of a report.'), root)
  assert.ok(hatchedSourceHashes(root).has('dropbox/report-v2.md'))
})

/** Counts fs.writeFileSync calls to <root>/nest/<basename> (e.g. index.md),
 *  regardless of which module does the write. */
function countWrites (root, basename) {
  const original = fs.writeFileSync
  const target = path.resolve(root, 'nest', basename)
  let count = 0
  fs.writeFileSync = function (file, ...rest) {
    if (path.resolve(String(file)) === target) count++
    return original.apply(fs, [file, ...rest])
  }
  return { get count () { return count }, restore: () => { fs.writeFileSync = original } }
}

test('#112 proposeNextPendingGroup: one batched call for a mixed group, array stash', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  rebuildRoost(root)
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  fs.writeFileSync(path.join(root, 'pages', 'a.md'), 'Alpha source with real prose content here.')
  fs.writeFileSync(path.join(root, 'pages', 'b.md'), 'Beta source with real prose content here.')
  fs.writeFileSync(path.join(root, 'whiteboards', 'Brainstorm.edn'), MINI_BOARD)

  const { calls, restore } = stubFetch((body) => {
    // Only the two regular files go through the combined prompt; the board's
    // Context call is separate (but isn't made until commit).
    assert.match(body.messages[0].content, /ingesting MULTIPLE/)
    assert.match(body.messages[1].content, /--- Source 1: "A" ---/)
    assert.match(body.messages[1].content, /--- Source 2: "B" ---/)
    return JSON.stringify({ sources: [
      { pages: [{ title: 'Alpha', type: 'source', tags: [], summary: 's', body: 'Alpha notes.' }] },
      { pages: [{ title: 'Beta', type: 'source', tags: [], summary: 's', body: 'Beta notes.' }] }
    ] })
  })

  try {
    const out = await proposeNextPendingGroup(root, { groupSize: 3 })
    assert.equal(calls.length, 1, 'one LLM call for both regular files; the whiteboard needs none')
    assert.equal(out.remaining, 0)
    assert.deepEqual(out.files.map((f) => f.relPath), ['pages/a.md', 'pages/b.md', 'whiteboards/Brainstorm.edn'])
    assert.deepEqual(out.files[0].plan.map((p) => p.slug), ['alpha'])
    assert.deepEqual(out.files[1].plan.map((p) => p.slug), ['beta'])
    assert.equal(out.files[2].whiteboard, true)
    assert.ok(!fs.existsSync(path.join(root, 'nest', 'sources', 'alpha.md')), 'nothing written during propose')

    // The stash round-trips as an array with the full per-file plan + source text.
    const stash = JSON.parse(fs.readFileSync(path.join(root, '.roost', 'hatch-plan.json'), 'utf8'))
    assert.ok(Array.isArray(stash), 'stash is an array')
    assert.deepEqual(stash.map((e) => e.relPath), ['pages/a.md', 'pages/b.md', 'whiteboards/Brainstorm.edn'])
    assert.equal(stash[2].whiteboard, true)
    assert.ok(stash[0].plan.length && stash[0].sourceContent, 'full plan + source text stashed for commit')
  } finally {
    restore()
  }
})

test('#112 commitReviewedPlanGroup: per-file keeps, whiteboards always hatch, index once', async (t) => {
  const root = makeTempVault()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  rebuildRoost(root)
  saveLLMConfig({ provider: 'local', providers: { local: { model: 'test-model' } } }, root)

  fs.writeFileSync(path.join(root, 'pages', 'a.md'), 'Alpha source with real prose content here.')
  fs.writeFileSync(path.join(root, 'pages', 'b.md'), 'Beta source with real prose content here.')
  fs.writeFileSync(path.join(root, 'whiteboards', 'Brainstorm.edn'), MINI_BOARD)

  const { restore } = stubFetch((body) => {
    if (/ingesting MULTIPLE/.test(body.messages[0].content)) {
      return JSON.stringify({ sources: [
        { pages: [
          { title: 'Alpha', type: 'source', tags: [], summary: 's', body: 'Alpha hub.' },
          { title: 'Alpha Detail', type: 'concept', tags: [], summary: 's', body: 'Alpha detail body.' }
        ] },
        { pages: [{ title: 'Beta', type: 'source', tags: [], summary: 's', body: 'Beta hub.' }] }
      ] })
    }
    // the whiteboard's Context call
    return JSON.stringify({ summary: 'A board.', context: 'Context about the board.' })
  })

  const indexWrites = countWrites(root, 'index.md')
  try {
    const proposal = await proposeNextPendingGroup(root, { groupSize: 3 })
    assert.equal(proposal.files.length, 3)

    // Keep everything from A; omit B entirely = skip B's pages.
    const results = await commitReviewedPlanGroup(root, {
      keeps: { 'pages/a.md': ['alpha', 'alpha-detail'] }
    })
    assert.equal(results.length, 3)
    const bySource = new Map(results.map((r) => [r.source, r]))
    assert.deepEqual(bySource.get('A').results.map((r) => r.slug).sort(), ['alpha', 'alpha-detail'])
    assert.equal(bySource.get('B').keptNone, true)
    assert.equal(bySource.get('Brainstorm').kind, 'whiteboard')

    assert.ok(fs.existsSync(path.join(root, 'nest', 'sources', 'alpha.md')))
    assert.ok(fs.existsSync(path.join(root, 'nest', 'concepts', 'alpha-detail.md')))
    assert.ok(!fs.existsSync(path.join(root, 'nest', 'sources', 'beta.md')), 'file B skipped (omitted from keeps)')
    assert.ok(fs.existsSync(path.join(root, 'nest', 'sources', 'brainstorm.md')), 'whiteboard always hatched')

    assert.equal(indexWrites.count, 1, 'index.md regenerated exactly once for the whole group')
    assert.ok(!fs.existsSync(path.join(root, '.roost', 'hatch-plan.json')), 'stash cleaned up')

    // Every source was recorded as handled (committed or deliberately skipped).
    assert.deepEqual((await proposeNextPendingGroup(root, { groupSize: 3 })).done, true)
  } finally {
    indexWrites.restore()
    restore()
  }
})
