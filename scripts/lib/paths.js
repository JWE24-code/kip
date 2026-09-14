const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

// The coop root — pages/, nest/, clucks/, .roost/, .henhouse/ all live
// directly inside it. When the Kip app shells out to these scripts it sets
// KIP_COOP_ROOT to the currently-open graph's own directory (see
// electron.wiki); the CLI, with no such env var, defaults to this repo's
// bundled ./coop.
const DEFAULT_VAULT_ROOT = process.env.KIP_COOP_ROOT
  ? path.resolve(process.env.KIP_COOP_ROOT)
  : path.join(PROJECT_ROOT, 'coop')

// Where machine-local, non-synced state lives. The coop root is frequently
// inside Dropbox/OneDrive/iCloud Drive (kip#67), and a sync engine writing
// mid-transaction to a SQLite WAL corrupts the index. So the index (and, from
// P4 on, the nest/ git repo) lives *outside* the coop, under a workspace root
// the sync engine never touches.
//
// KIP_WORKSPACE_ROOT overrides the base — the app sets it to its own app-data
// dir. The CLI, with it unset, uses the OS state dir. Either way each coop
// gets its own workspace directory under the base, keyed by the coop's
// absolute path, so two coops can never share, clobber, or cross-contaminate
// an index.
function stateDir () {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'kip')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'kip')
  }
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state')
  return path.join(base, 'kip')
}

// A stable, filesystem-safe directory name for one coop: its basename (for a
// human reading `ls`) plus a short sha1 of the absolute path (so two coops
// both named "coop" don't collide).
function coopKey (vaultRoot) {
  const resolved = path.resolve(vaultRoot)
  const name = (path.basename(resolved) || 'coop')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 8)
  return `${name || 'coop'}-${hash}`
}

// KIP_WORKSPACE_ROOT is the *base* app-data dir; each coop gets its own
// stable subdirectory under it, because Kip can have more than one graph open
// over its lifetime and they must never share an index.
function workspaceRoot (vaultRoot = DEFAULT_VAULT_ROOT) {
  const base = process.env.KIP_WORKSPACE_ROOT
    ? path.resolve(process.env.KIP_WORKSPACE_ROOT)
    : stateDir()
  return path.join(base, 'coops', coopKey(vaultRoot))
}

// The roost dir under the workspace root: holds meta.db (+ -wal/-shm) today,
// and the rest of the machine-local run artifacts as they migrate over.
function roostPath (vaultRoot = DEFAULT_VAULT_ROOT) {
  return path.join(workspaceRoot(vaultRoot), 'roost')
}

function dbPath (vaultRoot = DEFAULT_VAULT_ROOT) {
  return path.join(roostPath(vaultRoot), 'meta.db')
}

// Known sync-engine folder names, matched on a whole path segment (so a
// directory literally named "Dropbox" or "iCloud Drive" trips it, but an
// unrelated "dropbox-notes-export" does not). `iCloud~` covers macOS's
// `~/Library/Mobile Documents/iCloud~com~…` containers.
const SYNC_DIR_PATTERNS = [
  [/^Dropbox( \([^)]+\))?$/, 'Dropbox'],
  [/^OneDrive( - .+)?$/, 'OneDrive'],
  [/^iCloud Drive$/, 'iCloud Drive'],
  [/^iCloud~/, 'iCloud Drive'],
  [/^com~apple~CloudDocs$/, 'iCloud Drive'],
  [/^Google Drive$/, 'Google Drive'],
  [/^GoogleDrive$/, 'Google Drive'],
  [/^pCloud( Drive)?$/, 'pCloud'],
  [/^MEGA$/, 'MEGA'],
  [/^Syncthing$/, 'Syncthing']
]

/** Returns the sync-engine name when `dir` sits inside a known synced folder,
 *  else null. Purely a path-shape check — no network, no filesystem probe. */
function detectSyncFolder (dir) {
  for (const part of path.resolve(dir).split(path.sep)) {
    if (!part) continue
    for (const [re, label] of SYNC_DIR_PATTERNS) {
      if (re.test(part)) return label
    }
  }
  return null
}

const warnedRoots = new Set()

/** Logs once per coop root (to stderr, never stdout — the app parses stdout as
 *  JSON) when the coop sits inside a sync engine's folder. Deliberately
 *  non-fatal: the index is already safe outside the coop; nest/ and pages/
 *  still sync, and that's the user's call. */
function warnIfSynced (vaultRoot = DEFAULT_VAULT_ROOT) {
  const resolved = path.resolve(vaultRoot)
  const engine = detectSyncFolder(resolved)
  if (engine && !warnedRoots.has(resolved)) {
    warnedRoots.add(resolved)
    console.error(`Warning: coop root ${resolved} is inside a ${engine}-synced folder. ` +
      `Kip keeps its index in ${roostPath(resolved)} (outside the sync), but nest/ and pages/ still sync.`)
  }
  return engine
}

