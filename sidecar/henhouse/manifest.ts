// Skill manifests (P6, kip#77). A skill is still a `SKILL.md` folder — the
// name/description/when_to_use/parameters/entry shape is unchanged so the
// existing built-ins keep working — but the frontmatter now carries *real*
// capabilities the executor enforces instead of documents:
//
//   network: none | all | [host...]        what a hostcall may reach
//   mounts:  [input, exports]              which sandbox mounts exist (ro/rw)
//   hostcalls: [llm.complete, fetch_url]   which parent-side calls are exposed
//   limits:  { wall, mem, output }         wall-clock / memory / stdout caps
//
// The design rule behind all of it: a manifest can only ask for capabilities
// the executor already knows how to grant (the two fixed mounts, the registered
// hostcalls, the capped limits). A skill cannot declare a mount onto the live
// vault, because "which physical directory backs a mount" is the executor's
// decision, never the manifest's.
//
// This module is parsing + discovery only. Enforcement lives in
// mounts.ts / hostcalls.ts / executor.ts.

import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const matter = require('gray-matter') as (raw: string) => {
  data: Record<string, unknown>
  content: string
}

/** The repo's bundled skills. User skills live under `<coop>/.henhouse/skills`. */
export const BUILTIN_SKILLS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'skills'
)

export const NAME_RE = /^[a-z0-9][a-z0-9-]*$/
const INSTRUCTIONS_CAP = 1200

// ---- capability types ------------------------------------------------------

export type NetworkMode = 'none' | 'hosts' | 'all'

export interface NetworkPolicy {
  mode: NetworkMode
  /** Hostnames `fetch_url` may reach when `mode === 'hosts'`. */
  hosts: string[]
}

export const MOUNT_NAMES = ['input', 'exports'] as const
export type MountName = (typeof MOUNT_NAMES)[number]
export type MountMode = 'ro' | 'rw'

export interface MountSpec {
  name: MountName
  mode: MountMode
}

export interface SkillLimits {
  /** Wall-clock ceiling in milliseconds. */
  wallMs: number
  /** V8 old-generation heap ceiling in megabytes. */
  memMb: number
  /** Bytes of stdout captured; further output is dropped. */
  outputBytes: number
}

export const DEFAULT_LIMITS: SkillLimits = { wallMs: 60_000, memMb: 128, outputBytes: 64 * 1024 }
export const LIMIT_CAPS: SkillLimits = { wallMs: 120_000, memMb: 512, outputBytes: 1024 * 1024 }

/** The parent-side capabilities the executor knows how to expose. A manifest
 *  may declare a subset; anything else is refused (`kip#78` added
 *  `web_search` + `internal_action`; `kip#105` added `read_vault_file`). */
export const KNOWN_HOSTCALLS = ['fetch_url', 'llm.complete', 'web_search', 'internal_action', 'read_vault_file'] as const
export type KnownHostcall = (typeof KNOWN_HOSTCALLS)[number]

export type SkillSource = 'builtin' | 'user'
export type ApprovalState = '' | 'pending' | 'always' | 'never'

export interface SkillParameter {
  name: string
  type: string
  required: boolean
  description: string
  enum?: unknown[]
  default?: unknown
}

export interface SkillManifest {
  name: string
  description: string
  whenToUse: string
  parameters: SkillParameter[]
  instructions: string
  entry: string
  entryPath: string
  dir: string
  source: SkillSource
  network: NetworkPolicy
  mounts: MountSpec[]
  limits: SkillLimits
  hostcalls: string[]
  cacheTtlMs: number
}

export interface DiscoveredSkill extends SkillManifest {
  enabled: boolean
  approval: ApprovalState
}

// ---- normalizers -----------------------------------------------------------

const WALL_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/i
const SIZE_RE = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i

