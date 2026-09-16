# Groom — technical reference

`scripts/groom.js`. Groom is the third stage of Kip's ingest / query / lint
cycle. **Hatch** turns a raw document into `nest/` pages, **Peck** answers
questions from them, and **Groom** audits what has accumulated and feeds its
findings back into Peck's answers.

This is the deep technical doc for Groom's own internals. `docs/DESIGN.md` §5.3
gives the user-facing summary, `docs/PECK-REBUILT.md` (§2) covers the sidecar
integration decision, and the rationale for individual checks otherwise lives
only in inline comments and the issue history. This document is the reference
those conversations should point at.

## 1. Objective

Hatch is **append-only and per-file**: when it drafts a page it reads the source
and (for an update) only that one page's existing body — it never re-reads the
rest of the nest. Pages therefore drift apart and out of date with what they
claim: a summary that no longer fits a grown body, two pages that state
conflicting numbers, two slugs for the same subject, a link that was never made.
Groom is the periodic sweep that catches that drift.

Groom's contract is **read-only with respect to the user's notes**: it never
edits or deletes a `nest/` page. Every finding is a report — a suggestion the
human works through. The one narrow exception is that it refreshes a drifted
one-line summary in the *derived* index (`meta.db`), never in a markdown file
(§5).

Groom is invoked from four places, all sharing the same `runGroom` core:

- `node scripts/groom.js` / `--deep` — the CLI (`npm run groom`).
- The app's **Coop status** modal (`Run groom` / `Deep groom (weekly)` buttons).
- The `kip-control` Peck skill (`groom` / `groom-deep` actions).
- The sidecar's context assembly and enrichment paths, which call the exported
  functions directly rather than shelling out (§6).

## 2. Modes — quick vs. deep

| | Quick | Deep |
|---|---|---|
| Trigger | `groom.js` (default), `runQuickGroom`, sidecar enrichment | `groom.js --deep`, weekly schedule |
| Cost | one light LLM pass | many LLM calls; can take minutes |
| Writes | `.roost/lint.json` | `.roost/lint.json`, `groom-report.md`, `groom-metrics.json`, `groom-progress.json`, optional `groom-trace.jsonl`, index-only summary updates |
| Scope | structural checks + batched contradictions | structural checks + contradictions + per-page coherence, summary/section drift, link hygiene, merge candidates, entity↔source cross-check |

`runGroom` builds the quick report's checks unconditionally and then **returns
early** for quick mode (`if (!deep) return report`). The deep-only work — both
the deterministic extra scans and every other LLM check — is below that gate.

The split is a cost decision, not a capability one (§5).

## 3. What it produces

