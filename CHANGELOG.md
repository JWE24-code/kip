# Changelog

All notable changes to Kip. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions track
`src/main/frontend/version.cljs` (in kip-app).

The retrieval layer (this repo) and the desktop app
([kip-app](https://github.com/JWE24-code/kip-app)) are released together.

## [Unreleased]

## [0.4.6] — 2026-09-03

### The retrieval layer (`scripts/`)

- **Cleaner Peck answers with a source list** — answers no longer weave
  `[[page]]` wikilinks into the prose. The answer model writes clean prose and
  a trailing `Sources:` footer; the client turns that into a `sources` list
  (`[{ slug, title }]`) returned next to the answer, and the raw answer is
  still filed to the nest so its backlinks survive.
- **Faster, more predictable skill loop** — an upfront planning step
  (`peck:plan`, one cheap call) decides the minimal skill set before any skill
  runs, then runs that batch in parallel and synthesises. The common case is
  planned-and-done; the loop still adapts when the results demand another
  call.
- **Skill calls run in parallel** — independent skills a model asks for in one
  turn are now dispatched concurrently instead of one after the other.
- **Short-TTL skill result cache** — a read-only skill re-asked for the same
  input within a short window returns its cached output instead of re-running.
  Opt-in per skill via `cache_ttl` (the bundled web-search defaults to 60s;
  `KIP_SKILL_CACHE=0` disables it).
- **Per-call cost telemetry (internal)** — the managed backend returns each
  call's metered cost (`X-Kip-Cost-Usd`) and the client records it in
  telemetry (per-phase and per-turn totals). Strictly internal — never shown
  in the answer or the UI.

## [0.4.5] — 2026-09-03

### The retrieval layer (`scripts/`)

- **Peck can file an answer back into the nest** (kip-app#112) — a settled
  answer that came from your notes (not a web search, and with at least one
  candidate page) can be kept as a `concept` page tagged `from-peck` via a new
  `chat.js --file-answer` entrypoint. Hardening: the derived slug is capped
  (long / CJK questions can't blow filename limits), an existing page's index
  summary is left intact on update, and the `from-peck` marker survives an
  update. Every question turn from the app now also writes exactly one `peck`
  activity row, matching the CLI — asked-but-never-kept questions are visible
  in the Coop activity view.
- **Hatch updates are deltas, not restatements** (kip-app#114) — on the
  default combined hatch path a page resolved to `update` was appended with a
  body the model drafted without ever seeing that page, manufacturing exactly
  the redundancy and superseded-claim issues groom reports later.
  `commitHatchPlan` now makes one existing-content-aware `generatePageContent`
  call for every update (combined path or classic), the way the classic path
  already did — the write references or contrasts with the prior content
  instead of restating it. Pure creates still cost one LLM call per file.
- **Peck names disagreements instead of picking a side** (kip-app#116) — the
  answer prompt (plain and skills-loop) now has an explicit rule: when the
  cited pages disagree on a date, a value or a claim, say so and cite both
  rather than returning one side as settled fact.
- **Groom's findings reach Peck at answer time** (kip-app#116) — every groom
  run now writes a compact `.roost/lint.json` (slug → findings). A Peck answer
  intersects it with the pages it cited and returns `lintWarnings`, surfaced
  in the CLI and the app panel, so an answer drawn from a page groom flagged
  as orphaned / contradicted / a near-duplicate says so. Groom's stored
  contradiction findings for the pages in play are also fed into the answer
  prompt as a short "known disagreements" block. Strictly additive — Peck
  never writes lint state, and a clean answer adds no LLM call.

## [0.4.3] — 2026-08-31

### The retrieval layer (`scripts/`)

- **Peck falls back to a web search when your notes don't have the answer**
  (kip-app#93) — the answer model now signals `NO_ANSWER` when the retrieved
  pages can't answer the question; `peck.js` catches it, runs the bundled
  `web-search` skill, and answers from the results (`answerFromWeb`). The web
  results are still offered as a savable source. Skipped for a regenerate
  (arena) and when a skill already searched the web that turn; falls through
  to the old "nothing in your nest" state when web search is disabled or comes
  back empty.
- **Peck works in other languages** (kip-app#97) — two Latin-script bugs:
  - `classifyPeckInput` only recognised a question by a trailing `?` or an
    *English* question word, so a German / French / Spanish / … question
    typed without a `?` was classified as a *statement* and filed into the
    nest as a fact instead of being answered. It now also matches a `?`
    anywhere and the interrogatives / imperatives of DE, NL, FR, ES, IT, PT.
  - `slugify` stripped every non-ASCII character, turning "Größe" into
    `gr-e` and "北京会議" into an empty (broken) slug. It now keeps any
    Unicode letter or digit, and an all-punctuation title falls back to a
    short stable hash. Existing ASCII slugs are unchanged; only pages
    hatched from non-English titles from here on get the better slug.

## [0.4.2] — 2026-08-31

### The retrieval layer (`scripts/`)

- **Faster Peck** — a turn used to make two-plus serial LLM calls no matter
  what. Now: the key-term expansion pass is skipped when the direct
  full-text search already found enough pages (≥ 3), and the skills tool
  loop is skipped — along with its bigger prompt — unless a skill is
  plausibly needed (retrieval was thin, or the question asks for
  current/external info or a generated document). Both are recoverable with
  Regenerate. Most "what do I know about X" questions now cost a single LLM
  call.
- **Streamed Peck answers** — `callLLM()` takes an optional `onStream(chunk,
  first)` callback; the Anthropic and OpenAI-compatible connectors honour it
  by requesting an SSE stream and forwarding text deltas as they arrive
  (json calls and the managed `kip` connector are unchanged — they still
  return whole). `peckTurn()` threads it through, and `scripts/chat.js`
  writes the accumulating answer to `peck-progress.json` as `partialAnswer`
  so the app can render it live. In the skills tool loop every turn streams;
  a turn that turns out to be a `<use_skill>` tag is held back by the
  consumer until the text proves to be prose.
- **Office & PDF documents as Hatch sources** (kip-app#91) — new
  `scripts/lib/office.js` + `scripts/office-extract.js` CLI convert a `.docx`,
  `.xlsx` / `.xls` / `.csv`, `.pptx` or `.pdf` into compact Markdown: Word
  keeps its headings / lists / tables (`mammoth`), a workbook becomes one
  Markdown table per sheet (`xlsx`), a deck becomes per-slide bullets plus
  speaker notes (`pizzip`), a PDF its text layer (`pdf-parse`). Hatch runs the
  conversion automatically for anything in `eggs/` (idempotent; the original
  is left in place, the `.md` sibling is what gets hatched), so a document
  synced in via Dropbox or added by the app all land the same way — and the
  LLM reads a few KB of prose instead of megabytes of zipped XML. Legacy
  `.doc` / `.ppt` / OpenDocument are rejected with a "re-save as .docx" hint.
  New deps: `mammoth`, `pdf-parse`.

## [0.4.0] — 2026-08-31

### The retrieval layer (`scripts/`)

- **Calendar subscriptions** (kip-app#70) — `scripts/calendar.js` subscribes
  to a live ICS / `webcal://` feed (Google / Outlook / Fastmail "secret iCal
  address"). `lib/calendar.js` fetches and parses it (RFC 5545 via `ical.js`,
  a zero-dependency parser), expands recurrences to a rolling 14-day window,
  and reconciles the upcoming events into `reminders.json` as
  `source: "calendar"` rows — so each one gets the same nest-retrieval prep
  brief and lead-time notification a hand-typed reminder does. `CANCELLED`,
  past, and `EXDATE` occurrences are dropped; an event that moves is updated
  in place; one that vanishes has its still-pending reminder pruned.
  Subscriptions live in `<graph>/.henhouse/calendars.json` (ICS URLs are
  bearer secrets). New dependency: `ical.js`.
- **Peck remembers the last few turns** (kip-app#82) — `peckTurn` /
  `chat.js` take a `--history` buffer of recent `{role, text}` turns.
  A follow-up ("expand on that", "and their salary?", "the second one")
  now resolves what it refers to: the recent turns are folded into
  retrieval (so a question with no shared nouns still finds pages) and
  passed to the answer as a *"Conversation so far"* block (marked
  not-a-source). A bare continuation right after a Kip answer also
  classifies as a question rather than a new fact. Session-only.
- **Web-search results can be kept** (kip-app#81) — when Peck runs the
  `web-search` skill to answer a question, the turn result now carries a
  `webSource` (front-matter + the result list, ready for `eggs/`). The app
  offers to save it, so a search you found useful becomes reference material
  in the nest instead of vanishing with the turn. `lib/web-sources.js`.

## [0.3.7] — 2026-08-30

### The retrieval layer (`scripts/`)

- **Preference signals** (epic kip-app#73) — content-free plumbing so the
  managed backend can learn which model / workload pairings land. All of it
  is inert unless the active provider is the `kip` connector.
  - `callLLM` now resolves to `{ text, raw, callId, arenaId }`. The `kip`
    connector reads `X-Kip-Call-Id` off every completion; every other
    connector reports `null`.
  - `telemetry.onFeedback` / `sendFeedback` — a closed enum/int sink
    parallel to the full-text trace sink. `lib/feedback-poster.js` batches
    those to `/v1/feedback` (best-effort, `unref`'d timer, capped flush,
    re-checks the provider every enqueue) and is wired into every CLI
    entrypoint.
  - **Regenerate free-rider** — `chat.js --arena-compare-to <callId>` (and
    `peckTurn({ arenaCompareToCallId })`) re-answers a question as arena
    candidate B against the first answer, via `/v1/arena/completions`. The
    turn result carries `arenaId`; `feedback-poster.postArenaVerdict()`
    posts the A/B verdict. Skills are skipped on this path — a regenerate
    is a clean model-vs-model comparison.

## [0.3.5] — 2026-08-30

### The retrieval layer (`scripts/`)

- **Reasoning models without the JSON-mode retry tax** — `deepseek-reasoner`,
  `deepseek-r1`, OpenAI `o1` / `o3` / `o4-mini`, `qwq`, `magistral` and the
  like reject the `response_format` parameter most Kip calls use, so a
  `json:true` call used to send it, take a 400, and retry — two upstream
  round-trips every time. The OpenAI-compatible client now recognises the
  common ones by name and asks for JSON in the prompt from the start; **and
  any other model that 400s on `response_format` is remembered for the rest
  of the run**, so a model the name list misses pays the retry once, never
  again. `gpt-4o` and similar names are unaffected.

### Docs

- **Connectors + the managed backend are documented for users** —
  `GETTING-STARTED.md` covers the "Kip (managed)" provider, the
  **Add a connector** flow (`@kip-ai/*` `.tgz`, why the allowlist exists,
  where installed connectors live), and a note on reasoning-model
  trade-offs. `.env.example` already carried `KIP_API_KEY` / `KIP_BASE_URL`.

## [0.3.4] — 2026-08-29

### The retrieval layer (`scripts/`)

- **A stale search-index row no longer crashes Peck** — if `meta.db`
  points at a nest page whose `.md` is gone (deleted, moved, or a
  OneDrive/iCloud file not yet materialized), retrieval now warns and
  skips it instead of throwing out of the whole turn. `rebuild-roost`
  still cleans the index. (A graph under OneDrive with a
  `nest/sources/<uuid>.md` in the index but not on disk hit this.)

## [0.3.3] — 2026-08-29

### The retrieval layer (`scripts/`)

- **The managed `kip` connector reports what actually went wrong** — a
  connection failure now says "nothing is listening" / "no response —
  check the address, firewall or a proxy" / "can't resolve the host"
  instead of a bare "fetch failed". **Test connection** now checks
  `GET /v1/usage` (auth only, not routed) instead of a completion, so it
  works against a fresh backend and shows your plan + token cap.

(App-only 0.3.2 — the Windows updater signature-check fix — had no
retrieval-layer change.)

## [0.3.1] — 2026-08-29

The managed **Kip backend** connector, and a data-driven LLM settings tab.

### The retrieval layer (`scripts/`)

- **Connector host** — `lib/llm.js` is now a host over `lib/connectors.js`,
  a `ProviderSpec` registry. The five built-ins are converted specs; a
  connector declares its own `fields[]` and `isReady`, and does its own
  `complete()`.
- **Installable connectors** — a `@kip-ai/*` connector package can be
  installed from a `.tgz` into `<graph>/.henhouse/connectors/` (pure-JS
  extraction, allowlist-gated) and removed again. Graph-local overrides a
  bundled connector of the same id.
- **The managed Kip connector** (`PROVIDER=kip`) — one `kip_` key instead of
  per-provider keys; the backend picks the model per workload, enforces the
  plan, and meters usage. `KIP_BASE_URL` defaults to the hosted endpoint,
  overridable for a self-hosted backend. AGPL-3.0, ships built-in.

### The app

- **Data-driven LLM settings** — the provider dropdown and each provider's
  form fields come from the connector registry. An **Add a connector** row
  installs a `.tgz` or a URL; installed connectors can be removed. The
  managed "Kip (managed)" connector stays hidden until you opt in.
- **Friendlier "out of quota / budget" errors** — a plan/billing limit
  (including the managed backend's) now reads as one, not as rate-limiting.

## [0.3.0] — 2026-08-29

Kip ships as an installer with in-app updates. App only — no
retrieval-layer changes.

### The app

- **Windows installer + self-updating Linux AppImage** — `Kip-Setup-*.exe`
  (per-user, signed with a self-issued cert) and an AppImage that updates
  itself; the portable `tar.gz` stays on the releases page. The "a newer
  Kip is available" banner gains an **Update** button.
- **Fixed: Hatch / Peck / Groom in the packaged app** — the bundled
  retrieval layer couldn't load `better-sqlite3` → `bindings` from inside
  `app.asar` (regressed in 0.2.2). `better-sqlite3` and its loader are now
  vendored next to `scripts/` at build time.
- **Schedule the deep groom** — Settings → Features toggle for a weekly
  groom, run from the main process like reminders.

## [0.2.2] — 2026-08-29

De-Logseq'd the first-run experience, plus Hatch review/recovery and a
skill-approval gate.

### The retrieval layer (`scripts/`)

- **Hatch: review before writing** — `hatch-all.js --propose-next` /
  `--commit-next` split (`lib/hatch.js` `proposeNextPending` /
  `commitReviewedPlan`, plan stashed in `.roost/hatch-plan.json`), so the
  app can walk one source at a time and let you keep or skip its proposed
  pages before anything is written.
- **Custom skills must be approved once** — a skill under
  `.henhouse/skills/` runs with your privileges, so `runSkill` now refuses
  it until it's approved (`skills.json` `approved`, `setSkillApproval`,
  `isSkillAllowed`); `SKILL.md` gains a `permissions:` frontmatter list
  that the app shows before you approve.
- **Recover from a stopped hatch** — per-file hash recording so a batch
  that dies partway can be resumed instead of re-run.

### The app

- **The demo graph is Kip's now** — the pre-folder graph is a Kip welcome
  journal (slogan, the farm metaphor, hatch / peck / groom, the coop
  folders, a first-five-minutes checklist) instead of Logseq's tutorial.
- **Faster unzip and launch** — packed into a single `app.asar` instead of
  ~15k loose files; `scripts/` and the native SQLite addon stay unpacked.
- **Windows builds are code-signed** (self-signed for now — SmartScreen
  still warns until there's a real certificate).
- Settings cleanup (no more inherited Logseq account / Sync / local-git
  UI), a one-time welcome card, paste text as a source, metaphor tooltips,
  citation side-peek, a trimmed "…" menu, and Hatch / Peck / Groom now
  refuse to run against the in-memory demo graph instead of erroring.

## [0.2.1] — 2026-08-28

More onboarding polish, plus an in-app update check. App only — no
retrieval-layer changes.

### The app

- **In-app update check** — on launch and every 24h, checks GitHub Releases
  for a newer version and shows a dismissible header banner. No download or
  auto-install; failures are silent. Manual "Check now" in Settings → About.
- **"Ask Kip about them" after a hatch** — a run that creates nest pages
  offers a button into Peck with a question about the first one pre-filled.
- **"Add source…" file picker in Hatch** — pick Markdown/text files from a
  dialog; byte-identical duplicates skipped, unsupported types rejected.
- **Local/Ollama reachability check** in Settings → LLM — a live status line
  under Base URL showing whether the endpoint answers and its model list.
- **"Your coop" overview** in Coop status — `eggs/` and nest page counts,
  last hatch/groom times, a shortcut to hatch pending sources.
- **Kip-native help panel** — replaces the leftover Logseq help links.
- **Friendlier LLM errors** — a plain-language cause and hint in Peck, Hatch
  and Settings, with the raw error behind a toggle.

## [0.2.0] — 2026-08-28

Onboarding polish release.

### The retrieval layer (`scripts/`)

- Removed managed-routing provider integration; the backend will return as a
  separate project later.

### The app

- **LLM-provider banner** — Peck and Hatch now show a non-blocking banner when
  no usable provider is configured, with a shortcut to Settings → LLM.
- **Drag-and-drop sources** — drop a Markdown or text file onto Peck or Hatch
  to copy it into `eggs/` and optionally hatch it immediately.
- **First-run checklist** — Peck's empty state shows a 3-step checklist (set
  provider, add source, hatch it) until Kip is ready, then the example prompts
  return.
- **i18n fix** — "About Logseq" updated to "About Kip" across all locales and
  matching test assertions.

## [0.1.0] — 2026-08-28

First public release. Early and rough — built to gather feedback.

### The retrieval layer (`scripts/`)

- **Hatch** — a source in `eggs/` becomes cross-linked `entity` / `concept` /
  `source` pages in one LLM call (propose + draft together); incremental by
  content hash; near-duplicate pages are updated, not re-created; additive
  `_Update_` sections. Whiteboards hatch into an outline + an LLM "Context"
  section.
- **Peck** — full-text + key-term retrieval → a cited answer; a bounded
  ReAct-style **skill loop** (web search, `xlsx-csv`, `docx`, `pptx`,
  `kip-control`, `reminders`); auto-detects a statement and files it as a
  fact; auto-detects an upcoming event and routes it to Reminders.
- **Groom** — quick structural checks + a weekly deep pass (coherence, drift,
  missing/broken links, merge candidates, contradictions), read-only.
- **Reminders** — natural-language ("Friday at 15h, remind me a day before")
  parsed via chrono; a minute-resolution scheduler fires an OS notification
  ahead of time with a prep brief; per-reminder mute.
- Provider-swappable LLM: Anthropic / OpenAI / DeepSeek / local (Ollama) / any
  OpenAI-compatible endpoint. Content-free telemetry; opt-in trace mode.
- 161 automated tests (no live API).

### The app

- **Pecking-first shell** — opens into Peck; the editor is a mode
  (`Ctrl/⌘+1`). No home splash.
- Panels: Peck, Hatch sources (+ telemetry), Coop status / Groom, Exports,
  Reminders. Settings tabs: LLM, Skills.
- **Whiteboards as mindmaps** — curved connectors, keyboard mindmap mode
  (Tab / Enter / Shift-Tab / arrows / F2, auto-arrange), hatch a board to a
  context page.
- Rebranded from Logseq (`logseq/og`): name, icons, URL scheme (`kip://`),
  config dir (`~/.kip`), bundle id (`app.kip`). Auto-updater disabled.
- Windows + Linux x64 builds via GitHub Actions.

### Known limitations

Unsigned binaries; no auto-updater; no installer (folder-zip); no macOS or
mobile; skills run unsandboxed.
