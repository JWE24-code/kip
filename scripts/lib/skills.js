// The Peck skills harness. A "skill" is a folder with a SKILL.md manifest and
// a Node entry script; Peck can call skills in a bounded tool-use loop while
// answering a question (see answerQuestionWithSkills in scripts/lib/prompts.js
// and answerFromPages in scripts/lib/peck.js).
//
//   discoverSkills(vaultRoot)  — built-in scripts/skills/* + user
//                                <coop>/.henhouse/skills/*, user wins on name.
//   runSkill(skill, input, ..) — spawns the entry with the input as an env
//                                var, captures stdout, timeout + output cap.
//   parseSkillCall(text)       — pulls a <use_skill name="X">{json}</use_skill>
//                                block out of a model response.
//
// Trust model: a skill is arbitrary Node code running with the user's
// privileges — there is no sandbox. Built-ins are reviewed in this repo; a
// user skill under .henhouse/skills/ is like adding a shell script. The
// runner limits blast radius (timeout, output cap, cwd scoped to the skill
// dir, entry is a .js file — never an arbitrary shell string) but does not
// contain it. As a first gate, a *user* skill is not offered to Peck and
// will not run until it's been approved once (skills.json `approved`) — see
// setSkillApproval / isUserSkillApproved.
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const matter = require('gray-matter')

const { DEFAULT_VAULT_ROOT, skillsPath, skillsConfigPath, exportsPath } = require('./paths')
const telemetry = require('./telemetry')

const BUILTIN_SKILLS_DIR = path.join(__dirname, '..', 'skills')
const SKILL_TIMEOUT_MS = 60_000
const SKILL_TIMEOUT_MAX_MS = 120_000
const OUTPUT_CAP_BYTES = 8 * 1024
const INPUT_CAP_BYTES = 16 * 1024
const INSTRUCTIONS_CAP = 1200
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

/** The raw parsed coop/.henhouse/skills.json object (unknown keys preserved), or {}. */
function readSkillsConfigRaw (vaultRoot = DEFAULT_VAULT_ROOT) {
  try {
    return JSON.parse(fs.readFileSync(skillsConfigPath(vaultRoot), 'utf8')) || {}
  } catch {
    return {}
  }
}

/** Writes coop/.henhouse/skills.json (creating coop/.henhouse/ if needed). */
function saveSkillsConfig (config, vaultRoot = DEFAULT_VAULT_ROOT) {
  const file = skillsConfigPath(vaultRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
}

/**
 * Reads coop/.henhouse/skills.json, normalized; safe {} on any problem.
 *   disabled — skill names Peck should not be offered
 *   secrets  — per-skill private env (API keys), never shown in listings
 *   config   — per-skill non-secret settings (also spread into the skill's env)
 */
function loadSkillsConfig (vaultRoot = DEFAULT_VAULT_ROOT) {
  const parsed = readSkillsConfigRaw(vaultRoot)
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}
  return {
    disabled: Array.isArray(parsed.disabled) ? parsed.disabled : [],
    secrets: obj(parsed.secrets),
    config: obj(parsed.config),
    // { "<skill-name>": "always" | "never" } — a user skill with no entry
    // here has never been reviewed and is treated as blocked.
    approved: obj(parsed.approved)
  }
}

/** Toggles a skill in skills.json "disabled", preserving every other field. */
function setSkillEnabled (vaultRoot, name, enabled) {
  const cfg = readSkillsConfigRaw(vaultRoot)
  const disabled = new Set(Array.isArray(cfg.disabled) ? cfg.disabled : [])
  if (enabled) disabled.delete(name)
  else disabled.add(name)
  cfg.disabled = [...disabled]
  saveSkillsConfig(cfg, vaultRoot)
  return { name, enabled: !disabled.has(name) }
}

/**
 * Records a review decision for a *user* skill. `decision` is 'always',
 * 'never', or null (forget — back to unreviewed). Built-ins are always
 * allowed and ignore this. Returns { name, approval }.
 */
function setSkillApproval (vaultRoot, name, decision) {
  const cfg = readSkillsConfigRaw(vaultRoot)
  const approved = (cfg.approved && typeof cfg.approved === 'object') ? cfg.approved : {}
  if (decision === 'always' || decision === 'never') approved[name] = decision
  else delete approved[name]
  cfg.approved = approved
  saveSkillsConfig(cfg, vaultRoot)
  return { name, approval: approved[name] || 'pending' }
}

/** '' for built-ins; 'always' | 'never' | 'pending' for a user skill. */
function approvalState (skill, approved) {
  if (skill.source !== 'user') return ''
  return approved[skill.name] === 'always' ? 'always'
    : approved[skill.name] === 'never' ? 'never'
      : 'pending'
}