function clamp (value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** `60` -> 60000ms (a bare number is seconds, matching the old `timeout` field);
 *  `"500ms"` / `"2m"` / `"90s"` parse explicitly. Null when unusable. */
export function parseWallMs (value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return clamp(value * 1000, 1, LIMIT_CAPS.wallMs)
  }
  if (typeof value !== 'string') return null
  const match = value.trim().match(WALL_RE)
  if (!match) return null
  const n = Number(match[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = (match[2] || 's').toLowerCase()
  const ms = unit === 'ms' ? n : unit === 'm' ? n * 60_000 : n * 1000
  return clamp(ms, 1, LIMIT_CAPS.wallMs)
}

/** `128` -> 128MB (`"512mb"` / `"1gb"` too). Null when unusable. */
export function parseMemMb (value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return clamp(value, 8, LIMIT_CAPS.memMb)
  }
  if (typeof value !== 'string') return null
  const match = value.trim().match(SIZE_RE)
  if (!match) return null
  const n = Number(match[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = (match[2] || 'mb').toLowerCase()
  const mb = unit === 'b' ? n / (1024 * 1024)
    : unit === 'kb' ? n / 1024
      : unit === 'gb' ? n * 1024
        : n
  return clamp(mb, 8, LIMIT_CAPS.memMb)
}

/** `65536` -> 65536 bytes; `"64kb"` / `"1mb"` parse explicitly. Null when unusable. */
export function parseOutputBytes (value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return clamp(value, 256, LIMIT_CAPS.outputBytes)
  }
  if (typeof value !== 'string') return null
  const match = value.trim().match(SIZE_RE)
  if (!match) return null
  const n = Number(match[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = (match[2] || 'b').toLowerCase()
  const bytes = unit === 'kb' ? n * 1024
    : unit === 'mb' ? n * 1024 * 1024
      : unit === 'gb' ? n * 1024 * 1024 * 1024
        : n
  return clamp(bytes, 256, LIMIT_CAPS.outputBytes)
}

/** Normalizes `limits`, falling back to top-level `timeout` for the wall clock. */
export function parseLimits (data: Record<string, unknown>): SkillLimits {
  const raw = (data.limits && typeof data.limits === 'object' && !Array.isArray(data.limits))
    ? data.limits as Record<string, unknown>
    : {}
  const wall = parseWallMs(raw.wall) ?? parseWallMs(data.timeout) ?? DEFAULT_LIMITS.wallMs
  const mem = parseMemMb(raw.mem) ?? DEFAULT_LIMITS.memMb
  const output = parseOutputBytes(raw.output) ?? DEFAULT_LIMITS.outputBytes
  return { wallMs: wall, memMb: mem, outputBytes: output }
}

/** Absent -> none. `true`/'all' -> all; `false`/'none' -> none; a string array
 *  or `{ hosts }` -> hosts. Anything else is treated as none (fail closed). */
export function parseNetwork (value: unknown): NetworkPolicy {
  if (value === undefined || value === null || value === false) return { mode: 'none', hosts: [] }
  if (value === true) return { mode: 'all', hosts: [] }
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'all' || v === 'any' || v === 'true') return { mode: 'all', hosts: [] }
    if (v === 'none' || v === 'false') return { mode: 'none', hosts: [] }
    return { mode: 'hosts', hosts: [value.trim()] }
  }
  if (Array.isArray(value)) {
    const hosts = value.filter((h): h is string => typeof h === 'string' && h.trim().length > 0).map((h) => h.trim())
    return hosts.length ? { mode: 'hosts', hosts } : { mode: 'none', hosts: [] }
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (obj.allow === true) return { mode: 'all', hosts: [] }
    if (obj.mode === 'all') return { mode: 'all', hosts: [] }
    if (obj.mode === 'none') return { mode: 'none', hosts: [] }
    if (Array.isArray(obj.hosts)) {
      const hosts = obj.hosts.filter((h): h is string => typeof h === 'string' && h.trim().length > 0).map((h) => h.trim())
      return hosts.length ? { mode: 'hosts', hosts } : { mode: 'none', hosts: [] }
    }
  }
  return { mode: 'none', hosts: [] }
}

/**
 * Parses `mounts` into the executor's fixed vocabulary. A bare `['input',
 * 'exports']`, a `[{name, mode}]` list, or absent all normalize to the two
 * known mounts; an unknown name is dropped, so a manifest can never smuggle in
 * a mount the executor would have to invent a physical path for.
 */
export function parseMounts (value: unknown): MountSpec[] {
  const defaults: MountSpec[] = [{ name: 'input', mode: 'ro' }, { name: 'exports', mode: 'rw' }]
  if (value === undefined || value === null) return defaults
  const list = Array.isArray(value) ? value : [value]
  const byName = new Map<MountName, MountSpec>()
  for (const item of list) {
    let name: unknown
    let mode: unknown
    if (typeof item === 'string') name = item
    else if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>
      name = obj.name ?? obj.source ?? obj.mount
      mode = obj.mode
    } else continue
    if (typeof name !== 'string' || !(MOUNT_NAMES as readonly string[]).includes(name)) continue
    const mountName = name as MountName
    const mountMode: MountMode = mode === 'rw' ? 'rw' : mountName === 'exports' ? 'rw' : 'ro'
    // The input snapshot is read-only by construction: a skill may not write
    // back into the notes it was handed.
    byName.set(mountName, { name: mountName, mode: mountName === 'input' ? 'ro' : mountMode })
  }
  return byName.size ? [...byName.values()] : defaults
}

function normalizeParameters (params: unknown): SkillParameter[] {
  if (!Array.isArray(params)) return []
  return params
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && typeof (p as Record<string, unknown>).name === 'string')
    .map((p) => ({
      name: p.name as string,
      type: typeof p.type === 'string' ? p.type : 'string',
      required: !!p.required,
      description: typeof p.description === 'string' ? p.description : '',
      ...(Array.isArray(p.enum) ? { enum: p.enum } : {}),
      ...(p.default !== undefined ? { default: p.default } : {})
    }))
}

