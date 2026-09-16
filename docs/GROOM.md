# Groom — technical reference

`scripts/groom.js`. Groom is the third stage of Kip's ingest/query/lint cycle:
**Hatch** writes pages into `nest/`, **Peck** answers questions from them, **Groom**
checks the health of what's accumulated and feeds what it finds back into Peck.

This doc is the technical reference for how it works today — objective, behavior,
rationale, and a function-by-function map of `scripts/groom.js`. It complements
`docs/PECK-REBUILT.md`, which covers the sidecar integration decision but not
Groom's own internals.

## 1. Objective

Hatch is append-only and per-file: it never re-reads the rest of the vault when it
drafts a page (see `docs/peck-vs-llm-wiki-pattern.md`), so pages can drift out of
sync with each other — stale summaries, pages that quietly contradict one another,
duplicate pages under different slugs, links that were never made. Groom is the
periodic sweep that catches that drift: it never writes to `nest/`, it only
**reports** (with one narrow exception, §4), and it's the mechanism that lets Peck
warn a user when an answer drew on a page with a known problem.

Two run modes trade cost for coverage:

| Mode | Trigger | Cost | Scope |
|---|---|---|---|
| **Quick** | every run; wired into the live/enrichment path (`sidecar/session/groom.ts`) | cheap, mostly deterministic | orphans, filesystem drift, near-duplicate slugs, changed-since-hatch sources, one light contradiction pass |
| **Deep** | `node scripts/groom.js --deep`, normally on a weekly schedule (`kip-app`'s `groom_scheduler.cljs`) | many LLM calls, minutes | everything in quick, plus per-page coherence review, summary/section-summary drift (persisted), missing/broken/dead-end links, merge candidates, a wider contradiction pass |

## 2. What it produces

| Artifact | Written | Purpose |
|---|---|---|
| `.roost/lint.json` | every run (quick and deep) | slug → findings map; Peck reads this at answer time and warns when a cited page has an open finding (kip-app#116) |
| `.roost/groom-report.md` | deep only | dated human checklist, one section per check, each item a `- [ ]` |
| `.roost/groom-metrics.json` | deep only | run metrics (via `lib/run-progress.js`) |
| `.roost/groom-progress.json` | while a deep run is in flight | polled by the app for a live progress bar |
| `.roost/groom-trace.jsonl` | deep + `--trace` | full prompts/responses for debugging |
| `meta.db` `pages.summary` / section summaries | deep only, in place | the *one* mutation Groom makes — see §4 |

`--json` prints the full report as machine-readable stdout (the Coop status panel
`JSON.parse`s it whole, so in that mode all logging goes to stderr, never stdout).

## 3. Function map (`scripts/groom.js`)

### Deterministic checks (no LLM, run in both modes unless noted)

| Function | What it finds |
|---|---|
| `findOrphans(pages)` | pages with no inbound `[[wikilink]]` from any other page |
| `findDrift(vaultRoot, dbPages)` | mismatches between `meta.db` rows and `nest/` files on disk — DB row with no file (`missingFiles`), file with no DB row (`untrackedFiles`) |
| `findNearDuplicates(dbPages)` | all page pairs whose slug similarity (`lib/roost.js#slugSimilarity`) clears `SIMILARITY_THRESHOLD` — full pairwise, but cheap since it's string comparison, not an LLM call |
| `findBrokenLinks(pages)` *(deep only)* | `[[wikilink]]` targets that slugify to no existing page (date-shaped targets like `[[2026-08-26]]` are valid Logseq journal refs and excluded via `isDateSlug`) |
| `findDeadEnds(pages)` *(deep only)* | pages whose outbound links all point nowhere (or only to themselves) |
| `findMissingLinkCandidates(pages)` *(deep only, feeds an LLM check)* | other pages' names appearing as plain prose (word-boundary, case-insensitive) without an existing `[[link]]` — candidates only, confirmed by `confirmMissingLinks` before being reported |

### Grouping helpers (deterministic, feed the LLM checks below)

| Function | Strategy |
|---|---|
| `buildContradictionGroups(pages, maxSize)` | groups pages primarily by `type`; a type with too many pages for one group is sub-split by shared tags (rarest tag first), then any leftover is chunked. Singletons are dropped — nothing to compare against. This is deliberate: full-vault pairwise contradiction detection is unrealistic (see `docs/PECK-REBUILT.md` §2, and ADD-1 AD-9), so Groom only ever compares within a bounded, topically-related group. |
| `buildEntitySourceGroups(pages)` *(deep only)* | for each non-source page, the source pages that `[[link]]` it — lets a contradiction check catch a source misrepresenting the entity/concept it cites, which `buildContradictionGroups`' same-type grouping can't (entity vs. its citing sources are different types) |
| `buildMergePairs(pages, nearDuplicates)` *(deep only)* | same-type page pairs the slug-similarity check missed, but that share ≥2 outbound links or a tag rare enough (≤3 pages) to be meaningful — candidates for `checkPagesSameSubject`, capped at `MAX_MERGE_PAIRS` |

### LLM checks

Each of these calls into `scripts/lib/prompts.js` and is independent/read-only —
nothing but the two persisted-drift checks (`summaryDrift`, `sectionSummaryDrift`)
touches storage, and both are index-only meta.db writes (`setPageSummary`,
`setSectionSummaries`), never a `nest/` file.

| Function | Prompt asks the LLM to… | Group size | Mode |
|---|---|---|---|
| `findContradictions` → `flagContradictions` | flag genuine factual contradictions between the pages in a group (not scope/time differences) | `MAX_CONTRADICTION_GROUP_SIZE` (6) quick / `DEEP_CONTRADICTION_GROUP_SIZE` (12) deep | both |
| `reviewPageCoherence` | find internal inconsistencies across a page's own `_Update_` sections, and flag whether it should be consolidated into a current-state summary + dated history | one page, only if `needsCoherenceReview` (≥2 `_Update_` markers, or body >1500 chars) | deep |
| `checkSummaryAccuracy` | say whether the `meta.db` one-line summary still fits a (possibly grown) body; suggest a replacement if not | one page, only if it has a summary and body >400 chars | deep |
| `checkSectionSummaries` | re-check each heading section's one-liner against its current body; return only the stale ones | one page (all its headed sections in one call) | deep |
| `confirmMissingLinks` | of the plain-text name mentions `findMissingLinkCandidates` found, which are genuine references worth linking (vs. incidental word overlap) | one page + its candidate slugs | deep |
| `checkPagesSameSubject` | decide whether a merge-candidate pair is really the same subject under different names | one pair | deep |
| `flagContradictions` (again, via `xrefGroups`) | same contradiction prompt, applied to entity+citing-source groups | up to 8 pages | deep |

### Orchestration

- **`runGroom(vaultRoot, { flagFn, deep, onProgress, deps })`** — the entry point.
  Reads all pages from `meta.db` once, runs the deterministic + light-contradiction
  checks unconditionally, returns early for quick mode. In deep mode, builds every
  check's target list, then fires the six LLM checks through
  `mapLimit(items, GROOM_LLM_CONCURRENCY, fn)` (concurrency 6, from `lib/hatch.js`) —
  each check is independent and read-only (bar the two index-only persists), so
  running them concurrently is safe and cuts deep-pass wall-clock time roughly by
  that factor. `flagFn` and the four `deps.*` functions are injectable, purely so
  tests can substitute fakes for the real LLM calls.
- **`dedupeContradictions(list)`** — after the type-grouped pass and the
  entity/source cross-check pass both run, the same contradiction can surface
  twice; dedupes by sorted-slug-pair + truncated description.
- **`buildLintIndex(report)`** — inverts the whole report into a `slug → finding[]`
  map. This is the piece Peck actually consumes: it intersects this index against
  the pages an answer cited and surfaces a warning when one has an open finding
  (kip-app#116). A `summaryDrift` entry that Groom already applied to the index is
  *not* surfaced here — only ones it couldn't apply are still "open."
- **`writeLintJson` / `writeGroomReport` / `printReport`** — three renderers of the
  same report for three audiences: the machine-readable answer-time artifact, the
  dated human checklist, and interactive stdout.
- **`main()`** — CLI glue: parses `--deep` / `--json` / `--trace`, wires up the
  progress reporter and telemetry only for deep runs (quick runs have no
  `groom-progress.json`/`groom-metrics.json`), calls `runGroom`, writes whichever
  artifacts the mode calls for, and appends one line to the shared activity log
  (`lib/roost.js#appendLog`).

## 4. Why the one write exception exists

Groom's stated contract is "read-only… it never edits a nest/ page" — true for
every finding except summary and section-summary drift, which it *does* apply,
but only to `meta.db`, never to a `nest/` markdown file. The reasoning (kip-app#115,
kip-app#106): Peck's answer prompt reads `pages.summary` directly to decide what a
page is about before pulling its full body. A summary that Groom already knows is
stale but only reported would keep misdescribing the page to Peck on every single
turn until the next time someone manually applies the suggestion. Persisting it is
strictly narrower than editing the page itself — the prose the user wrote is
untouched — so it doesn't violate the "no edits" contract in the sense that matters
(nothing under `nest/` changes), while still keeping the index it's paired with
correct.

## 5. Design decisions worth knowing before changing this file

- **Grouped, not full-vault, contradiction detection.** `buildContradictionGroups`
  exists because an LLM comparing every page against every other page doesn't
  scale. Groom accepts a coverage gap in exchange for boundedness: a contradiction
  between two same-typed pages that share no tag, or between two different-typed
  pages that aren't source↔entity, is not comparable purely by the grouping logic — the general `findContradictions` pass over `buildContradictionGroups` only ever compares within a type/tag group; the *only* cross-type comparison Groom performs is the deep-only entity/source cross-check (`buildEntitySourceGroups`).
- **Quick mode's contradiction check is not free.** Unlike the other five LLM
  checks (deep-only), `findContradictions` runs on *every* groom, quick or deep —
  it's in the `report` object built before the `if (!deep) return report` gate.
  That makes it the highest-frequency LLM-bound path in the file, which is also
  why its performance and error-handling matter more than the deep-only checks
  (see #117, #119).
- **The sidecar wraps this module, it does not reimplement it.**
  `sidecar/session/groom.ts` (kip#76, closed) explicitly keeps
  `buildContradictionGroups`'s batching strategy and calls into `scripts/groom.js`'s
  exported functions via `createRequire` rather than porting the algorithm to
  TypeScript — a deliberate decision recorded in `docs/PECK-REBUILT.md` §2
  ("already matches the harness's own stated rationale"). Anyone changing
  `findContradictions` or its exports is changing the sidecar's live enrichment
  path too, not just the CLI.
- **Injectable dependencies exist only for tests.** `runGroom`'s `flagFn` param and
  `deps.*` overrides have no other caller — don't read them as an extension point
  for new behavior; they're there so `scripts/test/groom.test.js` can substitute
  fakes for real LLM calls.

## 6. Known open work

Tracked under the [`grooming optimization`](https://github.com/JWE24-code/kip/milestone/13)
milestone:

- **#117** — `findContradictions` runs its groups through a plain sequential `for`
  loop while every other LLM check in this file uses `mapLimit`; it's also the one
  check that runs on quick grooms, making it the highest-frequency serial path.
- **#119** — the entity/source cross-check (`xrefResults`) silently swallows a
  failed `flagFn` call (`catch { return [] }`), unlike `findContradictions`, which
  logs a warning for the same failure mode.
