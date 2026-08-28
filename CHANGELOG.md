# Changelog

All notable changes to Kip. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions track
`app/src/main/frontend/version.cljs`.

The retrieval layer (this repo) and the desktop app
([kip-app](https://github.com/JWE24-code/kip-app)) are released together.

## [0.1.0] — unreleased

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