/** May this skill be offered to Peck / run? Built-ins yes; user skills only when approved. */
function isSkillAllowed (skill, approved) {
  return skill.source !== 'user' || approved[skill.name] === 'always'
}

function normalizeParameters (params) {
  if (!Array.isArray(params)) return []
  return params
    .filter((p) => p && typeof p.name === 'string')
    .map((p) => ({
      name: p.name,
      type: typeof p.type === 'string' ? p.type : 'string',
      required: !!p.required,
      description: typeof p.description === 'string' ? p.description : '',
      ...(Array.isArray(p.enum) ? { enum: p.enum } : {}),
      ...(p.default !== undefined ? { default: p.default } : {})
    }))
}

/** Parses one <dir>/SKILL.md into a Skill, or null (with a warning) if unusable. */
function readManifest (dir, source) {
  const mdPath = path.join(dir, 'SKILL.md')
  let data, content
  try {
    ({ data, content } = matter(fs.readFileSync(mdPath, 'utf8')))
  } catch (err) {
    console.error(`Warning: skill at ${dir} — could not read SKILL.md (${err.message}); skipping.`)
    return null
  }

  const name = data.name
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    console.error(`Warning: skill at ${dir} — missing or invalid "name" (must match ${NAME_RE}); skipping.`)
    return null
  }
  if (typeof data.description !== 'string' || !data.description.trim()) {
    console.error(`Warning: skill "${name}" — missing "description"; skipping.`)
    return null
  }

  const entry = typeof data.entry === 'string' && data.entry.trim() ? data.entry.trim() : 'run.js'
  const entryPath = path.join(dir, entry)
  if (!fs.existsSync(entryPath)) {
    console.error(`Warning: skill "${name}" — entry "${entry}" not found; skipping.`)
    return null
  }

  const timeoutSec = Number(data.timeout)
  const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0
    ? Math.min(timeoutSec * 1000, SKILL_TIMEOUT_MAX_MS)
    : SKILL_TIMEOUT_MS

  return {
    name,
    description: data.description.trim(),
    whenToUse: typeof data.when_to_use === 'string' ? data.when_to_use.trim() : '',
    parameters: normalizeParameters(data.parameters),
    instructions: String(content || '').trim().slice(0, INSTRUCTIONS_CAP),
    network: !!data.network,
    // Free-text capability claims from the manifest, shown at approval time.
    // Advisory only — nothing enforces them yet.
    permissions: Array.isArray(data.permissions)
      ? data.permissions.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim().slice(0, 80)).slice(0, 8)
      : [],
    source,
    dir,
    entryPath,
    timeoutMs
  }
}

function listSkillDirs (parent) {
  let entries
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(parent, e.name))
    .filter((d) => fs.existsSync(path.join(d, 'SKILL.md')))
}

/**
 * Every usable skill: the built-ins bundled in scripts/skills/, then the
 * user's under <coop>/.henhouse/skills/ (which override a built-in of the
 * same name). Disabled skills (skills.json "disabled") are dropped unless
 * `includeDisabled`. Never throws — a broken manifest is warned and skipped.
 *
 * @returns {Array<{name, description, whenToUse, parameters, instructions,
 *                  network, source: 'builtin'|'user', dir, entryPath,
 *                  timeoutMs, enabled}>}
 */
function discoverSkills (vaultRoot = DEFAULT_VAULT_ROOT, { includeDisabled = false } = {}) {
  const byName = new Map()
  for (const dir of listSkillDirs(BUILTIN_SKILLS_DIR)) {
    const s = readManifest(dir, 'builtin')
    if (s) byName.set(s.name, s)
  }
  for (const dir of listSkillDirs(skillsPath(vaultRoot))) {
    const s = readManifest(dir, 'user')
    if (s) byName.set(s.name, s)
  }

  const { disabled, approved } = loadSkillsConfig(vaultRoot)
  const out = []
  for (const s of byName.values()) {
    const enabled = !disabled.includes(s.name)
    // A user skill that hasn't been approved is not runnable — keep it out of
    // the list Peck sees (Settings still shows it via describeSkills).
    if (!includeDisabled && !isSkillAllowed(s, approved)) continue
    if (enabled || includeDisabled) out.push({ ...s, enabled, approval: approvalState(s, approved) })
  }
  return out
}

/**
 * Content-free view of every skill (enabled + disabled) for the CLI
 * (scripts/skills-list.js) and the app's Skills settings panel — no secrets,
 * no filesystem paths.
 */