| Artifact | Written by | When | Purpose |
|---|---|---|---|
| `.roost/lint.json` | `writeLintJson` | every run (quick and deep) | compact `slug → findings[]` map; Peck reads it at answer time (kip-app#116, §6) |
| `.roost/groom-report.md` | `writeGroomReport` | deep only | dated human checklist, one `##` section per check, each item a `- [ ]` |
| `.roost/groom-metrics.json` | `createRunReporter.writeMetrics` | deep only | final content-free telemetry summary (timings, token counts) |
| `.roost/groom-progress.json` | `createRunReporter.flush` | deep, continuously while running | what the app polls for the live progress bar and activity feed |
| `.roost/groom-trace.jsonl` | `createRunReporter` | deep + `--trace` | full prompts/responses, for debugging; `.roost/` only |
| `meta.db` `pages.summary` / `sections` | `setPageSummary` / `setSectionSummaries` | deep only, in place | the one mutation: a drifted summary refreshed in the derived index — never a `nest/` file |
| clucks log row | `appendLog('groom', …)` | every run | one activity-log line with the run's counts |

`--json` prints the whole report object as machine-readable stdout. The Coop
status panel `JSON.parse`s the entire stdout stream, so in that mode every log
line (`describeProvider`, per-check progress) goes to **stderr**, never stdout.

## 4. Function list

### Entry point and orchestration

- **`runGroom(vaultRoot, { flagFn, deep, onProgress, deps })`** — the exported
  core. Opens `meta.db`, reads every page row (`pages`) and every body
  (`pages_fts`) once into an in-memory `pages` array, then runs each check and
  assembles the report object. Quick checks run always; deep checks are behind
  the early return. `flagFn` (the contradiction LLM call) and the `deps.*`
  overrides (the four other LLM calls) are **injectable purely so tests can
  substitute fakes** — they are not a public extension point.
- **`main()`** — CLI glue: parses `--deep` / `--json` / `--trace`, and for deep
  runs installs telemetry (`telemetry.reset`, `installFeedbackPoster`) and the
  run reporter that drives `<name>-progress.json` / `-metrics.json` /
  `-trace.jsonl` and per-check stderr progress. Calls `runGroom`, then writes
  `lint.json` (always) and `groom-report.md` (deep), prints or JSON-encodes the
  report, and appends the clucks row.

### Deterministic checks (no LLM)

- **`findOrphans(pages)`** — pages with no inbound `[[wikilink]]` from any
  *other* page. Runs in both modes.
- **`findDrift(vaultRoot, dbPages)`** — mismatches between `meta.db` rows and
  files on disk: `missingFiles` (a row with no file) and `untrackedFiles` (a file
  in a `nest/<type>/` dir with no row). The fix is `rebuild-roost`. Both modes.
- **`findNearDuplicates(dbPages)`** — full pairwise slug similarity above
  `SIMILARITY_THRESHOLD` (`lib/roost.js`, 0.45), sorted by score. Cheap string
  comparison, so it runs in both modes even though it is O(n²).
- **`findBrokenLinks(pages)`** *(deep)* — `[[wikilink]]` targets that slugify to
  no existing page. Date-shaped targets (`[[2026-08-26]]`) are valid Logseq
  journal refs and are excluded via `isDateSlug`.
- **`findDeadEnds(pages)`** *(deep)* — pages whose every outbound link points to
  itself or nowhere. Source pages especially are expected to link out.
- **`findMissingLinkCandidates(pages, { maxPerPage })`** *(deep)* — for each
  page, other pages whose (humanized) name appears in its prose at a word
  boundary, case-insensitively, without an existing `[[link]]`. These are
  **candidates**, not findings: `confirmMissingLinks` filters out incidental word
  matches before anything is reported. Capped at `MISSING_LINK_MAX_PER_PAGE` (8)
  per page; longer names are scanned first.

### Grouping helpers (deterministic, feed the LLM checks)

- **`buildContradictionGroups(pages, maxSize)`** — batches pages for the
  contradiction check: primarily by `type`, and when a type exceeds `maxSize`,
  sub-split by shared tags (rarest tag first) with any leftover chunked. Types
  with a single page are dropped (nothing to compare). `maxSize` is
  `MAX_CONTRADICTION_GROUP_SIZE` (6) quick / `DEEP_CONTRADICTION_GROUP_SIZE` (12)
  deep. This is the AD-9 "no full-vault pairwise comparison" ceiling in code.
- **`buildEntitySourceGroups(pages, { maxGroup })`** *(deep)* — one
  entity/concept page grouped with the `source` pages that `[[link]]` it. This is
  the only **cross-type** comparison Groom does, catching a source page
  misrepresenting the page it cites.
- **`buildMergePairs(pages, nearDuplicates)`** *(deep)* — same-type page pairs
  the slug check missed that share ≥2 outbound links or a rare (≤3 page) tag,
  scored and sorted, capped at `MAX_MERGE_PAIRS` (30) before the LLM decides.

### LLM checks

Each wraps a prompt in `scripts/lib/prompts.js` and is independent and
read-only — the only two that touch storage are the summary-drift checks, and
both write to the index only.

- **`findContradictions(pages, vaultRoot, flagFn, maxSize)`** — groups via
  `buildContradictionGroups`, calls `flagContradictions` once per group. A group
  that throws logs a warning and is skipped, so an unattended run survives one
  provider flake. Both modes.
- **`reviewPageCoherence`** *(deep)* — for pages that `needsCoherenceReview`
  (≥2 `_Update_` markers or body > 1500 chars): internal contradiction,
  redundancy, or superseded claims across a page's own update sections; also
  flags whether the page should be consolidated.
- **`checkSummaryAccuracy`** *(deep)* — for pages with a non-empty summary and a
  body > 400 chars: is the index one-liner still accurate? A suggested
  replacement is persisted with `setPageSummary` (index only) and recorded in
  `summaryDrift`.
- **`checkSectionSummaries`** *(deep)* — for every page with a headed section:
  re-check each section's one-liner; persist stale ones with
  `setSectionSummaries` (index only) and record them in `sectionSummaryDrift`.
- **`confirmMissingLinks`** *(deep)* — of `findMissingLinkCandidates`' prose
  matches, which are genuine references worth linking.
- **`checkPagesSameSubject`** *(deep)* — for each `buildMergePairs` pair, decide
  whether the two pages are the same subject under different names.
- **`flagContradictions`** *(deep, via the entity/source groups)* — the same
  contradiction prompt applied to `buildEntitySourceGroups`; results are merged
  into `report.contradictions` and deduped.

### Report shaping and rendering

- **`buildLintIndex(report)`** — inverts a report into the `slug → findings[]`
  map. Each finding is `{ kind, note }`, plus `slugs` for the pairwise kinds
  (`contradiction`, `near-duplicate`, `merge-candidate`). Kinds: `orphan`,
  `near-duplicate`, `drift`, `contradiction`, `coherence`, `summary-drift`,
  `broken-link`, `dead-end`, `merge-candidate`. A `summary-drift` entry that
  Groom already applied is deliberately **not** indexed — only ones it could not
  apply remain "open". No LLM: a pure re-shape of what `runGroom` computed.
- **`writeLintJson(vaultRoot, report)`** — writes `.roost/lint.json`
  (`{ generated, deep, findings }`). Called on every run. Returns the path.
- **`writeGroomReport(vaultRoot, report)`** — renders the dated markdown
  checklist (deep only). Returns the path.
- **`printReport(report)`** — the interactive stdout rendering; deep-only
  sections are omitted in quick mode.

### Small helpers

- **`slugifyLinkTarget` / `humanizeSlug` / `escapeRe` / `isDateSlug`** — link-target
  normalization, slug→display name, regex escaping for the mention scan, and the
  date-ref exclusion.
- **`stripForMentionScan(body)`** — removes existing `[[links]]` and `_Update_`
  markers before the mention scan so an already-linked page is not re-flagged.
- **`needsCoherenceReview(body)`** — the coherence target predicate.
- **`dedupeContradictions(list)`** — collapses duplicates after the type-grouped
  pass and the entity/source cross-check both run, keyed on the sorted slug pair
  plus the first 40 chars of the description.

## 5. Why — the design decisions

### Batched, not full-vault, contradiction detection

Comparing every page against every other page is O(n²) LLM calls and
unrealistic at scale (`docs/PECK-REBUILT.md` §2; ADD-1 AD-9).
`buildContradictionGroups` bounds the work: compare only within a small,
topically related batch. Groom accepts a **coverage gap** for boundedness — a
contradiction between same-typed pages that share no tag, or between two
different-typed pages that are not source↔entity, is not surfaced. The
entity/source cross-check is the deliberate exception for the one cross-type
relationship that matters most (a source misquoting what it cites). Quick and
deep differ only in batch size (6 vs 12) and the added cross-check.

### The quick/deep split

Quick is meant to be run often (the sidecar runs it in the background), so it
does only what is cheap: structural checks plus one batched contradiction pass.
Deep is the weekly session and spends the LLM calls on semantic work that needs
full page bodies — coherence, drift, link confirmation, merge adjudication.
Keeping the boundary explicit (`if (!deep) return report`) makes the expensive
work trivially auditable and keeps quick runs fast.

### Index-only writes for summary and section drift

Groom's "no edits" contract is about the user's markdown. A stale
`pages.summary` is a different kind of object: it is derived, it lives in
`meta.db`, and Peck's answer prompt reads it directly to decide what a page is
about. Reporting the drift without fixing it would leave Peck misdescribing the
page on **every turn** until a human acted. Persisting the replacement is
strictly narrower than editing the page — the prose is untouched — and
`rebuild-roost` reads the summary back from frontmatter, so the index stays
consistent (`kip-app#115`, `kip-app#106`). `nest/` markdown never changes, which
the sidecar test pins byte-for-byte.

### Deterministic scan, LLM confirm

Several checks pair a cheap deterministic scan with a confirming LLM call:
`findMissingLinkCandidates` → `confirmMissingLinks`. The scan finds *candidate*
name mentions (word-boundary matches are noisy); the model decides which are
genuine references. This keeps the prompt small and the false-positive rate low.

### Concurrency

Every deep LLM check runs through `mapLimit(items, GROOM_LLM_CONCURRENCY, fn)`
(`GROOM_LLM_CONCURRENCY` = 6, `mapLimit` from `lib/hatch.js`). The checks are
independent and read-only — the only writes are the quick, synchronous meta.db
summary updates — so concurrency is safe and cuts deep-pass wall-clock time by
roughly that factor. The cap keeps runs under provider rate limits. Progress is
reported per item via `onProgress`, which the reporter throttles to disk.

### Read-only guarantee and failure handling

No code path writes a `nest/` file. `findContradictions` catches a per-group
failure, logs to stderr, and continues; `collectPendingSources` reports
unreadable files rather than throwing. Groom is meant to run unattended on a
schedule, so one bad page or one provider hiccup must not take the whole run
down.

## 6. Integration points

### Peck at answer time (kip-app#116)

`.roost/lint.json` is the bridge. `scripts/lib/peck.js` reads it (never writes
it — an absent or unparseable file yields no warnings) and exposes:

- `lintWarningsFor(vaultRoot, citedSlugs)` — every finding for the pages an
  answer cited, surfaced as `{ slug, kind, note }` so the user learns an answer
  leaned on a flagged page.
- `knownConflictsFor(vaultRoot, candidateSlugs)` — contradiction findings where
  **both** pages are in the candidate set, injected into the answer prompt as
  "known disagreements" so the model does not present a contested claim as
  settled.

Both are display/prompt-only; retrieval is unchanged.

### The sidecar wraps this module (kip#76)

`sidecar/session/groom.ts` **does not reimplement** the algorithm. It loads
`scripts/groom.js` via `createRequire` and calls the exported functions:

- `runQuickGroom` — the whole quick pass (`groom.runGroom(..., { deep: false })`)
  and `groom.writeLintJson`, for live enrichment.
- `findContradictionsInPlay` — `groom.buildContradictionGroups` scoped to the
  pages a turn actually has in play, with `MAX_CONTRADICTION_BATCH` (6). It
  additionally rejects any finding whose slugs were not batched together, so the
  model cannot widen scope past the AD-9 ceiling.
- `writeConflictReports` — writes one `nest/conflicts/<a>-<b>.md` report per
  contradiction, with `[[a]]`/`[[b]]` links that resolve to the real pages
  (FR-15). This is *new* content from the enrichment path, not a mutation of the
  contradicted pages.

`sidecar/session/notes.ts` carries the read-path twins of `lintWarningsFor` /
`knownConflictsFor`. The practical consequence: **changing `groom.js`'s exports
or `buildContradictionGroups` changes the sidecar's live path too**, not just the
CLI. `docs/PECK-REBUILT.md` §2 records the keep decision ("already matches the
harness's own stated rationale").

## 7. Known open work

Tracked under the
[`grooming optimization`](https://github.com/JWE24-code/kip/milestone/13)
milestone:

- **#117** — `findContradictions` still runs its groups in a plain sequential
  `for` loop while every other LLM check uses `mapLimit`. It is also the only LLM
  check that runs on quick groom, making it the highest-frequency serial path in
  the file.
- **#119** — the entity/source cross-check silently swallows a failed `flagFn`
  call (`catch { return [] }`), unlike `findContradictions`, which logs a
  warning for the same failure.