function parseHostcalls (value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out = new Set<string>()
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) out.add(item.trim())
  }
  return [...out]
}

// ---- the manifest reader ---------------------------------------------------

export interface ParsedManifest {
  manifest: SkillManifest | null
  warnings: string[]
}

/**
 * Pure parser over already-read frontmatter + body. Returns a manifest, or null
 * (with warnings) when the required fields are missing. Exposed separately from
 * the filesystem read so tests can exercise the capability normalization.
 */
export function parseManifestData (
  data: Record<string, unknown>,
  content: string,
  dir: string,
  source: SkillSource
): ParsedManifest {
  const warnings: string[] = []
  const name = data.name
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return { manifest: null, warnings: [`skill at ${dir} — missing or invalid "name" (must match ${NAME_RE})`] }
  }
  if (typeof data.description !== 'string' || !data.description.trim()) {
    return { manifest: null, warnings: [`skill "${name}" — missing "description"`] }
  }
  const entry = typeof data.entry === 'string' && data.entry.trim() ? data.entry.trim() : 'run.js'
  const entryPath = join(dir, entry)
  if (!existsSync(entryPath)) {
    return { manifest: null, warnings: [`skill "${name}" — entry "${entry}" not found`] }
  }
  const declaredHostcalls = parseHostcalls(data.hostcalls)
  for (const hostcall of declaredHostcalls) {
    if (!(KNOWN_HOSTCALLS as readonly string[]).includes(hostcall)) {
      warnings.push(`skill "${name}" — unknown hostcall "${hostcall}" is not exposed`)
    }
  }
  const cacheTtlSec = Number(data.cache_ttl)
  const manifest: SkillManifest = {
    name,
    description: data.description.trim(),
    whenToUse: typeof data.when_to_use === 'string' ? data.when_to_use.trim() : '',
    parameters: normalizeParameters(data.parameters),
    instructions: String(content || '').trim().slice(0, INSTRUCTIONS_CAP),
    entry,
    entryPath,
    dir,
    source,
    network: parseNetwork(data.network),
    mounts: parseMounts(data.mounts),
    limits: parseLimits(data),
    hostcalls: declaredHostcalls,
    cacheTtlMs: Number.isFinite(cacheTtlSec) && cacheTtlSec > 0 ? cacheTtlSec * 1000 : 0
  }
  return { manifest, warnings }
}