function describeSkills (vaultRoot = DEFAULT_VAULT_ROOT) {
  const { approved } = loadSkillsConfig(vaultRoot)
  return discoverSkills(vaultRoot, { includeDisabled: true }).map((s) => ({
    name: s.name,
    description: s.description,
    whenToUse: s.whenToUse,
    source: s.source,
    network: s.network,
    permissions: s.permissions || [],
    approval: approvalState(s, approved),   // '' for built-ins
    enabled: s.enabled,
    parameters: s.parameters
  }))
}

// ---------------------------------------------------------------------------
// web-search backend settings (Settings -> Skills)
// ---------------------------------------------------------------------------

const SEARCH_BACKENDS = ['duckduckgo', 'brave', 'tavily']

/** Current web-search backend + keys, from skills.json. Backend defaults to duckduckgo. */
function loadSearchSettings (vaultRoot = DEFAULT_VAULT_ROOT) {
  const { secrets, config } = loadSkillsConfig(vaultRoot)
  const cfg = config['web-search'] || {}
  const sec = secrets['web-search'] || {}
  return {
    backend: SEARCH_BACKENDS.includes(cfg.SEARCH_BACKEND) ? cfg.SEARCH_BACKEND : 'duckduckgo',
    braveApiKey: typeof sec.BRAVE_API_KEY === 'string' ? sec.BRAVE_API_KEY : '',
    tavilyApiKey: typeof sec.TAVILY_API_KEY === 'string' ? sec.TAVILY_API_KEY : ''
  }
}

/**
 * Writes the web-search backend into skills.json config['web-search'] and its
 * keys into secrets['web-search'] — a read-modify-write that leaves `disabled`
 * and every other skill's entries untouched. Any field left undefined is
 * unchanged; an empty-string key is removed. Returns the reloaded settings.
 */
function saveSearchSettings (vaultRoot, { backend, braveApiKey, tavilyApiKey } = {}) {
  const cfg = readSkillsConfigRaw(vaultRoot)
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}
  cfg.config = obj(cfg.config)
  cfg.secrets = obj(cfg.secrets)
  const wsCfg = { ...obj(cfg.config['web-search']) }
  const wsSec = { ...obj(cfg.secrets['web-search']) }

  if (backend !== undefined) {
    wsCfg.SEARCH_BACKEND = SEARCH_BACKENDS.includes(backend) ? backend : 'duckduckgo'
  }
  const setKey = (name, val) => {
    if (val === undefined) return
    if (val) wsSec[name] = String(val)
    else delete wsSec[name]
  }
  setKey('BRAVE_API_KEY', braveApiKey)
  setKey('TAVILY_API_KEY', tavilyApiKey)

  if (Object.keys(wsCfg).length) cfg.config['web-search'] = wsCfg
  else delete cfg.config['web-search']
  if (Object.keys(wsSec).length) cfg.secrets['web-search'] = wsSec
  else delete cfg.secrets['web-search']
  if (!Object.keys(cfg.config).length) delete cfg.config
  if (!Object.keys(cfg.secrets).length) delete cfg.secrets

  saveSkillsConfig(cfg, vaultRoot)
  return loadSearchSettings(vaultRoot)
}

// ---------------------------------------------------------------------------
// running a skill
// ---------------------------------------------------------------------------

const SECRETISH = /(key|token|secret|password|passwd|auth|credential)/i

/** A shallow copy of `input` with obviously-secret values redacted — for `steps`/telemetry. */
function scrubInput (input) {
  if (!input || typeof input !== 'object') return input
  const out = Array.isArray(input) ? [] : {}
  for (const [k, v] of Object.entries(input)) {
    out[k] = (SECRETISH.test(k) && typeof v === 'string' && v) ? '[redacted]' : v
  }
  return out
}

function cap (s, n) {
  s = String(s == null ? '' : s)
  return s.length > n ? s.slice(0, n) + '\n…[truncated]' : s
}

/**
 * Runs one skill's entry script. `input` is passed as SKILL_INPUT (JSON) in
 * the child env, alongside KIP_COOP_ROOT, KIP_EXPORTS_DIR, SKILL_DIR, and any
 * per-skill secrets from skills.json. cwd is the skill's own folder. Never
 * rejects — every failure mode is a resolved `{ ok: false, ... }`.
 *
 * @returns {Promise<{ok: boolean, output: string, error: string|null, ms: number, timedOut: boolean}>}
 */
