const path = require('node:path')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

// The coop root — eggs/, nest/, clucks/, .roost/, .henhouse/ all live
// directly inside it. When the Kip app shells out to these scripts it sets
// KIP_COOP_ROOT to the currently-open graph's own directory (see
// electron.wiki); the CLI, with no such env var, defaults to this repo's
// bundled ./coop.
const DEFAULT_VAULT_ROOT = process.env.KIP_COOP_ROOT
  ? path.resolve(process.env.KIP_COOP_ROOT)
  : path.join(PROJECT_ROOT, 'coop')

function dbPath (vaultRoot = DEFAULT_VAULT_ROOT) {
  return path.join(vaultRoot, '.roost', 'meta.db')
}

function nestPath (vaultRoot = DEFAULT_VAULT_ROOT) {
  return path.join(vaultRoot, 'nest')
}

function clucksPath (vaultRoot = DEFAULT_VAULT_ROOT) {
  return path.join(vaultRoot, 'clucks')
}

function eggsPath (vaultRoot = DEFAULT_VAULT_ROOT) {
  return path.join(vaultRoot, 'eggs')
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
const TYPE_DIRS = { entity: 'entities', concept: 'concepts', source: 'sources' }
// dir -> type (used when walking nest/ without already knowing the type)
const DIR_TYPES = Object.fromEntries(Object.entries(TYPE_DIRS).map(([type, dir]) => [dir, type]))

module.exports = {
  DEFAULT_VAULT_ROOT,
  dbPath,
  nestPath,
  clucksPath,
  eggsPath,
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
