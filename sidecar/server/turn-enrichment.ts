// Answer enrichment (kip#98): turn the loop's raw per-turn accounting plus the
// final answer text into the shape kip-app's `turn->message` consumes.
//
// The old `peckTurn()` computed this from one fixed `answerFromPages()` call.
// The model-driven loop reaches an answer through arbitrary tool calls, so
// there is no single place that already knows the candidate set and the
// answer: the loop *accounts* for the slugs tools surfaced and the notes they
// wrote, and this server-side step re-derives the rest from what actually
// happened, re-using the deterministic extractors ported unchanged in
// `session/notes.ts` (`extractCitedSlugs` / `deadCitationSlugs` /
// `lintWarningsFor`).
//
// Deliberately not carried (the kip#98 design decision):
//   * `callId`/`arenaId` — BYOK has no per-call id, and kip#79 keeps the
//     managed backend's id on the metering side-channel (`llm/usage.ts`),
//     never the client surface. There is nothing truthful to report here yet.
//   * `webSource` — the web-search skill's results cross the sandbox through
//     the shared `web_search` hostcall, which has no per-turn context to
//     record into. A later pass can thread that through if the UI needs it.

import type { LearnedPage, TurnAccounting, TurnEnrichment } from '../protocol.ts'
import {
  deadCitationSlugs,
  extractCitedSlugs,
  humanizeSlug,
  lintWarningsFor
} from '../session/notes.ts'

export interface EnrichInput {
  /** The turn's final answer text (what the model streamed). */
  text: string
  /** What the turn's tools surfaced/wrote. */
  accounting?: TurnAccounting
}

export type TurnEnricher = (input: EnrichInput) => TurnEnrichment

/** A human confirmation for a filing turn whose model left no prose. */
function summarizeWrites (writes: LearnedPage[]): string {
  return `Saved to the nest: ${writes.map((write) => humanizeSlug(write.slug)).join(', ')}.`
}

/**
 * Builds the vault-bound enricher for one sidecar (Kip owns a single coop per
 * connection). The vault is needed for dead-citation and lint lookups; without
 * it the pure evidence (candidates, citations, sources) and the statement card
 * still come through.
 */
export function createTurnEnricher (vaultRoot?: string): TurnEnricher {
  return ({ text, accounting }) => {
    const candidateSlugs = accounting?.candidateSlugs ?? []
    const writes = accounting?.writes ?? []
    const citedSlugs = extractCitedSlugs(text, candidateSlugs)

    const enrichment: TurnEnrichment = {
      candidateSlugs,
      citedSlugs,
      deadCitations: vaultRoot ? deadCitationSlugs(text, candidateSlugs, vaultRoot) : [],
      lintWarnings: vaultRoot ? lintWarningsFor(vaultRoot, citedSlugs) : [],
      sources: citedSlugs.map((slug) => ({ slug, title: humanizeSlug(slug) }))
    }

    // A turn that wrote a note but cited nothing was filing a fact, not
    // answering from the nest — report it as a statement so kip-app renders
    // the "✓ Learned" card instead of an empty assistant bubble. The model's
    // own confirmation (when it wrote one) becomes the card text.
    if (writes.length > 0 && citedSlugs.length === 0) {
      enrichment.intent = 'statement'
      enrichment.learned = true
      enrichment.pages = writes
      enrichment.note = text.trim() || summarizeWrites(writes)
    }

    return enrichment
  }
}
