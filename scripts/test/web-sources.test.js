const test = require('node:test')
const assert = require('node:assert/strict')
const matter = require('gray-matter')

const { parseWebSearchOutput, buildWebSource, slugify } = require('../lib/web-sources')

const OUTPUT = `Results for "how do mRNA vaccines work" (via duckduckgo):

- [mRNA vaccines explained](https://example.com/mrna) — They deliver a strand of mRNA that codes for a viral protein.
- [CDC: Understanding mRNA](https://cdc.gov/mrna) — Overview of the mechanism and safety.
- [No dash here](https://example.com/plain)`

test('parseWebSearchOutput: pulls query, backend, and the result list', () => {
  const r = parseWebSearchOutput(OUTPUT)
  assert.equal(r.query, 'how do mRNA vaccines work')
  assert.equal(r.backend, 'duckduckgo')
  assert.equal(r.results.length, 3)
  assert.deepEqual(r.results[0], {
    title: 'mRNA vaccines explained',
    url: 'https://example.com/mrna',
    snippet: 'They deliver a strand of mRNA that codes for a viral protein.'
  })
  assert.equal(r.results[2].snippet, '')
})

test('parseWebSearchOutput: a "No results" line parses with an empty list', () => {
  const r = parseWebSearchOutput('No results for "obscure thing" (via brave).')
  assert.equal(r.query, 'obscure thing')
  assert.equal(r.backend, 'brave')
  assert.deepEqual(r.results, [])
})

test('parseWebSearchOutput: junk returns null', () => {
  assert.equal(parseWebSearchOutput('the web-search skill is not configured'), null)
  assert.equal(parseWebSearchOutput(''), null)
})

test('buildWebSource: one search → a hatchable eggs doc', () => {
  const now = new Date('2026-08-31T10:00:00Z')
  const src = buildWebSource('How do mRNA vaccines work?', [parseWebSearchOutput(OUTPUT)], { now })
  assert.equal(src.filename, 'web-search-2026-08-31-how-do-mrna-vaccines-work.md')

  const { data, content } = matter(src.content)
  assert.equal(data.source, 'web-search')
  assert.equal(data.question, 'How do mRNA vaccines work?')
  assert.equal(data.saved, '2026-08-31')
  assert.match(content, /# Web search — How do mRNA vaccines work\?/)
  assert.match(content, /\[mRNA vaccines explained\]\(https:\/\/example\.com\/mrna\)/)
  assert.match(content, /not the full page text/)
})

test('buildWebSource: multiple searches get per-query sections', () => {
  const a = parseWebSearchOutput(OUTPUT)
  const b = { query: 'vaccine side effects', backend: 'brave', results: [{ title: 'T', url: 'https://x', snippet: 's' }] }
  const src = buildWebSource('vaccines', [a, b], { now: new Date('2026-08-31') })
  assert.match(src.content, /## "how do mRNA vaccines work" \(via duckduckgo\)/)
  assert.match(src.content, /## "vaccine side effects" \(via brave\)/)
  assert.deepEqual(new Set(matter(src.content).data.backends), new Set(['duckduckgo', 'brave']))
})

test('buildWebSource: nothing worth saving → null', () => {
  assert.equal(buildWebSource('q', []), null)
  assert.equal(buildWebSource('q', [{ query: 'x', backend: 'y', results: [] }]), null)
  assert.equal(buildWebSource('q', null), null)
})

test('slugify: lowercases, dashes, trims, caps length', () => {
  assert.equal(slugify('How do mRNA vaccines work?'), 'how-do-mrna-vaccines-work')
  assert.equal(slugify('   '), 'query')
  assert.ok(slugify('a'.repeat(200)).length <= 60)
})
