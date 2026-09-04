# Kip — design document

Kip is a fork of [Logseq](https://github.com/logseq/og) (the open-source,
file-over-app, local Markdown knowledge base) with one addition: a
**retrieval layer** that uses an LLM to turn raw source documents into a
maintained, cross-linked personal wiki, and surfaces that wiki back inside
the Logseq UI.

"Kip" is Dutch for *chicken*. The whole system is named with one coherent
chicken/farm metaphor (below), so the pieces are easy to keep straight.

- **`README.md`** (repo root) — the always-current operator's manual.
- **`docs/BUILD.md`** — how to build, run, and package.
- **`docs/FEATURES.md`** — the full feature list.
- **`docs/VS-LOGSEQ.md`** — every deliberate difference from upstream.
- **`coop/schema.md`** — the rules an LLM agent follows when maintaining a
  nest (the "constitution" for Hatch/Peck/Groom).

---

## 1. What problem it solves

Logseq is a great place to *write* notes and link them by hand. It is not a
place that *builds structure for you*. Kip adds exactly that: you drop a
document in (a meeting export, an article, a health-data dump), and an LLM
proposes which wiki pages it touches, drafts them, links them, and — over
time — keeps them honest. You still own and edit everything; the LLM writes
into one clearly-bounded zone and never touches your own notes.

The design constraints that shaped everything:

1. **Files stay the source of truth.** Every LLM-written page is a plain
   Markdown file with YAML frontmatter. Delete `.roost/` and rebuild it from
   the files (`rebuild-roost`) — it's a derived index (the page table +
   full-text search), machine-local, and not synced. The one thing a rebuild
   can't recover is `hatched_sources`, the per-file "already hatched" memory:
   after a bare rebuild the next Hatch re-proposes pages for every source
   instead of updating them. Nothing else is locked inside an app.
2. **One bounded write zone for your notes.** The core workflows (Hatch,
   Peck, Groom) write only under `nest/` and never edit a note in `pages/`
   or a journal in `journals/`. Dropped source material lands in `pages/`
   itself — the single drop-box (§2) — and an Office/PDF drop becomes a
   converted `.md` sibling there (its original is parked outside the graph).
   The one other exception is **skills** (§5.4), which write their
   deliverables to `exports/` and their own config under `.henhouse/`.
   Sandboxing skill filesystem access is on the deferred list.
3. **Provider-agnostic.** Anthropic, OpenAI, DeepSeek, a local Ollama model,
   or any OpenAI-compatible endpoint — one config file, one code path.
4. **Observable and reversible.** Every LLM call is timed and (optionally)
   traced. Every workflow logs what it did. Groom *reports* — it never edits
   or deletes a `nest/` page; the most it changes is the derived index (a
   drifted one-line summary, refreshed in `meta.db` — §5.3).

---

## 2. The metaphor / vocabulary

