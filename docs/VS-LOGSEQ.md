# Kip vs. upstream Logseq (`logseq/og`)

Kip is a fork of the open-source Logseq desktop app. This is the complete
list of deliberate differences. Everything not listed here is upstream Logseq
behaviour, unchanged.

## 1. The whole retrieval layer is new

`scripts/` (the Node retrieval layer — including `scripts/lib/skills.js` and
the built-in Peck skills in `scripts/skills/`), `coop/schema.md`, and the
workflows (Hatch / Peck / Groom, plus Peck's skills tool loop) do not exist
in upstream Logseq. They are a sibling of the `app/` repo, added on top. See
`docs/DESIGN.md`.

## 2. New app code (renderer)

| File | What it is |
|---|---|
| `frontend/components/chat.cljs` | the Peck panel (ask a question, or tell it a fact to file) |
| `frontend/components/exports.cljs` | the Exports panel — lists `<graph>/exports/`; open / reveal / save-a-copy / delete (to trash) |
| `frontend/components/ingest.cljs` | the Hatch sources modal |
| `frontend/components/telemetry.cljs` | the Hatch telemetry pane + shared render helpers |
| `frontend/components/wiki_status.cljs` | the Coop status modal (quick + deep Groom) |
| `frontend/handler/mindmap.cljs` | keyboard mindmap mode for whiteboards (Tab/Enter/arrows/F2/Mod+Shift+M over the tldraw App API) |
| `e2e-tests/mindmap.spec.ts` | Playwright coverage for the mindmap keys (self-contained Electron launch) |

`frontend/components/chat.cljs` also gained a live `⚙`-step display + a
`:wikiChatProgress` poll for Peck's skills tool loop (below).

## 3. New app code (Electron main)

| File | What it is |
|---|---|
| `electron/electron/wiki.cljs` | shells out to `scripts/*.js` via `ELECTRON_RUN_AS_NODE`; the bridge for Peck / Hatch / Groom / Coop status / telemetry; also the `<graph>/exports/` listing + open / reveal / save-a-copy / trash actions for the Exports panel |
| `electron/electron/llm.cljs` | in-process bridge for the LLM settings panel only (`llm.js` has no native deps) |

New IPC channels (all `wiki*`-prefixed): `:wikiChat`, `:wikiChatProgress`,
`:wikiSkills`, `:wikiExportsList`, `:wikiExportOpen`, `:wikiExportReveal`,
`:wikiExportSaveAs`, `:wikiExportTrash`, `:wikiIngestPreview`,
`:wikiIngestBatch`, `:wikiIngestProgress`, `:wikiIngestMetrics`, `:wikiLint`,
`:wikiGroomDeep`, `:wikiGroomProgress`, `:wikiGroomMetrics`, `:wikiRecentLog`,
plus `:testLlmConnection` / LLM-config read-write.

## 4. Modified upstream files

| File | Change |
|---|---|
| `components/container.cljs` | "Grains" collapsible nav group; graph-view relabelled "The Nest"; empty-page "New page" modal; **removed the left-sidebar footer Create button**; `kip-home-splash` (ASCII-chicken welcome card) + a collapsible "How Kip works" doc block on the home screen |
| `components/header.cljs` | "…" menu items: Coop status, Peck, Hatch sources, Hatch telemetry, Exports |
| `components/right_sidebar.cljs` | `:chat` (Peck), `:telemetry` (Hatch telemetry), and `:exports` (Exports) sidebar pane types; **right-sidebar settings bar shows Exports instead of Contents** (Electron only) |
| `handler/graph.cljs` | `build-global-graph` scoped to the `nest/` path prefix |
| `db/model.cljs` | added `get-pages-by-file-prefix` (used by the scoped graph) |
| `handler/editor.cljs` | reverted an experiment (formatting toolbar) — no net change |
| `modules/shortcut/config.cljs` | title strings "Logseq" → "Kip" |
| `handler/route.cljs` | tab-title strings "Logseq" → "Kip" |
| `electron/electron/core.cljs` | `LSP_SCHEME` `kip`; About dialog "Kip"; **auto-updater init disabled**; startup log "Kip App" |
| `electron/electron/configs.cljs` | dot-dir `.logseq-og` → `.kip` |
| `electron/electron/handler.cljs` | the new `:wiki*` IPC handlers |
| `util/url.cljs`, `electron/url.cljs`, `deps/common/.../path.cljs`, `extensions/handbooks/core.cljs` | URL scheme `logseq-og://` → `kip://` |
| `resources/dicts/en.edn` | ~40 UI strings: "Wiki graph" → "The Nest", "Go to wiki graph" → "Go to The Nest", "Logseq" → "Kip" in onboarding/help/about/etc. |
| `tldraw/apps/tldraw-logseq/src/lib/shapes/arrow/{arrowHelpers.ts,Arrow.tsx}` | mindmap S-curve connectors: `getCurveControlPoints` / `getCurvedArrowPath`, a `curved` flag, `fill="none"` on the stroke path |
| `tldraw/apps/tldraw-logseq/src/lib/shapes/LineShape.tsx` | pass `curved` (both handles bound) to `<Arrow>` and `getArrowPath` |
| `tldraw/apps/tldraw-logseq/src/lib/shapes/BoxShape.tsx` | default `borderRadius` 2 → 8 (new boxes only) |
| `extensions/tldraw.cljs` | `:on-key-down` → `frontend.handler.mindmap/handle-key-down` on the whiteboard container |

## 5. Build / packaging config

| File | Change |
|---|---|
| `src/main/frontend/version.cljs` | `1.0.0` → `0.1.0` (the packaging version source of truth) |
| `resources/package.json`, `package.json`, root `package.json` | name `kip`, productName `Kip`, version `0.1.0`; `@electron-forge/maker-wix` removed (needs an MSVC toolchain); `author`/`repository` kept as upstream attribution |
| `resources/forge.config.js` | name `Kip`; `appBundleId`/`appUserModelId` `app.kip`; protocol `kip`; `prune: false`; WiX maker block removed |
| `capacitor.config.ts` | `appId` `app.kip`, `appName` `Kip`, scheme `Kip` |
| `gulpfile.js` | new `syncScripts` (bundle `../scripts` + a pure-JS `node_modules` into `static/scripts`); `electronPackage` task |
| `package.json` scripts | added `package-electron` |
| HTML (`index.html`, `electron.html`, `marketplace.html`, …) | `<title>` and `apple-mobile-web-app-title` → Kip |
| Android `strings.xml` / `AndroidManifest.xml`, iOS `Info.plist` | display name "Kip", URL scheme `kip` (deep native identifiers — Java package, pbxproj bundle ids — **not** changed; no mobile toolchain) |

## 6. What was deliberately NOT changed

- **AGPL-3.0 license headers** — untouched, everywhere.
- **`logseq/og` attribution** — `author: "Logseq"`, `repository:
  "https://github.com/logseq/og"`, the fork links in `app/README.md` /
  `CONTRIBUTING.md`, the bug-report template URL.
- **`logseq.*` / `@logseq/*` namespaces and packages** — code identity, not
  branding. `@logseq/rsapi`, `logseq.graph-parser`, `logseq.db`, etc.
- **The per-graph `<graph>/logseq/` metadata folder** (`config.edn`,
  `custom.css`) — that's Logseq's on-disk format, not a Kip concept.
- **Upstream service URLs** — `blog.logseq.com`, `docs.logseq.com`,
  `discuss.logseq.com`, the `logseq-prod` / `logseq-test` Cognito auth
  endpoints, `asset.logseq.com` social images.
- **Internal plumbing names never shown to a user** — the `vaultRoot`
  parameter, the `electron.wiki` namespace, the `frontend.components.wiki-status`
  namespace, the `:wiki*` IPC channel keys. (Kept generic on purpose — a
  "balanced" rebrand depth.)
- **The macOS signing identity and WiX `upgradeCode`** in `forge.config.js` —
  only used by signed release builds, which Kip doesn't produce.

## 7. Runtime differences a user would notice

| | upstream Logseq | Kip |
|---|---|---|
| Config directory | `~/.logseq` | `~/.kip` |
| URL scheme | `logseq://` | `kip://` |
| Auto-update | checks GitHub releases | **off** |
| Graph view | all pages | scoped to `nest/` ("The Nest") |
| Home screen | straight to journals | an ASCII-chicken welcome card + a collapsible "How Kip works" guide, above the journals |
| Left nav | Journals / Whiteboards / Flashcards loose | grouped under "Grains" + New page |
| New page | starts with an empty bullet | starts empty; `/` for formatting |
| "…" menu | — | + Coop status, Peck, Hatch sources, Hatch telemetry, Exports |
| Settings | — | + LLM settings tab |
| Whiteboard connectors | straight lines | smooth mindmap S-curves when bound at both ends |
| Whiteboard cards | 2px corners | 8px corners on new boxes |
| Whiteboard keyboard | Enter edits the shape | mindmap keys on a selected node: Tab=child, Enter=sibling, arrows navigate, F2 edits, Mod+Shift+M arranges |
| Whiteboards & hatch | not ingested | a board becomes an outline + an LLM "Context" section under The Nest |
