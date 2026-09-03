// Per-session short-TTL cache for skill results (epic #32). A skill run that
// produces the same output for the same input (a read-only search, a lookup)
// gets re-run on every turn that re-asks the same question — the model asks for
// the skill again and we spawn the child again. When a skill's SKILL.md declares
// `cache_ttl`, remember its output keyed on (skill, input) so a fresh hit
// short-circuits the re-spawn and returns the cached result.
//
// Disk-backed, not in-memory: peck runs as a fresh spawned process per turn
// (scripts/peck.js), so a Map would never survive to the next turn. The cache
// lives beside the other per-coop run artifacts under <coop>/.roost/. The TTL
// is what keeps it "per-session" — it self-expires between sessions.
//
// Only the OUTPUT is stored; the input is never persisted, only hashed into the
// key (and inputs with secret-ish values are refused by the caller anyway).
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const { DEFAULT_VAULT_ROOT } = require('./paths')

const DEFAULT_TTL_MS = 60_000
const MAX_ENTRIES = 256
const SECRETISH = /(key|token|secret|password|passwd|auth|credential)/i

function cachePath (vaultRoot = DEFAULT_VAULT_ROOT) {
  return path.join(vaultRoot, '.roost', 'peck-skill-cache.json')
}

/** Stable stringification: sort object keys, drop undefined/function values. */
function canonical (value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const out = {}
  for (const k of Object.keys(value).sort()) {
    const v = value[k]
    if (v === undefined || typeof v === 'function') continue
    out[k] = v
  }
  return JSON.stringify(out)
}

/** True when `input` (or anything nested) has a secret-ish key with a value. */
function hasSecretish (input) {
  if (!input || typeof input !== 'object') return false
  if (Array.isArray(input)) return input.some(hasSecretish)
  for (const k of Object.keys(input)) {
    const v = input[k]
    if (v === null || v === undefined) continue
    if (SECRETISH.test(k)) return true
    if (typeof v === 'object' && hasSecretish(v)) return true
  }
  return false
}

function keyFor (skillName, input) {
  const hash = crypto.createHash('sha256').update(canonical(input == null ? {} : input)).digest('hex').slice(0, 24)
  return `${skillName}::${hash}`
}

function read (vaultRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(vaultRoot), 'utf8'))
    if (parsed && typeof parsed.entries === 'object' && parsed.entries !== null) return parsed
  } catch { /* absent or unparseable — start empty */ }
  return { entries: {} }
}

function write (vaultRoot, data) {
  const file = cachePath(vaultRoot)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data) + '\n')
  } catch (err) {
    console.error(`Warning: skill cache write failed (${err.message}).`)
  }
}

function prune (data, now) {
  for (const [key, e] of Object.entries(data.entries)) {
    const ttl = (e && Number(e.ttl)) || DEFAULT_TTL_MS
    if (!e || !Number.isFinite(e.at) || now - e.at >= ttl) delete data.entries[key]
  }
}

/**
 * Looks up a cached result for (skill.name, input). Returns null on a miss or
 * an expired entry; otherwise { ok, output, error, ms } (the run it captured).
 */
function get (skill, input, { ttl, vaultRoot = DEFAULT_VAULT_ROOT, now = Date.now() } = {}) {
  const data = read(vaultRoot)
  prune(data, now)
  const entry = data.entries[keyFor(skill.name, input)]
  if (!entry) return null
  const effectiveTtl = ttl || Number(entry.ttl) || DEFAULT_TTL_MS
  if (now - entry.at >= effectiveTtl) return null
  return { ok: !!entry.ok, output: entry.output || '', error: entry.error || null, ms: 0 }
}

/**
 * Stores a successful run's output under (skill.name, input). Prunes expired
 * entries and caps the file at MAX_ENTRIES (oldest first) on every write.
 */
function put (skill, input, result, { ttl, vaultRoot = DEFAULT_VAULT_ROOT, now = Date.now() } = {}) {
  const data = read(vaultRoot)
  prune(data, now)
  data.entries[keyFor(skill.name, input)] = {
    skill: skill.name,
    at: now,
    ttl: ttl || DEFAULT_TTL_MS,
    ok: !!result.ok,
    output: result.output || '',
    error: result.error || null
  }
  const keys = Object.keys(data.entries)
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => (data.entries[a].at || 0) - (data.entries[b].at || 0))
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete data.entries[k]
  }
  write(vaultRoot, data)
}

module.exports = { get, put, keyFor, hasSecretish, cachePath, DEFAULT_TTL_MS, MAX_ENTRIES }