/** Reads `<dir>/SKILL.md`; logs (never throws) and returns null when unusable. */
export function readSkillManifest (dir: string, source: SkillSource): SkillManifest | null {
  const mdPath = join(dir, 'SKILL.md')
  let data: Record<string, unknown>
  let content: string
  try {
    ;({ data, content } = matter(readFileSync(mdPath, 'utf8')))
  } catch (err) {
    console.error(`Warning: skill at ${dir} — could not read SKILL.md (${(err as Error).message}); skipping.`)
    return null
  }
  const parsed = parseManifestData(data, content, dir, source)
  if (!parsed.manifest) {
    for (const warning of parsed.warnings) console.error(`Warning: ${warning}; skipping.`)
    return null
  }
  return parsed.manifest
}

// ---- policy + discovery ----------------------------------------------------

export interface SkillPolicy {
  disabled: string[]
  approved: Record<string, string>
}

/** `<coop>/.henhouse/skills.json`'s `disabled` + `approved`, safe on any problem. */
export function loadSkillPolicy (vaultRoot: string): SkillPolicy {
  try {
    const raw = JSON.parse(readFileSync(join(vaultRoot, '.henhouse', 'skills.json'), 'utf8')) as Record<string, unknown>
    const approved = (raw.approved && typeof raw.approved === 'object' && !Array.isArray(raw.approved))
      ? raw.approved as Record<string, string>
      : {}
    return { disabled: Array.isArray(raw.disabled) ? raw.disabled.filter((d): d is string => typeof d === 'string') : [], approved }
  } catch {
    return { disabled: [], approved: {} }
  }
}

function approvalState (skill: SkillManifest, approved: Record<string, string>): ApprovalState {
  if (skill.source !== 'user') return ''
  return approved[skill.name] === 'always' ? 'always' : approved[skill.name] === 'never' ? 'never' : 'pending'
}

function isAllowed (skill: SkillManifest, approved: Record<string, string>): boolean {
  return skill.source !== 'user' || approved[skill.name] === 'always'
}

function listSkillDirs (parent: string): string[] {
  let entries
  try {
    entries = readdirSync(parent, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name))
    .filter((dir) => existsSync(join(dir, 'SKILL.md')))
}

export interface DiscoverOptions {
  vaultRoot: string
  /** Override the built-in folder (tests point this at a fixture). */
  builtinDir?: string
  /** Include disabled skills and unapproved user skills (Settings/host views). */
  includeDisabled?: boolean
}

/**
 * Every usable skill: built-ins first, then the user's (`<coop>/.henhouse/
 * skills`), user wins on name. Disabled skills are dropped unless
 * `includeDisabled`; an unapproved user skill is likewise hidden from the
 * runnable set.
 */
export function discoverSkills ({
  vaultRoot,
  builtinDir = BUILTIN_SKILLS_DIR,
  includeDisabled = false
}: DiscoverOptions): DiscoveredSkill[] {
  const byName = new Map<string, SkillManifest>()
  for (const dir of listSkillDirs(builtinDir)) {
    const skill = readSkillManifest(dir, 'builtin')
    if (skill) byName.set(skill.name, skill)
  }
  for (const dir of listSkillDirs(join(vaultRoot, '.henhouse', 'skills'))) {
    const skill = readSkillManifest(dir, 'user')
    if (skill) byName.set(skill.name, skill)
  }

  const policy = loadSkillPolicy(vaultRoot)
  const out: DiscoveredSkill[] = []
  for (const skill of byName.values()) {
    const enabled = !policy.disabled.includes(skill.name)
    if (!includeDisabled && (!enabled || !isAllowed(skill, policy.approved))) continue
    out.push({ ...skill, enabled, approval: approvalState(skill, policy.approved) })
  }
  return out
}

/** Content-free view for the settings panel (no paths, no secrets). */
export function describeSkills (vaultRoot: string): Array<Record<string, unknown>> {
  return discoverSkills({ vaultRoot, includeDisabled: true }).map((skill) => ({
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    source: skill.source,
    network: skill.network.mode === 'none' ? false : skill.network.hosts.length ? skill.network.hosts : true,
    mounts: skill.mounts,
    hostcalls: skill.hostcalls,
    limits: skill.limits,
    approval: skill.approval,
    enabled: skill.enabled,
    parameters: skill.parameters
  }))
}
