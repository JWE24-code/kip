// `sidecar/roost/` — the roost index, ported from `scripts/lib/roost.js`
// (kip#70, P2). The module keeps the same schema and the same query/dedup
// behavior; what changes is the concurrency shape (AD-4):
//
//   - reader.ts  a separate, read-only WAL connection per coop, used for every
//                read (searchPages, getPage, getPageSections, …)
//   - writer.ts  a worker thread owning the single write connection, used for
//                every mutation (upsertPage, appendLog, rebuild, …)
//
// Pure helpers (slugify, the normalized-Levenshtein similarity used by
// findSimilarSlug, splitSections, …) live in query.ts and are shared by both.
//
// Readers are synchronous and writers are async — the one honest difference
// from the old single-connection module, because a write now crosses threads.

export {
  DEFAULT_VAULT_ROOT,
  SCHEMA,
  migrateLegacyDb,
  openWriterConnection,
  openReaderConnection,
  indexExists,
  roostDbPath
} from './schema.ts'

export {
  toMatchQuery,
  slugify,
  humanize,
  extractWikilinkSlugs,
  levenshtein,
  slugSimilarity,
  SIMILARITY_THRESHOLD,
  splitSections,
  summarizeSection,
  normalizeHeading,
  hashContent,
  bestSimilarSlug,
  type Section,
  type SimilarSlug
} from './query.ts'

export {
  searchPages,
  findSimilarSlug,
  getPage,
  getPageSections,
  hatchedSourceHashes,
  recentClucks,
  closeReader,
  closeAllReaders,
  type SearchHit,
  type SearchOptions,
  type PageRow,
  type PageSection,
  type LogRow
} from './reader.ts'

export {
  RoostWriter,
  writerFor,
  closeWriter,
  closeWriters,
  upsertPage,
  removePage,
  setPageSummary,
  setSectionSummaries,
  appendLog,
  regenerateIndexMd,
  recordHatchedSource,
  rebuildRoost,
  type SectionSummaryInput
} from './writer.ts'
