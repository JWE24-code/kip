# Building & packaging Kip

## Layout

Two things live in this repo:

- `scripts/` — the Node retrieval layer (plain Node, run from the repo root
  for CLI/tests; **also bundled into the app**, see below).
- `app/` — the Logseq (`logseq/og`) fork. Its own git repo. ClojureScript →
  compiled by shadow-cljs into `app/static/`, which is what ships.
- `app/tldraw/` — a vendored tldraw v1 monorepo (the whiteboard engine). Its
  `apps/tldraw-logseq` bundle is **not** rebuilt by `yarn watch`; build it
  explicitly when you change it (see below).

## Dev

```powershell
# retrieval layer (repo root)
npm install
npm test

# the app (app/)
cd app
yarn                 # first time / after resources/package.json changes
yarn watch           # builds + watches :app (renderer) and :electron (main) into static/
#   ^ also runs gulp's syncScripts: copies ../scripts + a pure-JS node_modules
#     into static/scripts, which the app spawns at runtime
yarn dev-electron-app # launches Electron (from static/)
#   then, from the repo root, once:  npm rebuild better-sqlite3
#   (electron-forge's dev rebuild flips the repo-root better-sqlite3 to the
#    Electron ABI; the scripts/tests need the plain-node ABI. The stale
#    static/node_modules/.../.forge-meta makes the fix stick.)
```

### Changing the whiteboard engine (`app/tldraw/`)

```powershell
cd app/tldraw/apps/tldraw-logseq
npx tsup                 # or: yarn build  (tsup + writes dist/package.json + hardlinks)
#   -> app/src/main/frontend/tldraw-logseq.js  (hardlink to dist/index.js;
#      tsup's `clean` breaks the link, so `yarn build` / build.mjs re-creates it)
cd ../../..              # back to app/
clojure -M:cljs compile app     # :app recompile picks up the new JS dependency
```

tsup uses esbuild (no type-check). The tldraw monorepo's `node_modules` is
already installed; don't run `yarn` at `app/tldraw/` unless deps changed.

## Tests

