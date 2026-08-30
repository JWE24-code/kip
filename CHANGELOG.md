# Changelog

All notable changes to Kip. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions track
`app/src/main/frontend/version.cljs`.

The retrieval layer (this repo) and the desktop app
([kip-app](https://github.com/JWE24-code/kip-app)) are released together.

## [Unreleased]

### The retrieval layer (`scripts/`)

- **Peck remembers the last few turns** (kip-app#82) — `peckTurn` /
  `chat.js` take a `--history` buffer of recent `{role, text}` turns.
  A follow-up ("expand on that", "and their salary?", "the second one")
  now resolves what it refers to: the recent turns are folded into
  retrieval (so a question with no shared nouns still finds pages) and
  passed to the answer as a *"Conversation so far"* block (marked
  not-a-source). A bare continuation right after a Kip answer also
  classifies as a question rather than a new fact. Session-only.

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
