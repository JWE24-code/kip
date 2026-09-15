// NFR-1: search stays single-digit-ms p95 at 10k notes (kip#70). This test
// builds a synthetic 10k-page roost directly (the fixture is the input, not
// the thing under test), then times the real reader `searchPages` over it and
// asserts the p95 of a keyword-query mix is under the 10ms acceptance budget.
//
// It measures the reader path exactly as the sidecar uses it: a separate WAL
// connection, no writer worker in the loop.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  closeAllReaders,
  openWriterConnection,
  searchPages
} from '../roost/index.ts'
import { splitSections, summarizeSection } from '../roost/query.ts'

const NOTE_COUNT = 10_000
const QUERY_ROUNDS = 300
const P95_BUDGET_MS = 10

function makeTempVault (): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-perf-'))
  for (const dir of ['nest/concepts', 'nest/entities', 'nest/sources', 'clucks', '.roost']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  return root
}

const TOPICS = ['sleep', 'budget', 'sailing', 'coffee', 'protein', 'taxes', 'invoices', 'running']

function seedBody (i: number, topic: string): string {
  return [
    `${topic} note ${i}: a synthetic entry about ${topic}.`,
    `It mentions widget${i % 500} and uses [[note-${(i + 1) % NOTE_COUNT}]] as a link.`,
    'Filler prose keeps the body a realistic size so bm25 has something to chew on.',
    `Secondary keyword: token${i % 2000}.`
  ].join(' ')
}

/** Builds the 10k fixture in one transaction, exactly as the writer would. */
function seedFixture (root: string): void {
  const db = openWriterConnection(root)
  try {
    const now = new Date().toISOString()
    const insertPage = db.prepare(
      'INSERT INTO pages (slug, path, type, tags, summary, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    const insertFts = db.prepare('INSERT INTO pages_fts (slug, body) VALUES (?, ?)')
    const insertSection = db.prepare('INSERT INTO sections (slug, seq, heading, summary) VALUES (?, ?, ?, ?)')
    const tx = db.transaction(() => {
      for (let i = 0; i < NOTE_COUNT; i++) {
        const topic = TOPICS[i % TOPICS.length]
        const slug = `note-${String(i).padStart(5, '0')}`
        const body = seedBody(i, topic)
        insertPage.run(slug, `nest/concepts/${slug}.md`, 'concept', JSON.stringify([topic]), `About ${topic}`, now, now)
        insertFts.run(slug, body)
        splitSections(body).forEach((s, seq) => insertSection.run(slug, seq, s.heading, summarizeSection(s.body)))
      }
    })
    tx()
    // Mirror the ported `rebuild`: merge the bulk-inserted FTS segments, or
    // every later query pays their cost instead of the search itself.
    db.exec("INSERT INTO pages_fts(pages_fts) VALUES('optimize')")
  } finally {
    db.close()
  }
}

function percentile (samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

test(`searchPages p95 < ${P95_BUDGET_MS}ms over ${NOTE_COUNT} notes (NFR-1)`, (t) => {
  const root = makeTempVault()
  t.after(() => {
    closeAllReaders()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const seedStart = Date.now()
  seedFixture(root)
  const seedMs = Date.now() - seedStart

  // Sanity: the fixture really is 10k searchable pages, not 10k no-ops.
  assert.equal(searchPages('sleep', { limit: 1 }, root).length, 1)

  const queries = TOPICS.flatMap((topic, i) => [
    topic,
    `${topic} token${(i * 37) % 2000}`,
    `${TOPICS[(i + 3) % TOPICS.length]} ${topic}`
  ])

  // Warm the reader connection + FTS cache before measuring.
  for (let i = 0; i < 20; i++) searchPages(queries[i % queries.length], {}, root)

  const samples: number[] = []
  for (let i = 0; i < QUERY_ROUNDS; i++) {
    const query = queries[i % queries.length]
    const start = performance.now()
    const results = searchPages(query, { limit: 10 }, root)
    const elapsed = performance.now() - start
    assert.ok(Array.isArray(results))
    samples.push(elapsed)
  }

  const p50 = percentile(samples, 0.5)
  const p95 = percentile(samples, 0.95)
  const max = Math.max(...samples)
  console.error(`[roost-perf] seed ${seedMs}ms · search p50 ${p50.toFixed(3)}ms · p95 ${p95.toFixed(3)}ms · max ${max.toFixed(3)}ms`)
  assert.ok(p95 < P95_BUDGET_MS, `expected p95 < ${P95_BUDGET_MS}ms, got ${p95.toFixed(3)}ms (p50 ${p50.toFixed(3)}ms)`)
})