| Kip term | What it is | Logseq/generic equivalent |
|---|---|---|
| **coop** | the graph folder you open | vault / graph |
| **pages/** | the unified source folder — Logseq's own notes directory *and* the drop-box for source material; an Office/PDF drop becomes a converted `.md` sibling | notes + `raw/` inbox |
| **nest/** | the LLM-maintained wiki | `wiki/` |
| **clucks/** | append-only monthly activity log | `log/` |
| **.roost/** | the SQLite index (`meta.db`) + per-run artifacts | `.index/` |
| **.henhouse/** | LLM provider config (`llm.json`, gitignored) | `.config/` |
| **Hatch** | turn a source into nest pages | ingest |
| **Peck** | ask a question, get a cited answer | ask / query / chat |
| **Groom** | health-check the nest | lint |
| **The Nest** | the in-app graph view, scoped to `nest/` | graph view |
| **Grains** | the left-sidebar menu group | — |

---

## 3. Repository layout

```
prj01/
├── scripts/           # the retrieval layer — plain Node
│   ├── lib/
│   │   ├── db.js          # opens coop/.roost/meta.db, owns the schema
│   │   ├── paths.js       # path helpers + type↔folder map; KIP_COOP_ROOT
│   │   ├── roost.js       # upsertPage, searchPages, findSimilarSlug,
│   │   │                  #   appendLog, regenerateIndexMd, recentClucks,
│   │   │                  #   hatchedSourceHashes, slug similarity, wikilinks
│   │   ├── pages.js       # resolvePage() — the ONE create-vs-update writer
│   │   ├── llm.js         # callLLM() — the ONE provider-swappable LLM call
│   │   ├── prompts.js     # every prompt, built on callLLM()
│   │   ├── hatch.js       # propose → plan → write
│   │   ├── whiteboard.js  # tldraw .edn → nested-bullet outline (deterministic)
│   │   ├── peck.js        # search → read → cited answer (+ skills loop) → (file)
│   │   ├── skills.js      # discoverSkills() + runSkill() — Peck's tool harness
│   │   ├── telemetry.js   # per-run LLM-call timing/token recorder
│   │   └── run-progress.js# the live progress/trace file writer (shared)
│   ├── skills/            # built-in Peck skills: xlsx-csv/, web-search/, docx/, pptx/, kip-control/
│   ├── hatch.js           # CLI: single source, with y/n review
│   ├── hatch-all.js       # CLI: batched "Hatch sources", no review
│   ├── peck.js  chat.js   # CLI: ask a question (chat.js = JSON, for the app)
│   ├── skills-list.js     # dump discovered skills (content-free)
│   ├── groom.js           # CLI: quick + --deep health check
│   ├── rebuild-roost.js   # rebuild meta.db + index.md from the .md files
│   ├── recent-clucks.js   # tail the activity log
│   ├── package.json       # the pure-JS deps that ship inside the app
│   └── test/              # node:test suites — 121 tests, no live API needed
├── coop/                  # the default coop the CLI uses (schema.md lives here)
├── docs/                  # this folder
└── app/                   # the Logseq fork (its own git repo)
    └── src/
        ├── main/frontend/components/   # renderer: chat, ingest, telemetry,
        │                               #   wiki_status, container, header
        └── electron/electron/          # main process: wiki (shell-out),
                                        #   llm (in-process settings), handler
```

---

## 4. The retrieval layer

### 4.1 Data model — `meta.db`

SQLite + FTS5, via `better-sqlite3`. Fully derived from the Markdown files —
`npm run rebuild-roost` recreates it from scratch at any time.

| table | columns | purpose |
|---|---|---|
| `pages` | slug, path, type, tags(JSON), summary, created, updated | one row per nest page |
| `pages_fts` | slug, body | FTS5 full-text index over page bodies |
| `log` | id, timestamp, kind, title, pages_touched(JSON) | every Hatch/Peck/Groom run |
| `hatched_sources` | path, hash(sha1), hatched | so a re-hatch only touches changed files |

### 4.2 The nest — page types

Every page is `coop/nest/<dir>/<slug>.md` with frontmatter
(`type`, `created`, `updated`, `tags`; hatched pages also carry `source`
+ `source_hatched` pointing back at the document they were derived from,
`source_original` for converted Office siblings, and the LLM's `summary`
one-liner — which `rebuild-roost` reads back, so a rebuild keeps it).

| folder | contents |
|---|---|
| `nest/entities/` | a person, place, or recurring thing (a doctor, a gym, a project) |
| `nest/concepts/` | a recurring theme (sleep, a habit, a goal being tracked) |
| `nest/sources/` | one summary page per hatched source, linking out to the entities/concepts it touched; for a whiteboard, a deterministic outline under an LLM "Context" section (regenerated wholesale each hatch) |
| `nest/index.md` | **generated** catalog — a browsing aid, never read back |

Pages are **additive over time**. When a new source updates an existing
page, the new content is appended under a dated `_Update <date>:_` section
rather than overwriting — the page reads as *a history of what's known*, not
just the latest belief. Reconciling those sections is Groom's job, not
Hatch's.

### 4.3 Duplicate prevention — the hard rule

Before creating any page, `findSimilarSlug(title)` (normalised Levenshtein
over existing slugs, threshold 0.45) checks for a near-match. A close match →
**update that page instead of creating a new one**. This is the single most
important invariant: near-duplicate pages are how a nest degrades, and it is
far cheaper to prevent them than to merge later. The same check runs in
`resolvePage()` at write time — one implementation, no second guess.

### 4.4 The LLM abstraction

`callLLM({ system, prompt, json, maxTokens, label })` in `lib/llm.js` is the
only place any provider SDK or HTTP call lives. It routes by
`coop/.henhouse/llm.json` (or the `PROVIDER` / `*_API_KEY` / `*_MODEL` env
vars), and always returns `{ text, raw }`:

- **anthropic** — the Anthropic Messages API (SDK).
- **openai / deepseek / local / other** — one generic OpenAI-compatible
  chat-completions client; only base URL / key / model differ. `json:true`
  tries native `response_format`, falls back to prompt-and-strip.

`llm.json` shape: `{"provider": "...", "providers": {"<name>": {"apiKey":
"...", "model": "...", "baseUrl": "..."}}}` — a field the file omits falls
back to its env var, so nothing breaks for env-only setups. Written by the
in-app **LLM settings** panel, so a user never touches shell env vars.

### 4.5 Telemetry

Every `callLLM` records into `lib/telemetry.js` — a per-process singleton:
duration, token counts, and a **phase** derived from the call's `label`
(`hatch:propose`, `hatch:draft`, `hatch:whiteboard`, `hatch:generate:<type>`,
`peck:answer`, `groom:coherence`, …). `summary()` / `entries()` are **content-free** —
counts and timings only, never a prompt or response. A separate opt-in
`onTrace` sink gets the full text.

`hatch-all.js` and `groom.js --deep` wire this into `lib/run-progress.js`,
which writes:

- `<coop>/.roost/<name>-progress.json` — continuously during a run: a rolling
  activity feed + the running metrics, for the app to poll.
- `<coop>/.roost/<name>-metrics.json` — the final content-free summary.
- `<coop>/.roost/<name>-trace.jsonl` — **only with `--trace`** (or
  `KIP_HATCH_TRACE=1`): every call, prompts and responses included. Stays
  inside `.roost/` — no coop content leaves the documented workflow.

---

## 5. The workflows

### 5.1 Hatch — source → nest pages

**Default (combined, one LLM call per file):** `proposeAndDraftPages()` sends
the source once and gets back `{pages: [{title, type, tags, summary,
body}]}` — it decides which pages the source touches *and* drafts every body
in the same call. Then `findSimilarSlug` resolves create-vs-update per page
(no LLM), and `resolvePage()` writes each — a create writes the body as-is, an
update appends it under a dated `_Update_` section. One `appendLog('hatch',
…)` entry per run.

Measured (4-page source, DeepSeek): **1 call / ~14 s** vs the classic path's
5 calls / ~33 s.

**Provenance (kip-app#113):** every page a hatch writes carries
`source:`/`source_hatched:` frontmatter naming the source it came from, and each
`type: source` page gets a `## Source` block (file, content hash, date) — so
a nest page is always traceable back to its raw document. A one-line
`summary:` is written to frontmatter too (so `rebuild-roost` keeps it instead
of re-deriving a first paragraph) and into `meta.db`, where Peck reads it
above each page body and a deep Groom refreshes it if it drifts (§5.3).

**Classic (`--classic` / the "Classic mode" checkbox):** the older path — one
`proposeCandidatePages` call, then one `generatePageContent` call *per page*,
each re-sending the full source. Kept for a side-by-side comparison in the
telemetry panel.

**"Hatch sources" (batch, no review):** `hatch-all.js` runs the whole
workflow over every new-or-changed file in `pages/`, `journals/`,
and `whiteboards/`, in batches of 10, tracked by content hash in
`hatched_sources` so a re-run only touches what changed. Skipped: near-empty
stubs, and files over ~1 MB (a context-window backstop — chunking large
sources is a follow-up). The single-file `hatch.js` keeps a y/n plan review;
the batch path does not (deliberate — bulk convenience for this one path).

**Whiteboards / mindmaps → a context page:** a `whiteboards/<name>.edn` board
becomes `nest/sources/<board>.md` via `hatchWhiteboard()` in two parts:

1. *Outline* — deterministic. `lib/whiteboard.js` `parseWhiteboard` reads the
   tldraw shapes + `:bindings`; `whiteboardToOutline` walks the arrows
   depth-first into a nested bullet list (edge labels → `_(annotations)_`,
   cycles → an `↑` marker, unconnected shapes trail as a flat list).
2. *Context* — one LLM call (`describeWhiteboard` in `lib/prompts.js`, phase
   `hatch:whiteboard`). `findRelatedPages` searches the node labels against
   `meta.db` and passes the matched slugs alongside the outline; the model
   writes a short interpretation (themes, how branches relate, imbalances,
   gaps) with `[[slug]]` links. Best-effort — a `try/catch` around the call
   means no provider or a transient failure just yields an outline-only page
   (`enriched: false`).

The page (`source` type, tagged `whiteboard`) is a **full replace** every run,
not an `_Update_` append — the board is the source of truth and the Context is
re-derived. No propose/draft call, no entity/concept drafting, no plan review.
Still gets a `hatched_sources` hash row and one `appendLog('hatch', …)`.

### 5.2 Peck — ask it, or tell it

Every Peck turn is auto-classified (`classifyPeckInput`) as a **question** or
a **statement**.

**A question:**

1. Full-text search `meta.db` for the question. When that direct search
   finds only a few hits, a second pass runs on key terms an LLM extracts
   from the question, unioned in for recall; when the direct search already
   found enough, the second pass (and its LLM call) is skipped.
2. **Read the index first, then descend only where it points** (the LLM-wiki
   Query rule, kip-app#106). The model is handed the question plus the
   candidate *index* — one line per page, its slug and one-line `summary`
   (§5.1) — and returns the slugs it needs to read. Only those pages are then
   read from disk and passed to the answer; a failed or empty selection falls
   back to the full candidate set.
3. Ask the LLM for an answer that cites every claim with `[[slug]]`
   wikilinks. A citation resolves to a `nest/` page, and that page carries
   `source:` frontmatter pointing at the source it was hatched from (§5.1) — so
   the chain answer → page → source document is walkable. If the coop has
   any **skill** configured (§5.4), the model can call one or more before
   answering.
   - The turn also reports back which retrieved pages the answer actually
     cited, any `[[link]]` that resolves to no page at all, and — from
     `.roost/lint.json` — whether a cited page is one Groom flagged
     (kip-app#116, kip-app#117). Display-only; retrieval is unchanged.
4. `appendLog('peck', …)`. The CLI asks whether to file the answer as a
   `concept` page; the app offers a per-answer "file into the nest"
   control instead (kip-app#112), and logs the question turn either way. A
   filed answer keeps a `## Sources` list of the pages it drew on.

**A statement** ("the CDO of CompanyX is John Doe") — a fact to remember:

1. Search for the pages the fact might belong on.
2. `captureFacts` decides what to write, **preferring an update to a
   relevant existing page** (the CompanyX page, a John Doe page) over a new
   one; a new `entity`/`concept` page only for something substantial with no
   page yet. Updates append under a dated `_Update_` section via the same
   `resolvePage()` / `findSimilarSlug` path as Hatch — no duplicates.
3. `appendLog('told', <statement>, <touched slugs>)`. A statement that adds
   nothing new writes no page and logs `told` with an empty slug list.

The in-app Peck panel renders `[[slug]]` links as real clickable page links,
and shows a "✓ Learned — updated [[companyx]], created [[john-doe]]" note
after a capture.

### 5.3 Groom — health checks (reports only; never edits a `nest/` page)

**Quick** (`npm run groom`) — fast: deterministic structural checks over
`meta.db` *and* the `nest/` / source filesystem, plus one light contradiction
pass:

- **orphan pages** (no inbound wikilink), **filesystem drift** (`meta.db` ↔
  disk mismatch → `rebuild-roost`), **near-duplicate slugs**, **sources
  changed since hatch**, **possible contradictions** (pages batched ≤6 by
  type/tag, one LLM check each).

**Deep** (`groom.js --deep` / the "Deep groom (weekly)" button) — the planned
weekly session; many LLM calls, minutes:

- **page coherence** — an LLM read of each page with multiple `_Update_`
  sections: internal contradictions, redundancy, superseded claims. (This is
  where the reconciliation Hatch defers actually gets looked at.)
- **summary drift** — is the one-line summary still accurate for the grown
  body? A better one is written straight back to `meta.db` `pages.summary`
  (kip-app#115) — the derived index, not the markdown file — and the report
  notes it as refreshed.
- **missing links** — prose that names another page without linking it
  (deterministic scan → LLM confirm, to skip incidental word matches).
- **merge candidates** — same-type pages the slug check missed that share
  links / a rare tag → LLM decides if they're one subject.
- **broken links / dead-end pages** — deterministic.
- **deeper contradictions** — larger groups, plus each entity/concept checked
  against the source pages that cite it.

Output: `<coop>/.roost/groom-report.md` — a dated `- [ ]` checklist the human
works through — plus telemetry, and `<coop>/.roost/lint.json` (slug →
findings) which Peck reads at answer time to flag a cited page that Groom
found orphaned / contradicted / drifted (kip-app#116). Every checklist item
is a suggestion; Groom never edits or deletes a `nest/` page.

### 5.4 Skills — Peck's tool loop

A **skill** is a Claude-Code-style folder — a `SKILL.md` manifest
(frontmatter: `name`, `description`, `when_to_use`, `parameters`, `entry`,
`network`, `timeout`) plus a Node entry script. Built-ins live in
`scripts/skills/`; a user drops more in `<coop>/.henhouse/skills/` (same
name overrides a built-in). `<coop>/.henhouse/skills.json` tunes them:
`disabled` (names not offered to Peck), `secrets` (per-skill API keys), and
`config` (per-skill non-secret settings). `secrets[name]` and `config[name]`
are both spread into that skill's child-process env; `runSkill`'s `{env}` option
layers on top (the settings "Test" button trying unsaved values). The
**Settings → Skills** tab (`frontend.components.skills-settings` →
`electron.skills` → `scripts/lib/skills.js`, in-process like `electron.llm`) is
the GUI: an on/off toggle per skill + the web-search backend picker.

The turn classifier routes a trailing `?`, a leading question word, *or* a
leading generative verb (`make` / `create` / `build` / `generate` /
`summarize` / `draft` / …) to the question path — so "make me a Word doc from
the Q3 sheet" reaches the loop instead of being taken as a fact to file.

When Peck answers a **question** and the coop has any enabled skill,
`answerFromPages` runs `answerQuestionWithSkills` (`scripts/lib/prompts.js`)
in place of the single `answerQuestion` call: a bounded **ReAct text loop** —
the system prompt lists the skills and the protocol, the model replies with
either `<use_skill name="X">{json}</use_skill>` or a final answer, a tool
call is run and its output fed back as `<skill_result>…</skill_result>`,
repeat, ≤ 4 calls. **`callLLM` is untouched** — the loop is a text protocol,
not native function-calling, so it works with any provider (this repo's
default is a reasoning model). Labels `peck:answer` / `peck:skill-turn`.

`runSkill` (`scripts/lib/skills.js`) spawns the entry with `process.execPath`
(plain Node from the CLI, Electron-as-Node from the app), `cwd` = the skill
folder, env carrying `KIP_COOP_ROOT`, `KIP_EXPORTS_DIR`, `SKILL_INPUT` (the
args as JSON) and the skill's secrets. 60 s timeout, ~8 KB stdout cap.
Generated files go to `<coop>/exports/`. Each run is one content-free
`skill:<name>` telemetry entry; the full I/O reaches only the trace
(`.roost/peck-trace.jsonl`, written with `--trace` / `KIP_PECK_TRACE=1`).

**Graceful degradation is a rule** — no skills, a skill that errors, one that
times out, or a bug in the loop, all downgrade to the plain `answerQuestion`.
The result carries `steps: [{skill, input, ok, ms, outputPreview}]`, which the
Peck panel renders as `⚙` lines above the answer (live from
`.roost/peck-progress.json` while it runs).

Built-ins: `xlsx-csv` (SheetJS — read/summarize a spreadsheet in the coop),
`web-search` (`scripts/skills/web-search/search.js` — **DuckDuckGo by default,
keyless, active**; parses the `html.duckduckgo.com/html/` no-JS endpoint;
Brave/Tavily optional, key-gated, chosen via `SEARCH_BACKEND` in `skills.json`
`config`), `docx` and `pptx` (build a
Word doc / a deck into `<coop>/exports/`). The document skills take an
**optional** template kept in the coop — a `.docx` with `{tags}`
(`docxtemplater`), a `.pptx` cloned per slide (`pptx-automizer`), or a small
JSON brand theme for `pptx` — and otherwise generate from a structured
outline (`docx` package / `pptxgenjs`). `kip-control` turns a Peck turn into a
control surface for Kip itself: `status`, Hatch (`hatch-preview` / `hatch` /
`hatch-progress`), Groom (`groom` quick inline / `groom-deep` / `groom-progress`
/ `groom-report`), `rebuild-roost`, and the settings page (`settings`,
`set-provider`, `test-connection`, `set-skill`). Reads go through the same
`lib/` the app uses; long jobs are `spawn`-detached copies of the CLI scripts
(`hatch-all.js`, `groom.js --deep`) that outlive the skill process and report
via `.roost/*-progress.json`. It refuses to disable itself.

Files a skill writes land in `<coop>/exports/`. The **Exports panel**
(`frontend.components.exports`, a right-sidebar pane, `:wikiExport*` IPC →
`electron.wiki`) lists that folder and drives open / reveal / save-a-copy /
trash per file — the renderer passes only a filename, `electron.wiki`
re-validates it against `exports/` before touching the disk.

### 5.5 Reminders — time-aware, with prep

`scripts/lib/reminders.js` owns `<coop>/reminders.json` — a plain JSON array,
**not** in `.roost/` (which is "derived, safe to delete") since it's user data.
`chrono-node` turns "meeting with Acme Friday at 15h, remind me a day before"
into `{ title, eventAt, leadMin }`; `notifyAt = eventAt − leadMin`.

`peckTurn` gets a `looksLikeReminder` short-circuit before the
question/statement split — a phrase like "I have a meeting …" / "remind me …"
routes to the skills path (the `reminders` skill creates the row), never to
fact capture. `intent: 'reminder'` on the result.

Firing is the one long-lived piece: **`electron.reminders`** runs a
`setInterval` (60 s, plus a catch-up ~5 s after launch) mirroring
`electron.git/configure-auto-commit!`. Each tick shells `reminders.js --due
--json` for every open graph; that script retrieves related nest pages, drafts
a short prep brief (`generateMeetingPrep`, one `reminders:prep` LLM call,
`[[cited]]`; `null` → a bare page list), marks the reminder `notified`, writes
a `reminder` clucks entry, and returns it. `electron.reminders` then shows an
OS `Notification` (`silent` = the reminder's `sound === false`) and pushes
`"reminder-fired"` → the renderer opens the **Reminders panel**
(`frontend.components.reminders`, `:wikiReminders*` IPC) and, when `sound`,
plays a synthesized two-note chime (`reminders/ding!`, WebAudio, no asset).
`sound` defaults to `true`, is parsed from "silently"/"no sound" at create
time, and is togglable per reminder (the panel's 🔔, `reminders.js mute|unmute`,
or the skill's `mute`/`unmute` actions). Nothing fires while Kip is closed —
the catch-up tick handles what was missed. Out of scope for now: recurrence,
snooze, an OS-level timer for a closed app.

**Trust model.** A skill is arbitrary Node code, unsandboxed, with the user's
privileges. Built-ins are reviewed here; a user skill is like adding a shell
script. The runner limits blast radius but does not contain it.

---

## 6. How the app talks to the retrieval layer

The retrieval layer is plain Node; the app is Electron. They do **not** share
a process, because `better-sqlite3`'s native addon can't be ABI-correct for
both plain Node and Electron at once.

```
renderer component (chat / ingest / wiki-status / telemetry)
   │  ipc/ipc "wikiChat" | "wikiIngestBatch" | "wikiGroomDeep" | ...
   ▼
electron.handler  (defmethod handle :wikiChat …)
   ▼
electron.wiki/run-node-script!
   │  spawn(process.execPath, ["<app>/scripts/<x>.js", ...args],
   │        { env: { ELECTRON_RUN_AS_NODE: "1", KIP_COOP_ROOT: <graph dir> } })
   ▼
scripts/<x>.js   (runs as plain Node — the app's own Electron binary,
                  loading the app's Electron-ABI better-sqlite3)
   │  stdout = pure JSON  →  parsed and returned to the renderer
```

- **One code path.** The exact same `scripts/<x>.js` the terminal runs.
- **`ELECTRON_RUN_AS_NODE`** means a packaged Kip needs no system Node — it
  runs its own bundled Electron binary as the interpreter.
- **`KIP_COOP_ROOT`** = whatever graph folder the user has open. The scripts
  operate on *that* coop (`pages/`, `nest/`, `.roost/`, `.henhouse/` inside
  it), not a fixed location.
- **Not** routed through Logseq's `electron.shell` command-runner (that's an
  allow-list for known tools like git/pandoc); the one
  renderer-supplied string (the Peck question) is passed as an argv entry to
  a no-shell spawn.
- The exceptions: **LLM settings** (`electron.llm` → `js/require` of
  `scripts/lib/llm.js`) and the **Skills settings tab** (`electron.skills` →
  `scripts/lib/skills.js`: the skill on/off list, the web-search backend config,
  and a "Test search" that calls `runSkill` directly) stay in-process — both
  libs have no native dependencies.
- A few `electron.wiki` calls skip the subprocess entirely and just touch the
  filesystem / `electron.shell` on the main thread: the `*-progress.json`
  polls, and the **Exports panel**'s `:wikiExportsList` (a `readdir`) +
  open / reveal / save-a-copy / `shell.trashItem`.

The bundled scripts ship at `<app>/scripts` with a **pure-JS**
`node_modules` (`gray-matter`, `dotenv`, `@anthropic-ai/sdk`);
`better-sqlite3` is resolved from the app's own Electron-ABI copy. The
repo-root `node_modules/better-sqlite3` stays plain-node for tests and the
CLI — two copies, two ABIs, on purpose. See `docs/BUILD.md`.

---

## 7. The app-side changes

Kip modifies the Logseq renderer/main in a handful of focused places. The
rebrand is real (name, bundle id, URL scheme, config dir) but stops short of
touching upstream attribution.

- **"The Nest"** — the left-sidebar graph view, scoped to the `nest/`
  subtree (`build-global-graph` filters to pages whose path starts with
  `nest/`). Journals and `pages/` are still parsed into the DB but don't show
  here.
- **"Grains"** — a collapsible left-nav group holding New page / Journals /
  Whiteboards / Flashcards.
- **New page modal** — creates an empty page (no default bullet); formatting
  is via the `/` slash menu.
- **Header "…" menu** — *Coop status*, *Peck*, *Hatch sources*, *Hatch
  telemetry*, *Exports*.
- **Pecking-first shell** — `:ui/peck-mode?` (default `true`, not persisted).
  When on, `frontend.components.container/main` renders
  `frontend.components.chat/peck-main` (a centred full-height Peck view) in
  place of the route content; when off, the normal editor/journal view. A
  sticky `[ Peck | Documents ]` switch (`peck-mode-switch`) sits at the top of
  the content area; `:ui/toggle-peck-mode` (`Ctrl/⌘+1`, rebindable, in the
  `global-prevent-default` handler group so it fires while editing) toggles it.
  `route-handler/set-route-match!` sets the flag from the route — `:home` → on,
  anything else → off — so navigation (incl. a citation click) is the natural
  way in and out. The old `kip-home-splash` / `kip-home-docs` are deleted; in
  Documents mode `:home` is just the journal list.
- **Peck conversation** — lifted to `chat/*peck-session` (a `defonce` atom), so
  `peck-main` and the right-sidebar `:chat` panel share one session-only
  history that survives a mode toggle. Answers render with clickable
  `[[wikilink]]` citations.
- **Exports panel** (right sidebar) — lists `<graph>/exports/`; open / reveal
  / save-a-copy / delete-to-trash per file, polled every ~4 s.
- **Hatch sources modal** — preview (pending files + size), batched run with
  a live progress bar + activity feed, a post-run Performance breakdown, and
  two checkboxes: *Record LLM activity* (full trace) and *Classic mode*.
- **Coop status modal** — recent clucks; *Run groom* (quick); *Deep groom
  (weekly)* with a live feed, a counts summary, an "Open report" button, and
  a "last deep groom N days ago" note.
- **Hatch telemetry** (right-sidebar pane) — the last run's performance
  breakdown, live-updating during a run.
- **LLM settings** — a Settings tab: provider dropdown, per-provider
  key(masked)/model/base-URL, a "Test connection" button, and a note that
  `<coop>/.henhouse/llm.json` is plaintext.
- **Whiteboard connectors + cards** — in the vendored tldraw fork
  (`app/tldraw/`), a connector bound at both ends draws a smooth mindmap
  S-curve (`getCurveControlPoints` / `getCurvedArrowPath` in
  `arrow/arrowHelpers.ts`, threaded through `Arrow.tsx` and `LineShape`'s
  indicator via a `curved` flag = `start.bindingId && end.bindingId`); the
  arrowhead follows the curve's end tangent. `BoxShape` default
  `borderRadius` 2 → 8 (new boxes only). Rebuilt with `yarn build` in
  `app/tldraw/apps/tldraw-logseq` → `tldraw-logseq.js`, then a `:app`
  recompile.
- **Keyboard mindmap mode** (`frontend.handler.mindmap`, wired to the
  whiteboard container's `:on-key-down` in `frontend.extensions.tldraw`) —
  pure cljs over the tldraw App API, **no tldraw state-machine changes**.
  Reads the page's shapes + `bindings` into a parent→child graph, then:
  Tab = add a child (`currentPage.addShapes` + `api.createNewLineBinding`,
  mirroring the built-in clone-node), Enter = add a sibling, arrows =
  navigate the graph, Backspace/Del = prune a leaf, F2 = edit, Mod+Shift+M =
  recursive right-growing layout via `api.updateShapes`. Active only with
  exactly one node selected and nothing being edited; otherwise the event
  passes straight through (the handler fires on React's synthetic bubble,
  before tldraw's `window` keydown listener and Logseq's global shortcut
  handler, so a handled key is `stopPropagation`'d and the rest are not).
- **Auto-updater disabled** — a live fork must not self-update to upstream.

---

## 8. What's deliberately deferred

- **Portability of the bundled scripts to another machine** — the 0.1 build
  runs its LLM features on the machine it's built on; a truly portable
  package (script chunking, a bundled Node, mobile-native identifiers) is a
  follow-up.
- **Chunking sources > 1 MB** — currently skipped, not split.
- **A non-reasoning model for the draft call** — the telemetry shows
  reasoning tokens dominate; a per-call model override is a cheap next win.
- **Cross-file concurrency in a Hatch batch** — needs a DB-write mutex.
- **A Skills settings tab** — DONE: **Settings → Skills**
  (`frontend.components.skills-settings`) — per-skill on/off + the web-search
  backend picker. Generic per-skill `config` forms (beyond web-search) are a
  follow-up.
- **Richer template plumbing for `docx` / `pptx`** — `pptx` template mode does
  a best-effort text swap onto the first slide's placeholders (by vertical
  order); named-placeholder mapping, chart/table fill, and multi-layout
  templates are a follow-up. Bundled sample templates (needs `{ encoding:
  false }` on the gulp `syncScripts` `gulp.src`) are also deferred.
- **Skill sandboxing / a first-use allowlist / non-Node skills** — v1 skills
  are trusted, Node-only, timeout+output-capped.
- **A spawn timeout on `electron.wiki/run-node-script!`** — `runSkill` bounds
  each skill; a hung LLM provider could still stall a turn.
- **Deep mobile/iOS/Android rebrand + CI artifact names** — no toolchain
  here, no value for a Windows desktop build.
- **Voice input for Peck (Whisper)** — a mic button in the Peck panel
  (`chat.cljs`); record via renderer `MediaRecorder`, transcribe, drop the text
  into the input box for review (never auto-send — Peck files statements as
  facts). Engine is an open choice: (a) an OpenAI-compatible
  `/audio/transcriptions` endpoint — Groq / OpenAI / a local whisper server,
  config under a `voice` key in `.henhouse/llm.json`, routed through a new
  in-process `electron.whisper` → `scripts/lib/transcribe.js` (no native dep,
  like `electron.llm`); (b) a bundled `whisper.cpp` binary + model (offline,
  ~150 MB, first native exe); (c) `@xenova/transformers` in the WebView (offline,
  heavy dep, slow on CPU). Settings home: a "Voice" section on the
  **Settings → Skills** (or LLM) tab.
