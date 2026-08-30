# Kip — development

> Moved here from the README. Build, run, and dev-environment notes for the
> retrieval layer (`scripts/`). The desktop app is at
> [JWE24-code/kip-app](https://github.com/JWE24-code/kip-app).

**Kip** (Dutch for chicken) is a personal knowledge base with a coherent
chicken/farm metaphor: source documents are **eggs**, the LLM-maintained
wiki is the **nest**, the activity log is **clucks**, its index cache is
the **roost**. It's built on a fork of
[logseq/og](https://github.com/logseq/og) — the file-based, markdown-first
Logseq (not the newer database-backed `logseq/logseq` rewrite). This repo
is the local dev setup.

## Layout

```
.
├── app/            # fork of logseq/og — the Kip application source, built and run from here
├── coop/           # a graph (a plain folder of markdown files) opened by the app
├── scripts/        # retrieval layer for coop/nest/ — see below
├── package.json    # deps for scripts/ (better-sqlite3, gray-matter)
└── README.md
```

### `coop/`

```
coop/
├── journals/       # the app's native daily notes — written by the app; also a hatch source
├── pages/          # the app's native pages — written by the app; also a hatch source
├── eggs/           # immutable source documents dropped in by hand; never edited once added
├── nest/           # LLM-maintained markdown pages ("The Nest")
│   ├── index.md    # generated catalog of the nest — regenerate with `npm run rebuild-roost`
│   ├── entities/
│   ├── concepts/
│   └── sources/
├── clucks/         # one markdown file per month, e.g. 2026-08.md — written by appendLog()
├── exports/        # files the docx/pptx/… skills generate
├── reminders.json  # time-based reminders (Kip-owned; created via Peck / the Reminders panel)
├── .roost/         # meta.db (SQLite) — disposable cache, safe to delete/rebuild
│                   #   (also holds `hatched_sources`: per-file content hashes so
│                   #    "Hatch sources" re-hatches only what changed)
└── schema.md       # rules doc for how nest/ is maintained (read this before editing nest/)
```

`journals/`, `pages/` and `whiteboards/` are the graph app's own folders —
it reads/writes them directly. `eggs/`, `nest/`, `clucks/`, `.roost/`, and
`schema.md` are this project's own additions on top of a normal graph. The
nest pipeline treats `eggs/`, `journals/`, `pages/`, and `whiteboards/` all
as read-only **hatch sources** — it synthesizes `nest/` pages from them and
never edits them. (A `whiteboards/*.edn` board becomes a deterministic
text outline plus a one-call LLM "Context" section; the rest go through the
full multi-call LLM hatch.)

The whole `coop/` tree here is just the default the CLI scripts use. The
Kip app operates on **whatever folder you open as your graph** — see
"Pointing it at a coop" below.

### `scripts/` — the retrieval layer

```
scripts/
├── lib/
│   ├── db.js       # opens/creates coop/.roost/meta.db, ensures schema
│   ├── paths.js    # path helpers + the type<->nest-subfolder mapping
│   ├── roost.js    # upsertPage, searchPages, findSimilarSlug, getPage,
│   │                # appendLog, regenerateIndexMd, recentClucks, slugSimilarity,
│   │                # extractWikilinkSlugs
│   ├── pages.js    # resolvePage() — shared create-vs-update / duplicate-
│   │                # prevention logic, used by peck.js and hatch.js
│   ├── llm.js      # callLLM() — the ONE provider-swappable LLM entry point —
│   │                # plus loadLLMConfig/saveLLMConfig, see "LLM provider
│   │                # config" below. Hosts lib/connectors.js.
│   ├── connectors.js # the connector registry: each provider is a ProviderSpec
│   │                # (fields + complete()); built-ins + bundled/graph-local
│   │                # connectors (install from a .tgz, @kip-ai/* allowlist)
│   ├── kip-connector.js # the managed-backend "kip" connector (AGPL, built-in)
│   ├── preference-signals.js # the "is the kip connector active" gate — every
│   │                # preference-signal surface (kip-app#73) checks it
│   ├── feedback-poster.js # batches content-free preference signals and POSTs
│   │                # them to the managed backend; kip-only, best-effort
│   ├── untar.js    # zero-dep npm-tarball (.tgz) extractor for connector install
│   ├── telemetry.js # per-run LLM-call timing/token recorder every callLLM()
│   │                # feeds; content-free summary() + opt-in full-text trace
│   │                # + onFeedback sink for preference signals (kip-app#73)
│   ├── prompts.js  # prompt content built on callLLM(): extractKeyTerms,
│   │                # answerQuestion, answerQuestionWithSkills (the Peck tool
│   │                # loop), flagContradictions, proposeAndDraftPages, ...
│   ├── skills.js   # discoverSkills() + runSkill() — the Peck skills harness
│   ├── peck.js     # askQuestion(), fileAnswerToNest() — the Peck workflow's
│   │                # core logic, used by both scripts/peck.js and any other
│   │                # caller (e.g. a GUI app) — see below
│   ├── hatch.js    # proposeHatchPlan(), commitHatchPlan(), hatchAllSources(),
│   │                # hatchWhiteboard()
│   └── whiteboard.js # parseWhiteboard() + whiteboardToOutline() — a tldraw
│                     # .edn board → a nested-bullet outline (deterministic;
│                     # the Context section on top is one LLM call — prompts.js)
├── skills/           # built-in Peck skills — xlsx-csv/, web-search/, docx/, pptx/, kip-control/ (SKILL.md + run.js)
├── rebuild-roost.js  # rebuilds meta.db + nest/index.md from coop/nest/*.md
├── peck.js           # thin CLI wrapper around lib/peck.js — see below
├── groom.js          # the Groom workflow — see below
├── hatch.js          # the single-file Hatch workflow — see below
├── hatch-all.js      # the batched "Hatch sources" workflow (app's Hatch modal)
├── chat.js           # non-interactive JSON sibling of peck.js (app's Peck panel)
├── skills-list.js    # content-free dump of discovered skills
├── recent-clucks.js  # thin wrapper around recentClucks() (app's Coop status panel)
└── test/
    ├── roost.test.js
    ├── pages.test.js
    ├── groom.test.js
    ├── llm.test.js
    ├── hatch.test.js
    ├── peck.test.js
    ├── telemetry.test.js
    ├── whiteboard.test.js
    └── skills.test.js
```

Setup and use, from the project root:

```powershell
npm install             # installs deps (better-sqlite3, gray-matter, dotenv, @anthropic-ai/sdk)
npm test                 # runs the retrieval-layer tests (node's built-in test runner)
npm run rebuild-roost    # (re)builds coop/.roost/meta.db and coop/nest/index.md
                         # from whatever's currently on disk under coop/nest/ —
                         # safe to run any time, including after hand-editing a page
npm run peck "what do I know about X?"    # the Peck workflow, see below
npm run groom                            # the Groom workflow, see below
npm run hatch <path-to-source>           # the Hatch workflow, see below
```

`meta.db` and `nest/index.md` are both fully derived from the markdown
files under `nest/` — delete either and `npm run rebuild-roost` rebuilds
them. Nothing should hand-edit `nest/index.md` or `coop/clucks/*.md`; see
`coop/schema.md` for the full rules an LLM agent follows when maintaining
the nest, including how `searchPages`/`findSimilarSlug` are used for
retrieval and duplicate prevention.

#### LLM provider config

`peck.js`/`groom.js`/`hatch.js` never call an LLM provider's SDK or HTTP
API directly — everything goes through `callLLM()` in `scripts/lib/llm.js`,
which picks a backend at runtime, resolved **per field** in this order:
`coop/.henhouse/llm.json` (if present) first, then the env vars below as
fallback.

```powershell
cp .env.example .env   # CLI-only path — fill in the section for your PROVIDER
```

```jsonc
// coop/.henhouse/llm.json — the GUI-app path: read/written via
// loadLLMConfig()/saveLLMConfig() in scripts/lib/llm.js, never through shell
// env vars. Gitignored — holds API keys in plaintext. A field this file
// doesn't set (or the file not existing at all) falls back to the matching
// env var below.
{
  "provider": "anthropic",
  "providers": {
    "anthropic": { "apiKey": "...", "model": "claude-sonnet-4-6" },
    "openai": { "apiKey": "...", "model": "...", "baseUrl": "..." },
    "deepseek": { "apiKey": "...", "model": "..." },
    "local": { "baseUrl": "http://localhost:11434/v1", "model": "..." }
  }
}
```

| `PROVIDER` | Needs | Notes |
|---|---|---|
| `anthropic` (default) | `ANTHROPIC_API_KEY` | Model defaults to `claude-sonnet-4-6` — override via the config file's `providers.anthropic.model`, no env var for it. Leaving both the file and `ANTHROPIC_API_KEY` unset falls through to the Anthropic SDK's own credential chain (`ant auth login`, etc.) — unlike the other providers, there's no hard failure for missing credentials at this layer. |
| `openai` | `OPENAI_API_KEY`, `OPENAI_MODEL` | `OPENAI_BASE_URL` defaults to `https://api.openai.com/v1` — point it at any OpenAI-compatible endpoint. |
| `deepseek` | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODEL` defaults to `deepseek-chat`. Fixed base URL. |
| `local` | `LOCAL_MODEL` | No API key. `LOCAL_BASE_URL` defaults to `http://localhost:11434/v1` (Ollama). |

`openai`/`deepseek`/`local`/`other` all share one generic OpenAI-compatible
chat completions client — adding another provider that speaks that format
(Kimi, Qwen via DashScope, most LocalAI setups) is one more `ProviderSpec`
in `lib/connectors.js`, not a new HTTP client. `llm.js` is the *host*: it
picks the spec from the registry, resolves its `fields` (file over env over
default), calls `spec.complete()`, and records telemetry. External
connectors (the managed Kip backend) register through the same registry.
Every CLI script prints which provider/model is active at the start of its
run (to stderr, so `groom.js --json`'s stdout stays pure JSON).

**Privacy note:** switching `PROVIDER` to a hosted third-party backend sends
coop content (which may include health/personal data) to that provider,
same as it already does for Anthropic. `local` (Ollama) keeps everything on
this machine.

#### `peck.js` — ask the nest, or tell it something

```powershell
node scripts/peck.js "what do I know about sleep?"          # a question
node scripts/peck.js "the CDO of CompanyX is John Doe"      # a fact to remember
```

`scripts/lib/peck.js`'s `peckTurn(input, {fileToNest, vaultRoot})`
classifies the input (`classifyPeckInput`) and dispatches:

- **A question** → `askQuestion`: search (direct + key-term pass, unioned),
  read the candidate pages, ask the LLM for a `{answer, citedSlugs,
  candidateSlugs}` with `[[slug]]` citations. The CLI prints it and asks
  (y/n) whether to file it as a `concept` page; the app does not file
  answers.
- **A statement** → `captureFacts` + `fileCapturedFacts`: it files the fact
  onto the relevant existing page (appended under a dated `_Update_`
  section) or plainly creates an `entity`/`concept` page — same
  create-vs-update / `findSimilarSlug` resolution as `hatch.js`, no
  duplicates — and logs a `told` clucks entry. A statement with nothing new
  writes no page.

`scripts/chat.js` (the app's Peck panel backend) calls `peckTurn` with
`fileToNest: false`.

**Follow-up context** (kip-app#82) — `peckTurn(input, { history })` /
`chat.js --history '<json>'` takes a short buffer of recent turns
(`[{ role, text }]`, oldest→newest, clipped by the app). It flows into
`classifyPeckInput` (a bare "tell me more" / "the second one" after a Kip
answer classifies as a question, not a statement), `extractKeyTerms` +
`retrieveCandidates` (so a follow-up with no shared nouns still retrieves —
the recent user turns are folded into the direct FTS query and the
pronouns are resolved for the key-term pass), and `answerQuestion` /
`answerQuestionWithSkills` (a "Conversation so far:" block, marked
not-a-source). `prompts.formatConversation` does the clipping/formatting.
Session-only; the app resets the buffer when the Peck conversation clears.

- **Tell it about an upcoming event** ("I have a meeting with Acme on Friday
  at 15h", "remind me to email Bob tomorrow") → `peckTurn` detects the
  reminder intent and routes to the `reminders` skill instead of fact
  capture. See `scripts/reminders.js` below.

#### `reminders.js` — time-based reminders with prep

```powershell
node scripts/reminders.js add "meeting with Acme on friday at 15h, remind me a day before"
node scripts/reminders.js add "1:1 with Sam tuesday 14:00 --silent"   # or "…, no sound"
node scripts/reminders.js list
node scripts/reminders.js mute 1        # / unmute 1
node scripts/reminders.js cancel 1
node scripts/reminders.js --due --json  # what the app scheduler calls each minute
```

Natural language (via `chrono-node`) → `{title, eventAt, leadMin}` in
`<graph>/reminders.json`. `--due` fires every pending reminder whose lead
time has arrived: it retrieves related nest pages, drafts a short prep brief
(one LLM call, `[[cited]]`; degrades to a bare page list with no provider),
marks the reminder `notified`, and logs a `reminder` clucks entry. The app's
minute-resolution scheduler (`electron.reminders`) drives this and shows an OS
notification plus a short chime (unless that reminder is muted — `sound: false`
in `reminders.json`, set per-reminder via "remind me silently", the panel's 🔔,
or Peck "mute the … reminder"). Nothing fires while Kip is closed (caught up on
next launch). `KIP_REMINDER_TRACE=1` streams the LLM I/O to
`.roost/reminders-trace.jsonl`.

**Needs credentials for whichever `PROVIDER` is configured** (see above).
The classify → capture/answer paths, the `told` log, and the
update-don't-duplicate routing are all tested in
`scripts/test/peck.test.js` against a mocked LLM (`PROVIDER=local` + a
mocked `fetch`).

##### Skills — Peck's tool loop

When answering a **question**, if the graph has any enabled **skill**, the
model can call one or more before it answers (`answerQuestionWithSkills` in
`scripts/lib/prompts.js` — a bounded ReAct **text** loop: the model emits
`<use_skill name="X">{args}</use_skill>` or a final answer; ≤ 4 calls). It
uses whatever `PROVIDER` is configured — no native function-calling.

A skill is a folder with a `SKILL.md` manifest + a Node entry script:

- **built-in** — `scripts/skills/` (`xlsx-csv`, `web-search`, `docx`, `pptx`, `kip-control`).
- **user** — `<graph>/.henhouse/skills/<name>/` (a user skill of the same
  `name` overrides a built-in).

`<graph>/.henhouse/skills.json` (optional, gitignored) tunes them:

```jsonc
{
  "disabled": ["docx"],                                   // don't offer these to Peck
  "secrets":  { "web-search": { "BRAVE_API_KEY": "…" } },  // per-skill API keys (private)
  "config":   { "web-search": { "SEARCH_BACKEND": "brave" } } // per-skill non-secret settings
}
```

Both `secrets` and `config` for a skill are spread into its child-process env.
The app's **Settings → Skills** tab is the GUI for all of this: an on/off toggle
per skill and the web-search backend picker + key fields.

`node scripts/skills-list.js` prints what's discovered (content-free — no
secrets, no paths). `xlsx-csv` reads/summarizes a spreadsheet in the coop;
`web-search` searches the web — **DuckDuckGo by default, no key, on out of the
box** (Peck may search whenever a question needs facts the wiki lacks); Brave or
Tavily can be selected instead (each needs a key). `docx` / `pptx` build a
Word doc / a deck into `<graph>/exports/` from an outline, or from an optional
`.docx`/`.pptx`/JSON-theme template in the coop; `kip-control` drives Kip's own
workflows from a Peck turn — `status`, `hatch-preview`/`hatch`/`hatch-progress`,
`groom`/`groom-deep`/`groom-progress`/`groom-report`, `rebuild-roost`, and the
settings page (`settings`, `set-provider`, `test-connection`, `set-skill`). Long
jobs are launched detached (the same CLI scripts the app's buttons shell out to)
and report via `.roost/*-progress.json`. A request phrased as
"make/create/build/summarize…" routes to this path (not fact-capture). A skill
runs with a 60 s timeout, an 8 KB output cap, `cwd` scoped to its folder, and
`KIP_COOP_ROOT` + `SKILL_INPUT` (the args as JSON) in its env. Any failure —
no skills, a skill error, a timeout — falls back to a plain answer.

`scripts/chat.js "…" --trace` (or `KIP_PECK_TRACE=1`) streams every LLM +
skill call, full I/O, to `<coop>/.roost/peck-trace.jsonl`; the content-free
`peck-metrics.json` is always written. Trust model: a skill is arbitrary
Node code, unsandboxed — built-ins are reviewed here, a user skill is like
adding a shell script. Tested in `scripts/test/skills.test.js`.

#### LLM connectors

`lib/connectors.js` is the provider registry `llm.js` hosts. A connector is
a `ProviderSpec` v1 (`{ kipConnectorApi:1, id, label, fields[], envDefaults,
isReady, complete(resolved, call, ctx) }`; `ctx` = `{ fetch, signal, logger }`
only). Three sources:

- **built-in** — `anthropic` / `openai` / `deepseek` / `local` / `other`, in
  `connectors.js`, plus **`kip`** — the managed-backend connector
  (`lib/kip-connector.js`; AGPL-3.0, first-party). Their ids can never be
  shadowed. The settings UI hides `kip` from the dropdown until the user
  opts in (kip-app#58).
- **bundled** — an allowlisted package shipped as an app dependency
  (`BUNDLED_CONNECTORS`). Rides the normal app auto-update.
- **graph-local** — installed from an npm `.tgz` into
  `<graph>/.henhouse/connectors/<dir>/`, listed in
  `<graph>/.henhouse/connectors.json` (`[{ id, name, version, dir }]`).
  Overrides a *bundled* connector of the same id.

`installConnectorFromTarball(tgz, vaultRoot)` extracts with `lib/untar.js`
(zero-dep, path-traversal/size guarded — **no `npm` shell-out**), checks the
package name against `ALLOWLIST` (`@kip-ai/*` — a host constant, not
user-editable), validates the `ProviderSpec`, and refuses an id that
collides with a built-in or an already-installed connector.
`removeConnector(id, vaultRoot)` deletes the dir + the config entry. A
connector that fails to load is skipped with a warning — it never throws
into `callLLM()`. Trust boundary: a graph-local connector is `require`d
into the process with `fetch`, so the allowlist is the gate. Tested in
`scripts/test/connectors.test.js` + `untar.test.js`.

`callOpenAICompatible` for `json:true` tries native `response_format:
{type:"json_object"}` and falls back to prompt-and-strip on any error.
Reasoning models reject `response_format`, so two things spare them the
wasted round-trip: `isReasoningModel(model)` (name match — `deepseek-reasoner`,
`r1`, `o1`/`o3`/`o4-mini`, `qwq`, `magistral`, `*reasoning`/`*thinking`;
`gpt-4o` doesn't match) skips the native attempt from the first call, and a
process-lived `Set` (`learnedNoResponseFormat`, keyed `baseUrl::model`)
records any model that returns a **400** on `response_format` so every later
call in the run skips it too. Net: a name-list miss costs one extra
round-trip once, never more (kip-app#68). The managed backend does the
equivalent server-side for `model:"auto"` picks.

**The `kip` connector** (`lib/kip-connector.js`) POSTs to
`{baseUrl}/v1/chat/completions` with `Authorization: Bearer kip_…` and
`X-Kip-Workload` (the full call label) / `X-Kip-Phase` (its first
`:`-segment) routing headers; body is `{ model: "auto", max_tokens,
messages }`. `baseUrl` defaults to `https://api.kip-ai.be`, overridable to
a self-hosted backend. It reads the `X-Kip-Call-Id` response header and
returns it as `callId` on `{ text, raw, callId, arenaId }` — `callLLM`
passes that through and records it in telemetry; every other connector
returns `callId: null`. Contract: `JWE24-code/kip-backend` →
`KIP-BACKEND.md`. Tested against a mocked `fetch` in
`scripts/test/kip-connector.test.js`.

A call carrying `arena: { compareToCallId }` (only `answerQuestion`, for a
Peck regenerate — see below) goes to `{baseUrl}/v1/arena/completions`
instead, with `compare_to_call_id` set so only candidate B runs. The
response is `{ arena_id, origin, b: { …completion, kip_call_id }, a? }`;
the connector returns B's text, `callId: b.kip_call_id`, and
`arenaId: arena_id` (mirrored by the `X-Kip-Arena-Id` header).

**Preference signals** (epic kip-app#73) — content-free feedback (behaviour,
micro-ratings, blind arena) that tunes the managed router.

- `lib/preference-signals.js` — `preferenceSignalsEnabled(vaultRoot)` is the
  one gate: true only when the active provider is `kip`.
  `preferenceSignalsTarget()` hands back its resolved `{ baseUrl, apiKey }`
  (or null) for the `/v1/feedback` and `/v1/arena/*` POSTs. The renderer
  reaches this through an IPC shim. Everything downstream — block marking,
  the rating widget, the behaviour watcher, the arena UI — is gated on it,
  so a direct Anthropic/OpenAI/DeepSeek/local provider sees none of it.
- `telemetry.onFeedback(fn)` / `telemetry.sendFeedback(signal)` — a sink
  parallel to `onTrace`, but for closed enum/int signals only (`reset()`
  clears it too).
- `lib/feedback-poster.js` — `createFeedbackPoster({ vaultRoot })` →
  `{ enqueue, flush, stop }`: batches, auto-flushes every 5 s on an
  `unref()`'d timer, `flush()` is capped at 1 s, and it re-checks
  `preferenceSignalsTarget` on every enqueue/flush so switching provider
  mid-run stops it. `sanitizeSignal` reduces a signal to the wire field set
  (`rating`: `call_id/kind/score/scale`; `behavior`:
  `call_id/kind/behavior/edit_bucket`) — a stray `text`/`prompt`/`note`
  can't ride along. `installFeedbackPoster()` wires one to `telemetry` +
  a `beforeExit` flush; every CLI entrypoint calls it right after
  `telemetry.reset()`. `postArenaVerdict(arenaId, winner, { vaultRoot })` is
  the sibling one-shot for an arena A/B verdict (`winner` ∈
  `a`/`b`/`tie`/`skip`) — POSTs to `{baseUrl}/v1/arena/<id>/verdict`; the
  app drives it from its `:kipArena` IPC.
- **The regenerate free-rider** — `peckTurn(input, { arenaCompareToCallId })`
  / `chat.js --arena-compare-to <callId>` re-answers a question as arena
  candidate B against the first answer. `answerFromPages` takes the plain
  `answerQuestion` path for it (no skills — they add per-run variance that
  muddies a model-vs-model comparison). The turn result carries `arenaId`;
  the app shows a "was this better?" strip and posts the verdict.

#### `groom.js` — coop health checks

```powershell
node scripts/groom.js          # quick — structural checks, formatted report
node scripts/groom.js --json   # quick, raw JSON
node scripts/groom.js --deep   # the weekly session (see below)
```

Read-only in every mode — groom reports, it never edits a `nest/` page.

**Quick** (`meta.db` only, one light LLM pass — fast, no artifacts):

- **Orphan pages** — no inbound `[[wikilink]]` from any other page.
- **Filesystem drift** — a `meta.db` row with no file on disk, or a file with
  no `meta.db` row. Fix with `npm run rebuild-roost`, not by hand.
- **Near-duplicate slugs** — any two pages scoring at or above the
  `findSimilarSlug` threshold, catching drift past new-page duplicate prevention.
- **Possible contradictions** — the one quick check that calls the LLM, in
  small groups (by type, sub-split by shared tags). A failed group is skipped
  with a warning, not fatal.

**`--deep`** — the once-a-week review. Everything above, plus:

- **Page coherence** — an LLM read of each page with multiple dated
  `_Update_` sections (which the one-call Hatch appends without reconciling):
  internal contradictions, redundancy, superseded claims.
- **Summary drift** — is each page's one-line `meta.db` summary still accurate
  after the body has grown; suggests a replacement.
- **Missing links** — prose that names another page without `[[linking]]` it
  (deterministic scan → LLM confirm, to skip incidental word matches).
- **Merge candidates** — same-type pages the slug check missed that share
  outbound links / a rare tag; an LLM decides if they're the same subject.
- **Broken links / dead-end pages** — `[[targets]]` with no page; pages that
  link out to nothing.
- **Deeper contradictions** — larger groups, plus each entity/concept checked
  against the source pages that cite it.

Deep runs many LLM calls / several minutes. It writes
`<coop>/.roost/groom-report.md` — a dated **checklist** you work through — and
`groom-metrics.json`; while running it writes `groom-progress.json` for the
app to poll (same shape as the hatch feed). All gitignored.

Logs one summary line via `appendLog('groom', ...)` with counts per category
— not which pages, just how many.

The deterministic checks are fully unit-tested; the LLM checks take injectable
stubs (`deps` on `runGroom`) — see `scripts/test/groom.test.js`.

#### `hatch.js` — turning a source into nest pages

```powershell
node scripts/hatch.js path/to/journal-export.md            # combined: one LLM call
node scripts/hatch.js path/to/journal-export.md --classic  # old path: propose + one call per page
```

1. Copies the source into `coop/eggs/` if it isn't already there
   (unconditional — happens before anything else, even if you abort at the
   confirmation step).
2. **One LLM call** (`proposeAndDraftPages`): decides which pages the source
   touches — always one `source` page, plus any `entity`/`concept` page
   substantial enough to warrant one — **and drafts every page's body in the
   same call**. The source text is sent once.
3. Resolves create-vs-update for each via `findSimilarSlug()` — no writes yet.
4. Prints the plan and asks (y/n) before writing anything.
5. If confirmed: writes each via `resolvePage()` (update pages get the draft
   appended under a dated `_Update_` section — additive, per `coop/schema.md`;
   contradiction-checking is `groom`'s job), syncs `meta.db`, and records one
   `appendLog('hatch', ...)` entry for the whole run.
6. Prints a summary of what was created/updated.

`--classic` (or `KIP_HATCH_CLASSIC=1`) restores the earlier flow — one
`proposeCandidatePages` call, then one `generatePageContent` call **per
page**, each re-sending the full source. Kept for quality/latency comparison
via the telemetry panel; a real run went from 5 calls / 33 s of LLM time to
**1 call / 14 s** for the same 4-page source.

The deterministic planning logic (`planCandidates`, reusing `findSimilarSlug`
— not reimplementing its threshold), the combined/classic call counts, and
the `eggs/` copy are all unit-tested without a live LLM; see
`scripts/test/hatch.test.js`.

## Running the app in dev mode

The dev dependencies (Clojure CLI, Babashka, JDK 17, Yarn) were installed
user-scoped (no admin rights used) — see "System dependencies" below if
setting up on another machine.

From `app/`:

```powershell
cd app
yarn                 # install JS deps (first time / after resources/package.json changes)
yarn watch           # builds and watches both the browser (:app) and Electron (:electron) targets
```

Wait until the terminal prints `Build Completed.` for both `:app` and
`:electron`, then in a **second** terminal:

- **Browser dev build:** open <http://localhost:3001>
- **Desktop (Electron) dev build:**
  ```powershell
  cd app
  yarn dev-electron-app
  ```
  (or `bb dev:electron-start` to do the watch + electron launch in one command)

### Pointing it at a coop

On first launch the app shows an "Open a local directory" / "Open a graph"
picker (a native OS folder dialog). **Whatever folder you pick becomes the
coop.** The in-app features create and read `eggs/`, `nest/`, `clucks/`,
`.roost/`, and `.henhouse/` directly inside that folder — the renderer
passes the open graph's directory to every Coop/LLM IPC call, and the
scripts receive it as the `KIP_COOP_ROOT` env var (see
`scripts/lib/paths.js`).

The repo's own `./coop` is only the fallback the CLI scripts use when run
directly with no `KIP_COOP_ROOT` set. Open it here if you want the app to
work against the same data the CLI does.

### In-app features (Electron desktop build only)

All gated on `util/electron?` (invisible in the browser dev build):

- **Peck — the pecking-first main channel** — Kip lands in Peck. It fills the
  centre of the window (`frontend.components.chat/peck-main`); **Documents**
  (the normal editor / journal view) is a mode you toggle into with **`Ctrl/⌘+1`**
  (`:ui/toggle-peck-mode`, rebindable) or the **`[ Peck | Documents ]`** switch
  at the top of the content area. Opening any page (including clicking a
  citation) drops you into Documents; going home returns to Peck. **`Ctrl/⌘+2`**
  opens document search (aliased onto `mod+k`). The same conversation is also
  available as a right-sidebar panel ("..." menu → "Peck"); history is
  session-only, shared between the two.
  Ask a question → an answer whose `[[wikilink]]` citations render as real
  clickable page links (`frontend.components.block/inline-text`). Tell it a
  fact ("the CDO of CompanyX is John Doe") → auto-classified as a statement,
  filed into the nest (updating a matching page or creating one), and a
  "✓ Learned — updated [[companyx]]" note shown. Question *answers* are
  still not auto-filed from the panel (deferred).
- **Peck skills** — if the graph has skills configured (see below), a question
  can trigger the model to call one or more before answering — each shows as a
  `⚙ <skill>  0.8s` line above the answer, live from
  `<coop>/.roost/peck-progress.json` while the turn runs.
- **No home screen** — Kip is pecking-first, so the `:home` route *is* Peck.
  In Documents mode, home is just the journal list (the old `kip-home-splash` /
  `kip-home-docs` are gone). Peck's own empty state carries the ASCII-chicken
  identity and a few example prompts.
- **LLM settings** — a tab in Settings ("..." → Settings → LLM): provider
  dropdown, per-provider API key (masked)/model/base URL, a "Test
  connection" button that fires a trivial call against the form's *current*
  (possibly unsaved) values, and a note that the config file it writes
  (`<coop>/.henhouse/llm.json`) is plaintext, not encrypted at rest.
- **Hatch sources** — a menu item ("..." → "Hatch sources") that turns
  **new-or-changed** files in `<coop>/eggs/`, `<coop>/journals/`,
  `<coop>/pages/`, and `<coop>/whiteboards/` into nest pages, **with no
  per-file review**. A `whiteboards/*.edn` board becomes
  `nest/sources/<board>.md` (`hatchWhiteboard()`): a **deterministic outline**
  of its shapes (`scripts/lib/whiteboard.js`) under a short **LLM-written
  "Context" section** (`describeWhiteboard`, one call) that interprets the map
  and `[[links]]` related nest pages — degrading to outline-only when no
  provider is configured. A full replace of the page each time (the board is
  the source of truth). Draw a mindmap, hatch it, and its text version is
  searchable and citable like any other source. The modal
  first shows a preview (pending file list + total size) with no LLM
  calls; you click **Start**, and it processes files in **batches of 10**
  (large coops would otherwise be one huge, slow, costly run) — click
  again for the next batch. Each file is recorded in the `hatched_sources`
  table by content hash, so a re-run only touches what actually changed and
  a run that dies part-way resumes cleanly. `findSimilarSlug()`-based
  create-vs-update still runs per page (that's not what's skipped) — what's
  skipped is the human check of the LLM's proposed page titles/types.
  Skipped and reported: near-empty stub files, and files over ~1 MB (a
  context-window backstop — chunking large-but-viable sources is a follow-up).
  Each file takes **one LLM call** (propose + draft every page together);
  the **"Classic mode"** checkbox restores the call-per-page path for a
  side-by-side comparison in the telemetry panel.
  While a batch runs the modal shows a live **activity feed** — every LLM
  call with its phase (`hatch:propose` / `hatch:generate:<type>`), duration
  and token counts — and afterward a **Performance** breakdown (per-phase
  totals, slowest calls, per-file wall time). Tick **"Record LLM activity"**
  first to also see each call's response and reasoning text inline. All of
  this comes from `scripts/lib/telemetry.js`, which every `callLLM()` records
  into; `hatch-all.js` writes a content-free `<coop>/.roost/hatch-metrics.json`
  per run, and — with `--trace` / `KIP_HATCH_TRACE=1` — the full prompts and
  responses to `<coop>/.roost/hatch-trace.jsonl` (both gitignored).
- **Coop status** — a menu item ("..." → "Coop status"): the last few
  clucks (recentClucks), a fast **"Run groom"** button, and **"Deep groom
  (weekly)"** — the full LLM review, with a live activity feed while it runs,
  a counts summary, an "Open report" button for the `groom-report.md`
  checklist, and a "last deep groom N days ago" note.
- **Exports** — a right-sidebar panel ("..." → "Exports";
  `frontend.components.exports`) listing `<graph>/exports/` — the files the
  `docx` / `pptx` / … skills produce — newest first, polled every ~4 s. Per
  row: open (OS default app), reveal in folder, save a copy… (native save
  dialog), delete (to the OS trash, via a confirm modal). The renderer only
  ever sends a filename; `electron.wiki` re-validates it against `exports/`
  before acting. e2e: `app/e2e-tests/exports.spec.ts`.
- **Whiteboard mindmap drawing** — in the vendored tldraw fork
  (`app/tldraw/`): a connector bound to a shape at *both* ends is drawn as a
  smooth mindmap S-curve (leaving/entering along the dominant axis), with the
  arrowhead following the curve's end tangent; a free-standing line stays
  straight. New boxes get an 8px corner radius (was 2px); existing boxes are
  untouched. `arrow/arrowHelpers.ts` (`getCurveControlPoints`,
  `getCurvedArrowPath`), `arrow/Arrow.tsx`, `LineShape.tsx`, `BoxShape.tsx`;
  rebuilt via `npx tsup` in `app/tldraw/apps/tldraw-logseq` (see
  `docs/BUILD.md`).
- **Keyboard mindmap mode** (`frontend.handler.mindmap`, hooked into the
  whiteboard container's `:on-key-down` in `frontend.extensions.tldraw`) —
  with exactly one node selected and nothing being edited: **Tab** adds a
  connected child (and starts editing it), **Enter** adds a sibling,
  **Shift+Tab** selects the parent, **arrow keys** move the selection to the
  connected node in that direction, **Backspace/Delete** prunes a childless
  node and reselects its parent, **F2** edits, **Mod+Shift+M** auto-arranges
  the tree into a right-growing map. All cljs over the tldraw App API (no
  changes to the tldraw state machine); the handler fires on React's bubble
  phase, so a handled key is `stopPropagation`'d before tldraw's `window`
  keydown listener and Logseq's global shortcut handler see it, and any key
  it doesn't claim passes straight through.

The **graph view** (left sidebar, renamed "The Nest") is scoped to the
`nest/` subtree — `frontend.handler.graph/build-global-graph` filters nodes
and links to pages whose file path starts with `nest/` (via
`db/get-pages-by-file-prefix`). `journals/`, `pages/`, `eggs/` and `clucks/`
files are all parsed into the DB as pages too, but don't show here. Pure
renderer, no IPC. The per-page mini-graph in the right sidebar is unchanged.

**How the LLM surfaces reach the scripts:** Peck, Hatch, and Coop status
all **shell out** to a thin CLI script per call, through `electron.wiki`'s
`run-node-script!` — `node scripts/<x>.js` under plain Node (no shell; args
passed as an argv array), with `KIP_COOP_ROOT` set to the open graph's
directory. One code path, the same script the terminal runs. Only **LLM
settings** still goes in-process (`electron.llm`, a `js/require` of
`scripts/lib/llm.js`) — and only because `llm.js` has no native
dependencies. The IPC channel keys still carry a `wiki*` prefix (`:wikiChat`,
`:wikiIngestPreview`, `:wikiIngestBatch`, `:wikiIngestProgress`,
`:wikiRecentLog`, `:wikiLint`, `:getLlmConfig`, `:saveLlmConfig`,
`:testLlmConnection`) — an internal detail left unchanged; each carries the
coop root as its first arg.

**Why not in-process for all of them?** Peck and Hatch pull in
`scripts/lib/db.js` → `better-sqlite3`, whose native addon is a
version-locked V8 addon (**not** N-API — an early assumption here that
turned out wrong: it throws the classic `NODE_MODULE_VERSION` mismatch).
One `better_sqlite3.node` can't satisfy both plain Node's ABI (what the
shelled-out scripts need) and Electron's bundled Node ABI (what an
in-process `require` from the main process needs) at the same time. Shelling
out sidesteps it entirely — the scripts run under whatever `node` is on
PATH, which is also what `npm test` / the CLI use. See "better-sqlite3 ABI"
under System dependencies.

**Main-process changes need an app restart to take effect** — unlike the
renderer (`:app` build), which hot-reloads, `:electron` build changes
(anything in `electron.*` namespaces, including new IPC handlers) only
load once at startup. After editing anything under `app/src/electron/`,
fully quit and relaunch (`yarn dev-electron-app`), not just wait for the
watcher.

## System dependencies

Installed for this environment, user-scoped, no admin rights required:

| Tool | Version | Notes |
|---|---|---|
| Node.js | already present | `logseq/og`'s CI pins Node 22; this machine has a newer Node already installed. No build issues seen from this so far. |
| Yarn (classic) | 1.22.x | installed via `npm install -g yarn` |
| JDK | Microsoft Build of OpenJDK 17 | installed via `winget install --id Microsoft.OpenJDK.17 --scope user`. **See "Java version pinning" below — it does not "just work" on this machine.** |
| Clojure CLI | 1.12.5.1664 | installed via the [casselc/clj-msi](https://github.com/casselc/clj-msi) installer (`MSIINSTALLPERUSER=1`), since Scoop isn't set up on this machine |
| Babashka | 1.13.219 | installed via `winget install --id Babashka.Babashka --scope user` (optional — only needed for `bb dev:electron-start`) |

If setting this up fresh on another Windows machine without winget/admin
access, see `app/docs/develop-logseq-on-windows.md` for Scoop-based and
manual installer alternatives.

### Visual Studio Build Tools — worked around, no admin rights needed

The **Electron desktop dev build** (`yarn dev-electron-app`) needs native
Node modules rebuilt against Electron's ABI via `node-gyp`, which normally
needs a full MSVC C++ toolchain (`gyp ERR! find VS ... Could not find any
Visual Studio installation`) — and this user has no local admin rights, so
installing Visual Studio Build Tools isn't an option here.

**It turned out only one native module actually needed a real compiler,
and it didn't need to be one at all:**

- `better-sqlite3` — has a prebuilt binary for Electron 41.7.1's ABI on
  win32-x64. `yarn install` in `static/` downloads it with no compiler
  needed; this one was never actually blocked.
- `electron-deeplink@1.0.10` — its `binding.gyp`/`node-gyp rebuild` is
  **dead weight on Windows**: reading its compiled source
  (`dist/index.js`) shows the native binding is only loaded when
  `os.platform() === 'darwin'`; on every other platform it uses a pure-JS
  stub, and its Windows deep-link registration path
  (`app.setAsDefaultProtocolClient`) never touches native code. The
  package just runs `node-gyp rebuild` unconditionally on every platform
  regardless of whether the result is ever used.

Fix applied — `rebuildConfig: { ignoreModules: ['electron-deeplink'] }` in
`app/resources/forge.config.js` (the tracked source; gulp copies it to
`static/`) tells `electron-forge`'s native-rebuild step (the "Preparing
native dependencies" step in `yarn dev-electron-app`) to skip it entirely.
No behavior change on Windows/Linux — the native binding was never going to
be loaded there anyway.

**This does *not* fully fix a from-scratch `cd static && yarn install`** —
Yarn Classic triggers `node-gyp rebuild` for any package with a
`binding.gyp` unconditionally during its own install lifecycle (separate
from, and not covered by, `forge.config.js`'s `rebuildConfig`, which only
governs `electron-forge`'s later rebuild pass), and it still fails there
today. If you ever need a clean reinstall:

```powershell
cd static
yarn install   # fails on electron-deeplink's node-gyp step — that's expected, yarn still installs everything else first
cd node_modules\electron
node -e "require('@electron/get').downloadArtifact({version: require('./package').version, artifactName: 'electron', platform: 'win32', arch: 'x64'}).then(zip => require('extract-zip')(zip, {dir: './dist'})).then(() => require('fs').writeFileSync('./path.txt', 'electron.exe'))"
cd ..\..
```

(That last step exists because `electron`'s own postinstall — which
downloads `electron.exe` itself — silently no-ops if it runs as part of a
`yarn install` that ultimately exits non-zero from the electron-deeplink
failure elsewhere; running its download+extract directly sidesteps that.)
Then `yarn dev-electron-app` as usual.

**Verified live**, not just theorized: after this, `yarn dev-electron-app`
gets through "Preparing native dependencies: 3/3", launches a real
`electron.exe` process, and it stays up through Kip's normal startup
sequence (proxy setup, config-dir watching) with no errors.

### better-sqlite3 ABI

`scripts/lib/db.js` uses `better-sqlite3`, whose native addon
(`node_modules/better-sqlite3/build/Release/better_sqlite3.node`) is a
**version-locked V8 addon** — it checks `NODE_MODULE_VERSION` on load and
throws `ERR_DLOPEN_FAILED` ("compiled against a different Node.js version")
on a mismatch. (An early assumption that it was an ABI-stable N-API build
was wrong.)

Two things build against different ABIs:

- **Plain `node` on PATH** (currently v26, `NODE_MODULE_VERSION` 147) — what
  `npm test`, the CLI scripts, and the app's shelled-out `electron.wiki`
  calls all run under.
- **`electron-forge`'s "Preparing native dependencies" step** rebuilds
  native modules — *including the root `node_modules/better-sqlite3`* (it
  drops a `build/Release/.forge-meta` marker) — for **Electron's** bundled
  Node ABI (Electron 41 → 145).

So a `yarn dev-electron-app` run leaves the root `better-sqlite3` at ABI 145,
which then breaks `npm test` and every shelled-out script with a 145-vs-147
mismatch. **Fix: `npm rebuild better-sqlite3`** from the repo root — it
fetches the prebuilt binary for the current plain-Node ABI. The stale
`.forge-meta` (still saying 145) then makes `electron-forge` *skip*
re-rebuilding it on the next app launch, so the fix sticks until the next
`node` upgrade or `.forge-meta` deletion.

This is why the in-app Peck/Hatch features **shell out** rather than
`js/require` the scripts in-process: an in-process require from Electron's
main process would need the 145 binary, directly conflicting with what
everything else needs. Only `electron.llm` (LLM settings — `llm.js`, no
native deps) stays in-process.

### Java version pinning (`JAVA_CMD`)

This machine has an old Oracle Java 8 (`1.8.0_77`, from a system-wide
`C:\ProgramData\Oracle\Java\javapath` PATH entry) that shadows the JDK 17
installed above — `java -version` in a plain shell shows 1.8, and the
`JAVA_HOME` env var is correctly set to the JDK 17 install but is
**ignored** by the `deps.clj`-based `clojure`/`clj` CLI on this machine,
which resolves `java` from `PATH` first.

Fix applied: set a persistent user env var `JAVA_CMD` pointing at the
JDK 17 binary, which `deps.clj` *does* respect:

```
JAVA_CMD = C:\Users\<you>\AppData\Local\Programs\Microsoft\jdk-17.0.10.7-hotspot\bin\java.exe
```

This is already set (`[Environment]::SetEnvironmentVariable`, User
scope) — new terminals pick it up automatically. If `clojure -Sdeps '{}'
-M -e '(println (System/getProperty "java.version"))'` ever prints `1.8`
instead of `17.x`, this is why — check `JAVA_CMD` is still set.

### Known flaky bit: the Tailwind CSS watcher

`yarn watch` runs `gulp watch`, which spawns `yarn css:watch` (Tailwind/
PostCSS, `--watch` mode) as a child process with `stdio: 'inherit'`. When
`yarn watch` itself is run with its output redirected to a file (e.g. in
a background/non-interactive shell) rather than a real interactive
terminal, that child process was observed to exit silently ~14s after
starting, before it ever wrote `static/css/style.css` — the page loads
with no styling in that case (503 on `/css/style.css`).

This has not been seen when running `yarn watch` directly in a normal,
attached PowerShell terminal — do that, and you should get a normal
`Finished 'watchCSS'` message plus a live-updating `style.css`. If it
happens to you too: run a one-off compile to unblock, then investigate —
```powershell
npx postcss tailwind.all.css -o static/css/style.css --verbose
```

## Rebrand notes

Kip is a personal fork; a few upstream identifiers were deliberately left
alone: the `logseq/og` / `logseq/logseq` repo links (attribution), AGPL
headers, the per-graph `<graph>/logseq/` metadata folder (part of the graph
format), and `logseq.*` / `@logseq/*` code namespaces & npm deps. The
macOS code-signing identity and WiX `upgradeCode` in `forge.config.js` are
unchanged (only used by signed release builds, which aren't produced here).
The Android/iOS native build config was renamed only for the visible bits
(display name, URL scheme) — the deeper `com.logseq.og` package/bundle
identifiers, Xcode target, and CI artifact names are untouched (no mobile
toolchain here to verify against).

## License

Copyright © 2026 Joeri Weitmann.

This retrieval layer (`scripts/`) is licensed under the **GNU Affero General
Public License v3.0** — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). The Kip
desktop app is a fork of Logseq ([`logseq/og`](https://github.com/logseq/og) —
the file-based, markdown-first line, not the newer `logseq/logseq` rewrite),
AGPL-3.0, versioned separately at
[JWE24-code/kip-app](https://github.com/JWE24-code/kip-app). **Kip is not
affiliated with or endorsed by Logseq.** The wiki content under `coop/` is
personal data and not part of either repo.
