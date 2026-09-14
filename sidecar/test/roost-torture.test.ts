// AD-4 / SPEC-1 Acceptance B: a concurrent read during a write never blocks
// or corrupts (kip#70). The writer runs on its own worker thread; the reader
// holds a separate WAL connection. This test hammers reads from a tight loop
// on the main thread while a large write batch is in flight, then proves the
// database is intact and exactly consistent afterwards.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

import {
  closeAllReaders,
  closeWriters,
  getPage,
  roostDbPath,
  searchPages,
  writerFor
} from '../roost/index.ts'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as new (file: string, options?: { readonly?: boolean, fileMustExist?: boolean }) => {
  prepare: (sql: string) => { get: (...p: unknown[]) => unknown, all: (...p: unknown[]) => unknown[] }
  close: () => void
}

const SEED_COUNT = 100
const WRITE_BATCH = 500
const SETTLE_LIMIT = 500_000

function makeTempVault (): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-torture-'))
  for (const dir of ['nest/concepts', 'nest/entities', 'nest/sources', 'clucks', '.roost']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  return root
}

async function seed (root: string): Promise<void> {
  const writer = writerFor(root)
  await Promise.all(
    Array.from({ length: SEED_COUNT }, (_, i) => {
      const slug = `page-${String(i).padStart(3, '0')}`
      return writer.upsertPage(slug, `nest/concepts/${slug}.md`, 'concept', ['seed'], `Seed ${i}`, `seed body widget ${i}`)
    })
  )
}

test('concurrent reads during a write batch neither block nor corrupt (WAL + worker)', async (t) => {
  const root = makeTempVault()
  t.after(async () => {
    await closeWriters()
    closeAllReaders()
    fs.rmSync(root, { recursive: true, force: true })
  })

  await seed(root)
  const writer = writerFor(root)

  // A large batch of writes, fired without awaiting so they queue on the
  // writer thread while the main thread starts reading.
  let writesSettled = false
  const writeErrors: Error[] = []
  const writes = Promise.all(
    Array.from({ length: WRITE_BATCH }, (_, i) => {
      const slug = `page-${String(i % SEED_COUNT).padStart(3, '0')}`
      const updated = i >= SEED_COUNT
      const write = writer.upsertPage(
        updated ? `extra-${i}` : slug,
        `nest/concepts/${updated ? `extra-${i}` : slug}.md`,
        'concept',
        ['torture'],
        `Update ${i}`,
        `torture pass ${i} widget${i % 7}`
      )
      return write
    })
  ).then(() => { writesSettled = true }).catch((err: Error) => {
    writeErrors.push(err)
    writesSettled = true
  })

  const readErrors: Error[] = []
  const durations: number[] = []
  let reads = 0
  let concurrentReads = 0

  // Read continuously until every write has landed.
  while (!writesSettled && reads < SETTLE_LIMIT) {
    const start = performance.now()
    try {
      const results = searchPages(`widget${reads % 7}`, { limit: 20 }, root)
      if (!Array.isArray(results)) readErrors.push(new Error('searchPages did not return an array'))
    } catch (err) {
      readErrors.push(err as Error)
    }
    durations.push(performance.now() - start)
    reads += 1
    if (!writesSettled) concurrentReads += 1
    // Yield so the event loop (and the worker's replies) can progress.
    await new Promise((resolve) => setImmediate(resolve))
  }
  await writes

  assert.deepEqual(writeErrors, [], 'no write failed')
  assert.deepEqual(readErrors, [], 'no read failed while writes were in flight')
  assert.ok(reads > 0, 'the reader actually ran')
  assert.ok(concurrentReads > 0, 'at least one read completed while writes were still in flight')

  // Consistency: a fresh connection (independent of both reader and writer)
  // must see the committed rows and an intact database.
  const db = new Database(roostDbPath(root), { readonly: true, fileMustExist: true })
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    assert.equal(integrity.integrity_check, 'ok', 'PRAGMA integrity_check is ok')
    const pages = (db.prepare('SELECT count(*) AS n FROM pages').get() as { n: number }).n
    const fts = (db.prepare('SELECT count(*) AS n FROM pages_fts').get() as { n: number }).n
    assert.equal(fts, pages, 'every page has exactly one FTS row')
    // 100 seed pages updated in place + 400 batch-only inserts = the batch size.
    assert.equal(pages, WRITE_BATCH, 'seed pages were updated in place, batch extras inserted')
  } finally {
    db.close()
  }

  // Every page the batch touched is readable through the reader afterwards.
  const first = getPage('extra-100', root)
  assert.ok(first && first.summary === 'Update 100', 'a batch-written page is visible to the reader')
  const p95 = percentile(durations, 0.95)
  console.error(`[roost-torture] ${reads} reads during ${WRITE_BATCH} writes (${concurrentReads} concurrent) · p95 ${p95.toFixed(3)}ms`)
})

function percentile (samples: number[], p: number): number {
  if (!samples.length) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}