function runSkill (skill, input, vaultRoot = DEFAULT_VAULT_ROOT, { timeoutMs, outputCapBytes, execFileFn = execFile, env: envOverride } = {}) {
  const started = Date.now()
  const { secrets, config, approved } = loadSkillsConfig(vaultRoot)

  if (!isSkillAllowed(skill, approved)) {
    const r = { ok: false, output: '', error: `skill "${skill.name}" hasn't been approved — approve it in Settings → Skills`, ms: 0, timedOut: false }
    record(skill, input, r)
    return Promise.resolve(r)
  }
  const env = {
    ...process.env,
    NODE_NO_WARNINGS: '1', // skill deps (docx, pptx-automizer) trip Node's localStorage ExperimentalWarning on v26
    KIP_COOP_ROOT: vaultRoot,
    KIP_EXPORTS_DIR: exportsPath(vaultRoot),
    SKILL_DIR: skill.dir,
    SKILL_INPUT: JSON.stringify(input == null ? {} : input).slice(0, INPUT_CAP_BYTES),
    ...(config[skill.name] || {}),   // non-secret per-skill settings (e.g. SEARCH_BACKEND)
    ...(secrets[skill.name] || {}),  // per-skill API keys — win over config on a name clash
    ...(envOverride || {})           // caller override — the settings "Test" button trying unsaved values
  }
  const maxBuffer = outputCapBytes || OUTPUT_CAP_BYTES
  const timeout = Math.min(timeoutMs || skill.timeoutMs || SKILL_TIMEOUT_MS, SKILL_TIMEOUT_MAX_MS)

  return new Promise((resolve) => {
    let done = false
    const finish = (r) => { if (!done) { done = true; record(skill, input, r); resolve(r) } }

    execFileFn(process.execPath, [skill.entryPath], { cwd: skill.dir, env, timeout, maxBuffer, windowsHide: true },
      (err, stdout, stderr) => {
        const ms = Date.now() - started
        const out = cap((stdout || '').trim(), maxBuffer)
        if (!err) return finish({ ok: true, output: out, error: null, ms, timedOut: false })
        if (err.killed) return finish({ ok: false, output: out, error: `timed out after ${timeout}ms`, ms, timedOut: true })
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return finish({ ok: true, output: out, error: 'output truncated', ms, timedOut: false })
        }
        const msg = (stderr || '').trim() ||
          (typeof err.code === 'number' ? `exited ${err.code}` : err.message)
        return finish({ ok: false, output: out, error: msg, ms, timedOut: false })
      })
  })
}

/** One content-free telemetry entry per skill run (full I/O only to the trace sink). */
function record (skill, input, r) {
  telemetry.record({
    label: `skill:${skill.name}`,
    phase: 'skill',
    ms: r.ms,
    ok: r.ok,
    skill: skill.name,
    timedOut: r.timedOut || undefined,
    outputChars: (r.output || '').length,
    error: r.error || undefined,
    system: JSON.stringify(scrubInput(input)),
    responseText: r.output
  })
}

// ---------------------------------------------------------------------------
// parsing the model's tool call
// ---------------------------------------------------------------------------

const USE_SKILL_RE = /<use_skill\s+name\s*=\s*["']([a-z0-9][a-z0-9-]*)["']\s*>([\s\S]*?)<\/use_skill>/i

/** First balanced {...} object in `s`, as text, or null. */
function firstJsonObject (s) {
  const start = s.indexOf('{')
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}' && --depth === 0) return s.slice(start, i + 1)
  }
  return null
}

/**
 * Pulls a skill call out of a model response. Tolerant of ``` fences and
 * surrounding prose. Returns null when there's no <use_skill> tag (⇒ the text
 * is the final answer), or { name, input: null } when the tag's args weren't
 * usable JSON (⇒ the caller feeds back a corrective).
 */
function parseSkillCall (text) {
  const m = String(text || '').match(USE_SKILL_RE)
  if (!m) return null
  const name = m[1]
  let body = m[2].trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  if (!body) return { name, input: {} }
  try {
    return { name, input: JSON.parse(body) }
  } catch { /* fall through to a recovery attempt */ }
  const obj = firstJsonObject(body)
  if (obj) {
    try { return { name, input: JSON.parse(obj) } } catch { /* give up */ }
  }
  return { name, input: null }
}

module.exports = {
  discoverSkills,
  describeSkills,
  runSkill,
  loadSkillsConfig,
  saveSkillsConfig,
  setSkillEnabled,
  setSkillApproval,
  loadSearchSettings,
  saveSearchSettings,
  SEARCH_BACKENDS,
  parseSkillCall,
  scrubInput,
  SKILL_TIMEOUT_MS,
  OUTPUT_CAP_BYTES
}
