# Kip — feature list

Everything Kip adds on top of Logseq. (Inherited Logseq features — the
Markdown editor, journals, block references, whiteboards, flashcards/SRS,
PDF annotation, themes, plugins, the query language — all work unchanged;
they're not listed here.)

## The retrieval layer (`scripts/`)

### Hatch — documents into wiki pages
- **One-call hatch (default)** — a source becomes a set of cross-linked
  `entity` / `concept` / `source` pages in a single LLM call: it proposes the
  pages *and* drafts every body at once. ~5× fewer calls than per-page.
- **Classic mode** (`--classic`) — the older propose-then-draft-per-page
  path, kept for quality/latency comparison.
- **Batch ingest** ("Hatch sources") — processes every new-or-changed file in
  `eggs/`, `journals/`, `pages/`, and `whiteboards/`, in batches of 10.
- **Whiteboards / mindmaps → a context page** — a `whiteboards/*.edn` board
  becomes `nest/sources/<board>.md`: a **deterministic outline** of its shapes
  (walking the arrows into nested bullets) under a short **LLM-written
  "Context" section** that interprets the map — what it's about, how the
  branches relate, imbalances and gaps — with `[[links]]` to related nest
  pages it finds. One LLM call, no plan review; falls back to outline-only
  when no provider is set. Full replace each time the board changes.
- **Incremental** — each file is tracked by content hash; a re-run only
  touches what actually changed, and a run that dies part-way resumes.
- **Duplicate prevention** — `findSimilarSlug` updates a near-matching page
  instead of creating a second one, every time.
- **Additive updates** — new info is appended under a dated `_Update_`
  section, never silently overwritten.
- **Single-file review path** (`npm run hatch <file>`) — prints the plan,
  asks y/n, then writes.
- **Guards** — near-empty stub files and files > ~1 MB are skipped and
  reported.

### Peck — ask it, or tell it
- **Ask a question** → full-text search + an LLM key-term pass (unioned for
  recall) → an answer that cites every claim with `[[slug]]` wikilinks back
  to the page (and from there to the underlying source). With **skills**
  configured (below), the model can call one or more mid-answer — a web
  search, a spreadsheet read, building a Word doc or a deck — before it
  answers.
- **Tell it a fact** ("the CDO of CompanyX is John Doe") → auto-detected as
  a statement and filed into the nest: it updates the relevant existing page
  where there is one, or plainly creates a page, so a later question finds
  it. Logged as a `told` clucks entry.
- **Tell it about an upcoming event** ("I have a meeting with Acme on Friday
  at 15h", "remind me to email Bob tomorrow", "don't forget the review on the
  20th") → auto-detected as a *reminder* (routed to the `reminders` skill, not
  fact capture). See **Reminders** below.
- Both from the CLI (`npm run peck "…"`) and the in-app panel — which shows
  clickable citations, and a "✓ Learned — updated [[x]]" note after a capture.

### Reminders — time-aware, with prep
- **Natural language** — "meeting with Acme Friday at 15h, remind me a day
  before" is parsed (via chrono) into an event time, a title, and a lead time
  (default 1 hour). Stored in a plain `<graph>/reminders.json`.
- **Notified ahead of time, with context** — a minute-resolution scheduler in
  the app checks pending reminders; when one reaches its lead time it does a
  nest retrieval + a short LLM **prep brief** (3-4 bullets, `[[cited]]`) and
  fires an **OS notification** + a **chime** + opens the Reminders panel.
  Degrades to a bare list of related pages with no LLM provider.
- **Sound is per-reminder** — the chime is on by default; say "remind me
  silently" / "no sound" when setting one, toggle the 🔔 in the panel, or ask
  Peck to "mute the … reminder". A muted reminder still fires and still shows
  its prep — it just doesn't make a sound.
- **Catch-up** — the scheduler only runs while Kip is open; a reminder that
  came due while it was closed fires within a few seconds of the next launch.
- **CLI** — `node scripts/reminders.js add "…"` / `list` / `cancel <id>`.
- **`reminders` skill** — the Peck path; toggle it in Settings → Skills.
- Each fired reminder is a `reminder` clucks entry.

### Skills — Peck's tool loop
- **User-addable capabilities** — a skill is a folder (`SKILL.md` +
  a Node entry script). Built-ins ship in `scripts/skills/`; drop your own in
  `<graph>/.henhouse/skills/`. Peck's answer step runs a bounded ReAct loop:
  the model calls `<use_skill name="X">{args}</use_skill>`, gets the output
  back, and can call another (≤ 4) before answering. Uses Kip's configured
  LLM provider — no native function-calling.
- **`xlsx-csv`** (built-in) — read and summarize a `.xlsx`/`.csv` in the coop
  (columns, row count, per-column stats, first rows).
- **`web-search`** (built-in) — searches the web. **DuckDuckGo by default —
  keyless, on out of the box**, so Peck may search whenever a question needs
  facts the wiki lacks. Switch to Brave or Tavily (each needs a key) in
  **Settings → Skills**, or turn the skill off there.
- **`docx`** / **`pptx`** (built-in) — build a Word document / a PowerPoint
  deck into `<graph>/exports/`, from an outline the model writes. A **template**
  is optional: a `.docx` with `{tags}`, a `.pptx` cloned per slide, or a small
  JSON brand theme for the deck — drop it in the coop and name it in the
  request. Ask naturally ("make me a doc…", "build a deck from the Q3 sheet")
  — those phrasings route to the skill loop.
- **`kip-control`** (built-in) — ask Peck to run Kip's own workflows: "what's
  pending", "hatch the new sources", "how's the hatch going", "run a groom",
  "start a deep groom", "which model am I on", "switch to deepseek", "turn off
  web-search", "rebuild the index". `hatch` and deep `groom` launch in the
  background and report progress; provider/model/key changes are written to
  `.henhouse/llm.json` and connection-tested on the spot.
- **Settings → Skills** (new tab) — toggle any skill on/off and pick the
  web-search backend + key. Writes `<graph>/.henhouse/skills.json`
  (`{ "disabled": [...], "secrets": {...}, "config": {...} }` — `secrets` and
  `config` are both spread into a skill's env).
- **Graceful** — no skills, a skill error, or a timeout never breaks the
  answer; it falls back to a plain answer.
- **Visible** — each skill call shows as a `⚙` line above the answer, live
  while it runs; `--trace` / `KIP_PECK_TRACE=1` streams full I/O to
  `<coop>/.roost/peck-trace.jsonl`.
- Generated files (a chart, later a doc/deck) land in `<graph>/exports/`.

### Groom — nest health checks (read-only)
- **Quick**: orphan pages, filesystem drift, near-duplicate slugs, a light
  contradiction pass.
- **Deep** (`--deep`, weekly): page-coherence review of `_Update_` sections,
  summary drift, missing links (scan + LLM confirm), content-level merge
  candidates, broken/dead-end links, and a deeper contradiction pass
  (entities ↔ the sources that cite them).
- Deep run writes `<coop>/.roost/groom-report.md` — a dated checklist.
- Never auto-fixes — every finding is a suggestion.

### Infrastructure
- **Provider-swappable LLM** — Anthropic, OpenAI, DeepSeek, local/Ollama, or
  any OpenAI-compatible endpoint. One config file
  (`<graph>/.henhouse/llm.json`) or env vars.
- **`rebuild-roost`** — rebuild the whole SQLite index + generated catalog
  from the Markdown files; safe to run any time.
- **`recent-clucks`** — tail the activity log.
- **Telemetry** — every LLM call is timed and token-counted, grouped by
  phase. Content-free `*-metrics.json` per run.
- **Trace mode** (`--trace` / `KIP_HATCH_TRACE=1`) — full prompts, responses,
  and model reasoning to `<coop>/.roost/*-trace.jsonl`.
- **161 automated tests** — the deterministic logic and the create-vs-update
  writer are covered without any live API; the LLM calls take injectable
  stubs.

## In the app

### Navigation
- **Pecking-first — no home screen** — Kip opens straight into **Peck**, filling
  the centre of the window. **Documents** (the normal editor / journals) is a
  mode you toggle into with **`Ctrl/⌘+1`** or the **`[ Peck | Documents ]`**
  switch at the top of the content area — think alt-tab between two windows.
  Opening any page (including clicking a citation) switches to Documents; going
  home returns to Peck. The old splash / "How Kip works" card is gone.
  **`Ctrl/⌘+2`** opens document search (a second binding for `mod+k`) — pick a
  result and you land in Documents.
- **"The Nest"** — the graph view, scoped to the `nest/` subtree.
- **"Grains"** — a collapsible left-nav group: New page, Journals,
  Whiteboards, Flashcards.
- **New page** — creates an empty page (no default bullet); formatting via
  the `/` slash menu.

### Panels & modals (Header "…" menu)
- **Peck** — the main channel (above); also openable as a right-sidebar chat
  panel to sit beside a document (same conversation). Ask a question → an answer
  with real clickable `[[wikilink]]` citations. Tell it a fact → a "✓ Learned"
  note and the fact filed into the nest.
- **Hatch sources** — preview (pending file list + total size, whiteboards
  flagged `[whiteboard]`), a batched run with a live progress bar and
  per-LLM-call activity feed, a post-run
  Performance breakdown (per-phase timings, slowest calls, per-file wall
  time), and toggles for *Record LLM activity* and *Classic mode*.
- **Coop status** — the last few clucks; a fast **Run groom** button; a
  **Deep groom (weekly)** button with a live activity feed, a counts
  summary, an **Open report** button for the checklist, and a "last deep
  groom N days ago" note.
- **Hatch telemetry** — a dockable right-sidebar pane showing the last run's
  performance breakdown, live-updating while a run is in progress.
- **Exports** — a right-sidebar panel listing `<graph>/exports/` (the files
  the `docx` / `pptx` / … skills produce), newest first, refreshing every few
  seconds. Per file: **open** (OS default app), **reveal in folder**, **save
  a copy…** (pick a destination), **delete** (to the system trash, after a
  confirm).
- **Reminders** — a right-sidebar panel: upcoming reminders (cancel any), and
  recently-fired ones with their prep brief rendered inline (clickable
  `[[citations]]`). A one-line add field; opens itself when a reminder fires.

### Whiteboards as mindmaps
- **Curved connectors** — an arrow between two shapes is drawn as a smooth
  mindmap S-curve (leaving/entering along the dominant axis) instead of a
  straight segment. A free-standing line (not bound at both ends) stays
  straight. The arrowhead follows the curve's end tangent.
- **Rounder cards** — new boxes get an 8px corner radius (was 2px); existing
  boxes keep whatever they were saved with.
- **Keyboard mindmap mode** — with exactly one node (box/ellipse/polygon)
  selected and nothing being edited:
  - **Tab** — add a child to the right, connected, ready to type
  - **Enter** — add a sibling (a child, on a root node)
  - **Shift+Tab** — jump to the parent
  - **Arrow keys** — move the selection to the connected node in that direction
  - **Backspace / Delete** — on a childless node: remove it and its connector,
    reselect the parent
  - **F2** — rename the selected node
  - **Mod+Shift+M** — auto-arrange the whole tree into a clean right-growing map
- **Hatch to a context page** — see *Hatch* above: a board becomes an outline
  + an LLM "Context" section under The Nest.

### Settings
- **LLM settings** tab — provider dropdown, per-provider API key (masked) /
  model / base URL, a "Test connection" button that tests the *current* form
  values, and a plaintext-at-rest warning for the config file.

### Behaviour changes
- **Vault = the folder you open.** All Kip data (`eggs/`, `nest/`, `clucks/`,
  `.roost/`, `.henhouse/`) lives inside whatever graph you have open, not a
  fixed location.
- **Auto-updater disabled** — a fork should not self-update to upstream.
- **App identity** — window title, About dialog, bundle id (`app.kip`), URL
  scheme (`kip://`), and config directory (`~/.kip`) are all Kip.