function nestPath (vaultRoot = DEFAULT_VAULT_ROOT) {
  return path.join(vaultRoot, 'nest')
}

// The nest's git metadata dir (P4, kip#73). The nest working tree stays at
// <coop>/nest (it syncs with the user's graph like any markdown), but the
// .git directory must never sit inside the coop: a sync engine writing to git
// objects mid-commit corrupts the repo, exactly as it tears the SQLite WAL
// (kip#67). So the repo is init'd with this separate gitdir under the same
// per-coop workspace the index lives in, with <coop>/nest as its worktree.
function nestGitPath (vaultRoot = DEFAULT_VAULT_ROOT) {
  return path.join(workspaceRoot(vaultRoot), 'nest.git')
}

function clucksPath (vaultRoot = DEFAULT_VAULT_ROOT) {
  return path.join(vaultRoot, 'clucks')
}

// The unified source folder (formerly "eggs/"): pages/ is Logseq's native
// notes dir and the single drop-box for source material. Markdown notes live
// here already; Office/PDF dropped here are converted to Markdown siblings at
// hatch time. See docs/DESIGN.md "The nest — page types".
function pagesPath (vaultRoot = DEFAULT_VAULT_ROOT) {
  return path.join(vaultRoot, 'pages')
}

// Everything the LLM layer is configured through lives under .henhouse/ —
// gitignored, plaintext secrets. llm.json (provider/model/keys), skills/
// (user-added Peck skills), skills.json (which skills are on + their keys).
function henhousePath (vaultRoot = DEFAULT_VAULT_ROOT) {
  return path.join(vaultRoot, '.henhouse')
}

function configPath (vaultRoot = DEFAULT_VAULT_ROOT) {
  return path.join(henhousePath(vaultRoot), 'llm.json')
}

function skillsPath (vaultRoot = DEFAULT_VAULT_ROOT) {
  return path.join(henhousePath(vaultRoot), 'skills')
}

function skillsConfigPath (vaultRoot = DEFAULT_VAULT_ROOT) {
  return path.join(henhousePath(vaultRoot), 'skills.json')
}

// Graph-local LLM connectors: an installed connector package lives in its
// own dir under connectors/, and connectors.json lists which ones are
// active ([{ id, name, version, dir }]). Mirrors skills/ + skills.json.
function connectorsPath (vaultRoot = DEFAULT_VAULT_ROOT) {
  return path.join(henhousePath(vaultRoot), 'connectors')
}

function connectorsConfigPath (vaultRoot = DEFAULT_VAULT_ROOT) {
  return path.join(henhousePath(vaultRoot), 'connectors.json')
}

// Where skills drop generated files (a deck, a doc, a chart). Visible, not
// hidden — "where did my export go" should be answerable by looking.
function exportsPath (vaultRoot = DEFAULT_VAULT_ROOT) {
  return path.join(vaultRoot, 'exports')
}

// The reminders store — a single visible JSON file at the coop root. User data
// Kip owns (created/edited through Peck + the Reminders panel), deliberately
// NOT under .roost/ (which is "derived, safe to delete") — a rebuild-roost
// must never touch it.
function remindersPath (vaultRoot = DEFAULT_VAULT_ROOT) {
  return path.join(vaultRoot, 'reminders.json')
}

// Calendar subscriptions (kip-app#70) — ICS URLs are bearer secrets, so the
// subscription list lives under .henhouse/ alongside llm.json, never in the
// graph's Markdown. The expanded event cache is derived state and goes under
// .roost/ (safe to delete; a refresh rebuilds it).
function calendarsConfigPath (vaultRoot = DEFAULT_VAULT_ROOT) {
  return path.join(henhousePath(vaultRoot), 'calendars.json')
}

function calendarCachePath (vaultRoot = DEFAULT_VAULT_ROOT) {
  return path.join(vaultRoot, '.roost', 'calendar-events.json')
}

// Single source of truth for the page-type <-> nest subfolder mapping.
// type -> dir (used when writing a page for a known type)
const TYPE_DIRS = { entity: 'entities', concept: 'concepts', source: 'sources', person: 'people' }
// dir -> type (used when walking nest/ without already knowing the type)
const DIR_TYPES = Object.fromEntries(Object.entries(TYPE_DIRS).map(([type, dir]) => [dir, type]))

module.exports = {
  DEFAULT_VAULT_ROOT,
  workspaceRoot,
  roostPath,
  coopKey,
  detectSyncFolder,
  warnIfSynced,
  dbPath,
  nestPath,
  nestGitPath,
  clucksPath,
  pagesPath,
  henhousePath,
  configPath,
  skillsPath,
  skillsConfigPath,
  connectorsPath,
  connectorsConfigPath,
  exportsPath,
  remindersPath,
  calendarsConfigPath,
  calendarCachePath,
  TYPE_DIRS,
  DIR_TYPES
}