- `npm test` (repo root) — the retrieval-layer suite (`node:test`, no live API).
  `skills.test.js` spawns real skill subprocesses — fixture skills plus the
  bundled `xlsx-csv` / `docx` / `pptx` / `kip-control` end to end (a few hundred
  ms each; `kip-control`'s `status` test also spawns `hatch-all.js --preview`).
- `cd app && npx playwright test <spec>` — the Electron e2e suite. Runs against
  a pre-built `static/`, so `clojure -M:cljs compile app` first. `mindmap.spec.ts`
  (keyboard mindmap mode) and `exports.spec.ts` (the Exports panel + the home
  "How Kip works" collapsible) each launch their own Electron with a throwaway
  `--user-data-dir` and graph, so they run in isolation.

## Skills (Peck's tool loop)

Built-in skills live in `scripts/skills/<name>/` (`SKILL.md` + a Node entry).
gulp's `scriptsGlob` includes `skills/**`, so they sync to
`static/scripts/skills/`. Their runtime deps go in `scripts/package.json`
alongside the others (all pure-JS — no native ABI like `better-sqlite3`):
`xlsx` is pinned to the SheetJS CDN tarball (`xlsx-0.20.3`, the maintained
line; npm's `0.18.5` is the offline fallback). `docx`, `docxtemplater` +
`pizzip`, `pptxgenjs`, and `pptx-automizer` back the `docx` / `pptx` skills.
`kip-control` adds no deps — it uses `node:child_process` plus the retrieval
layer's own `lib/` (llm, skills, db, roost, paths). The **reminders** feature
(`scripts/lib/reminders.js` + the `reminders` skill + `scripts/reminders.js`)
adds `chrono-node` (pure JS, in both package.jsons) for natural-language date
parsing.
They live in **both** `scripts/package.json` (bundled app) and the root
`package.json` (tests spawn the real skill subprocesses, which resolve deps
from the repo-root `node_modules`).

No binary assets ship in `scripts/skills/` — docx/pptx templates are
user-supplied in the coop. If one is ever vendored, it needs `{ encoding:
false }` on the gulp `syncScripts` `gulp.src` (which currently streams text
only).

## How the bundled scripts work

`electron.wiki` spawns the coop scripts as **`process.execPath` +
`ELECTRON_RUN_AS_NODE=1`** — the app's own Electron binary run as a plain
Node interpreter. So a packaged Kip needs no system `node`.

- Script source + a **pure-JS** `node_modules` (`gray-matter`, `dotenv`,
  `@anthropic-ai/sdk`) are synced to `static/scripts/` by gulp
  (`syncScripts`, driven by `scripts/package.json`).
- `better-sqlite3` is **not** in `scripts/node_modules` — the scripts resolve
  it from the app's own `node_modules`, which is built for the Electron ABI
  (145). The repo-root `node_modules/better-sqlite3` stays plain-node (147)
  for tests/CLI. Two copies, two ABIs, on purpose.
- `app.getAppPath()/scripts` resolves to `static/scripts` in dev and
  `resources/app/scripts` when packaged — same code path.

## Packaging a release (the intended path)

```powershell
cd app
yarn release-electron     # gulp:build + gulp electronMaker  -> installers in static/out
# or, for a runnable folder instead of an installer:
yarn package-electron     # gulp:build + gulp electronPackage
```

Version comes from `app/src/main/frontend/version.cljs` (regex-read by
`electronMaker`/`electronPackage` and stamped into `static/package.json`).

`forge.config.js`: `prune: false` (keeps `static/scripts/node_modules`, which
the dependency-graph pruner would otherwise strip). The **WiX/MSI maker was
removed** — its native transitive dep needs an MSVC toolchain. To make an
MSI later: `yarn add -D @electron-forge/maker-wix` on a machine with MSVC +
the WiX Toolset and restore the maker block in `forge.config.js` from git.

## 0.1 was assembled by hand

`electron-forge package` / `@electron/packager` **abort silently** on this
machine (Node v26 — packager's zip-extraction step ends the event loop with
no error, no result). Until that's resolved (older Node, or a packager
bump), the 0.1 build was assembled manually:

```
out/Kip-0.1-win32-x64/
  Kip.exe                         # = static/node_modules/electron/dist/electron.exe, renamed
  *.dll *.pak locales/ ...        # rest of the Electron 41 runtime
  resources/
    app/                          # = static/, minus build tooling and *.map
      electron.js  js/ css/ *.html  package.json
      node_modules/               # runtime deps only (electron, electron-builder,
      scripts/                    #   forge, makers, typescript, webpack pruned out)
        node_modules/             # gray-matter/dotenv/@anthropic-ai (pure JS)
    (default_app.asar deleted so Electron loads resources/app)
```

Steps: `robocopy static\node_modules\electron\dist  out\Kip-...` → rename
`electron.exe`→`Kip.exe`, delete `resources\default_app.asar` → `robocopy
static  out\Kip-...\resources\app  /XF *.map /XD <tooling dirs>`.

Rebuilding `static/node_modules/better-sqlite3` for the Electron ABI (needed
after a stray plain-node `yarn` in `static/`):

```powershell
cd app/static
npx @electron/rebuild@4.0.1 -v 41.7.1 -f --only better-sqlite3
```

Restoring `static/node_modules/electron/dist` if a `yarn` wiped it: extract
`%LOCALAPPDATA%\electron\Cache\<hash>\electron-v41.7.1-win32-x64.zip` into it
(`Expand-Archive` works; packager's extractor does not).

## Linux (Omarchy / Arch + Hyprland)

Kip is developed and packaged on Windows; a Linux build must be produced **on
Linux** (`better-sqlite3` is a native addon — no cross-compile). Everything for
it lives in `app/packaging/linux/`:

| file | what |
|---|---|
| `build.sh` | `gulp build` → `clojure -M:cljs compile app electron` → rebuild `better-sqlite3` for the Electron ABI → assemble `app/out/Kip-linux-x64/` (same hand-assembly as the Windows 0.1, since forge's packager is flaky). |
| `install.sh` | no-root install into `~/.local` (`opt/kip`, `bin/kip`, `.desktop`, icon). `--uninstall` reverses it. |
| `kip.sh` | the `kip` PATH launcher — adds `--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations` for Hyprland; override with `KIP_FLAGS=`. |
| `kip.desktop` | XDG entry + `x-scheme-handler/kip` registration. |
| `PKGBUILD` | system package (`makepkg -si` → `/opt/kip` + `/usr/bin/kip`). |

```bash
cd app
chmod +x packaging/linux/*.sh
packaging/linux/build.sh
packaging/linux/install.sh          # or: cd packaging/linux && makepkg -si
```

The Kip layer (`electron.wiki` / `electron.llm` / `electron.skills`) uses
`path.join` throughout — it previously hardcoded `\\`, which broke Peck / Hatch
/ Groom / LLM-settings on Linux. See `app/packaging/linux/README.md`.

## Verifying a package

```powershell
# scripts path — the exact thing electron.wiki does:
$env:ELECTRON_RUN_AS_NODE = "1"; $env:KIP_COOP_ROOT = "<a throwaway coop with .henhouse/llm.json>"
& "out\Kip-0.1-win32-x64\Kip.exe" "out\Kip-0.1-win32-x64\resources\app\scripts\hatch-all.js" --preview
# then launch the GUI and exercise Peck / Hatch sources / Deep groom / LLM settings
& "out\Kip-0.1-win32-x64\Kip.exe"
```
