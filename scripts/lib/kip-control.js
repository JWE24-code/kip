// Kip's own maintenance operations, in one trusted place (kip#78).
//
// These are the operations the `kip-control` skill exposes to the model —
// coop status, Hatch (preview / launch / progress), Groom (quick inline / deep
// in the background / progress / report), rebuild-roost, and the settings page
// (read the provider + skills, switch provider/model/key, test the connection,
// toggle a skill).
//
// They run *in the parent*: a sandboxed skill holds no vault access, so it
// asks for an operation over the `internal_action` hostcall and this module
// performs it. The same code backs the skill's legacy CLI path, so behavior is
// identical whichever runner invokes it.
//
// Long jobs (hatch, groom-deep) are spawned DETACHED — the same CLI scripts
// the app's buttons shell out to — and keep running after the caller exits;
// their progress lands in <coop>/.roost/*-progress.json, which the *-progress
// operations read. Everything else runs inline and returns markdown text.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')

const { DEFAULT_VAULT_ROOT } = require('./paths')

const SCRIPTS_DIR = path.resolve(__dirname, '..')
const lib = (name) => path.join(SCRIPTS_DIR, 'lib', name)

const OPERATIONS = [
  'status', 'hatch-preview', 'hatch', 'hatch-progress', 'groom', 'groom-deep',
  'groom-progress', 'groom-report', 'rebuild-roost', 'settings', 'set-provider',
  'test-connection', 'set-skill'
]
const PROVIDERS = ['anthropic', 'openai', 'deepseek', 'local', 'other']

class KipControlError extends Error {
  constructor (message) {
    super(`kip-control: ${message}`)
    this.name = 'KipControlError'
  }
}

function readJson (file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** First non-empty line of a message — keeps multi-line Node errors (native
 *  ABI mismatches, stack traces) from blowing past the output cap. */
function oneLine (msg) {
  return String(msg || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || String(msg || '')
}

/** Run a sibling CLI script and return its stdout. Surfaces its stderr on failure. */
function runScript (name, args = [], { vaultRoot } = {}) {
  try {
    return execFileSync(process.execPath, [path.join(SCRIPTS_DIR, name), ...args], {
      cwd: SCRIPTS_DIR,
      env: vaultRoot ? { ...process.env, KIP_COOP_ROOT: vaultRoot } : process.env,
      encoding: 'utf8', timeout: 110_000, maxBuffer: 8 * 1024 * 1024
    })
  } catch (err) {
    const detail = oneLine((err.stderr && String(err.stderr).trim()) || err.message)
    throw new KipControlError(`${name} ${args.join(' ')} failed: ${detail}`)
  }
}

/** Launch a sibling CLI script detached — it outlives this process. Returns its pid. */
function launchDetached (name, args = [], { vaultRoot } = {}) {
  const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, name), ...args], {
    cwd: SCRIPTS_DIR,
    env: vaultRoot ? { ...process.env, KIP_COOP_ROOT: vaultRoot } : process.env,
    detached: true, stdio: 'ignore', windowsHide: true
  })
  child.unref()
  return child.pid
}

function ago (ms) {
  if (!ms) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function jobLine (label, progressFile, metricsFile) {
  const p = readJson(progressFile)
  if (p && p.running) {
    return `- ${label}: **running** — ${p.done || 0}/${p.total ?? '?'}${p.current ? ` (${p.current})` : ''}`
  }
  if (p && p.error) return `- ${label}: last run failed (${p.error}), ${ago(p.at)}`
  const m = readJson(metricsFile)
  if (m && m.at) return `- ${label}: idle — last run ${ago(m.at)}`
  return `- ${label}: idle — never run in this coop`
}

function progressReport (label, progressFile) {
  const p = readJson(progressFile)
  if (!p) return `No ${label.toLowerCase()} has run in this coop yet (no ${path.basename(progressFile)}).`
  const state = p.running ? 'running' : (p.error ? 'FAILED' : 'finished')
  const lines = [
    `**${label} — ${state}** (updated ${ago(p.at)})`,
    `Progress: ${p.done || 0}/${p.total ?? '?'}${p.current ? ` — ${p.current}` : ''}`
  ]
  if (p.error) lines.push(`Error: ${p.error}`)
  const act = Array.isArray(p.activity) ? p.activity.slice(-8) : []
  if (act.length) {
    lines.push('', 'Recent LLM calls:')
    for (const r of act) {
      lines.push(`- ${r.phase || r.label || '?'} ${r.ok === false ? '✗' : '✓'} ${r.ms || 0}ms` +
        (r.error ? ` — ${r.error}` : ''))
    }
  }
  const s = p.metrics
  if (s && s.totalCalls) {
    lines.push('', `Totals so far: ${s.totalCalls} LLM calls, ${Math.round((s.wallLlmMs || 0) / 1000)}s` +
      (s.failedCalls ? `, ${s.failedCalls} failed` : ''))
  }
  return lines.join('\n')
}

function status (vaultRoot) {
  const roost = path.join(vaultRoot, '.roost')
  const lines = ['# Kip status', '']

  try {
    const { describeProvider } = require(lib('llm'))
    lines.push(describeProvider(vaultRoot))
  } catch (e) { lines.push(`Provider: error — ${oneLine(e.message)}`) }

  try {
    const { openDb } = require(lib('db'))
    const db = openDb(vaultRoot)
    try {
      const total = db.prepare('SELECT COUNT(*) AS n FROM pages').get().n
      const byType = db.prepare('SELECT type, COUNT(*) AS n FROM pages GROUP BY type ORDER BY n DESC').all()
      lines.push(`Nest: ${total} page(s)${byType.length ? ` — ${byType.map((r) => `${r.n} ${r.type}`).join(', ')}` : ''}`)
    } finally { db.close() }
  } catch (e) { lines.push(`Nest: error reading meta.db — ${oneLine(e.message)}`) }

  try {
    const prev = JSON.parse(runScript('hatch-all.js', ['--preview'], { vaultRoot }))
    const extra = []
    if (prev.oversized && prev.oversized.length) extra.push(`${prev.oversized.length} oversized`)
    if (prev.empty && prev.empty.length) extra.push(`${prev.empty.length} skipped-empty`)
    lines.push(`Pending sources: ${prev.pending.length} (${prev.totalKb} KB)${extra.length ? ` · ${extra.join(', ')}` : ''}`)
  } catch (e) { lines.push(`Pending sources: error — ${oneLine(e.message)}`) }

  lines.push('')
  lines.push(jobLine('Hatch', path.join(roost, 'hatch-progress.json'), path.join(roost, 'hatch-metrics.json')))
  lines.push(jobLine('Deep groom', path.join(roost, 'groom-progress.json'), path.join(roost, 'groom-metrics.json')))

  try {
    const { discoverSkills } = require(lib('skills'))
    const skills = discoverSkills(vaultRoot, { includeDisabled: true })
    const on = skills.filter((s) => s.enabled).map((s) => s.name)
    const off = skills.filter((s) => !s.enabled).map((s) => s.name)
    lines.push('', `Skills on: ${on.join(', ') || 'none'}`)
    if (off.length) lines.push(`Skills off: ${off.join(', ')}`)
  } catch (e) { lines.push('', `Skills: error — ${oneLine(e.message)}`) }

  try {
    const { recentClucks } = require(lib('roost'))
    const recent = recentClucks(6, vaultRoot)
    if (recent.length) {
      lines.push('', 'Recent activity:')
      for (const r of recent) {
        lines.push(`- ${String(r.timestamp).slice(0, 16).replace('T', ' ')} · ${r.kind} · ${r.title}`)
      }
    }
  } catch { /* clucks are optional */ }

  return lines.join('\n')
}

function groomSummary (r) {
  const d = r.drift || { missingFiles: [], untrackedFiles: [] }
  const driftCount = (d.missingFiles || []).length + (d.untrackedFiles || []).length
  const lines = [
    '**Quick groom** — structural checks only, read-only, nothing was changed.',
    '',
    `- Orphan pages (nothing links in): ${(r.orphans || []).length}`,
    `- Filesystem drift (meta.db vs nest/): ${driftCount}`,
    `- Near-duplicate slugs: ${(r.nearDuplicates || []).length}`,
    `- Possible contradictions: ${(r.contradictions || []).length}`
  ]
  const orph = (r.orphans || []).slice(0, 12)
  if (orph.length) lines.push('', `Orphans: ${orph.join(', ')}${r.orphans.length > 12 ? ' …' : ''}`)
  const dupes = (r.nearDuplicates || []).slice(0, 8)
  if (dupes.length) {
    lines.push('', 'Near-duplicate slugs:')
    for (const x of dupes) lines.push(`- ${x.slugs[0]} ↔ ${x.slugs[1]} (${x.score})`)
  }
  const cons = (r.contradictions || []).slice(0, 6)
  if (cons.length) {
    lines.push('', 'Possible contradictions:')
    for (const c of cons) lines.push(`- [${(c.slugs || []).join(', ')}] ${c.description}`)
  }
  if (driftCount) lines.push('', 'Drift found — run `rebuild-roost` to bring meta.db back in sync.')
  lines.push('', 'For the deep weekly pass (page coherence, summary drift, merge / missing / broken links, a wider contradiction sweep) run `groom-deep`.')
  return lines.join('\n')
}

function settings (vaultRoot) {
  const lines = ['# Kip settings', '', '## LLM provider']
  try {
    const { getProviderConfig, loadLLMConfig } = require(lib('llm'))
    const c = getProviderConfig(vaultRoot)
    lines.push(`- provider: ${c.provider}`)
    lines.push(`- model: ${c.model || '(none configured)'}`)
    if (c.baseUrl) lines.push(`- baseUrl: ${c.baseUrl}`)
    lines.push(`- API key: ${c.apiKey ? 'set' : 'not set'}`)
    lines.push(`- config source: ${loadLLMConfig(vaultRoot) ? '.henhouse/llm.json' : 'environment variables only'}`)
  } catch (e) { lines.push(`- error — ${oneLine(e.message)}`) }

  lines.push('', '## Skills')
  try {
    const { discoverSkills } = require(lib('skills'))
    for (const s of discoverSkills(vaultRoot, { includeDisabled: true })) {
      lines.push(`- **${s.name}** — ${s.enabled ? 'on' : 'off'} · ${s.source}${s.network ? ' · network' : ''} — ${s.description}`)
    }
  } catch (e) { lines.push(`- error — ${oneLine(e.message)}`) }

  lines.push('', 'Change the provider with `set-provider` (provider / model / baseUrl / apiKey), re-check it with `test-connection`, or flip a skill with `set-skill` (skill + enabled).')
  return lines.join('\n')
}

async function setProvider (input, vaultRoot) {
  const { loadLLMConfig, saveLLMConfig, getProviderConfig, testConnection } = require(lib('llm'))
  const provider = String(input.provider || '').trim().toLowerCase()
  if (provider && !PROVIDERS.includes(provider)) throw new KipControlError(`unknown provider "${provider}". One of: ${PROVIDERS.join(', ')}.`)

  const cfg = loadLLMConfig(vaultRoot) || {}
  const target = provider || cfg.provider
  if (!target) throw new KipControlError('no "provider" given and none is currently configured — pass one.')

  cfg.provider = target
  cfg.providers = cfg.providers || {}
  const pc = { ...(cfg.providers[target] || {}) }
  const changed = [`provider = ${target}`]
  if (input.model !== undefined) { pc.model = String(input.model); changed.push(`model = ${pc.model}`) }
  if (input.baseUrl !== undefined) { pc.baseUrl = String(input.baseUrl); changed.push(`baseUrl = ${pc.baseUrl}`) }
  if (input.apiKey !== undefined) { pc.apiKey = String(input.apiKey); changed.push('apiKey = (updated)') }
  cfg.providers[target] = pc
  saveLLMConfig(cfg, vaultRoot)

  const lines = [`Wrote .henhouse/llm.json: ${changed.join(', ')}.`]
  try {
    const c = getProviderConfig(vaultRoot)
    const r = await testConnection({ provider: c.provider, apiKey: c.apiKey, model: c.model, baseUrl: c.baseUrl })
    lines.push(r.success
      ? `Connection test: OK — replied "${String(r.reply).trim().slice(0, 60)}"`
      : `Connection test: FAILED — ${r.error}`)
  } catch (e) {
    lines.push(`Connection test skipped — ${e.message}`)
  }
  return lines.join('\n')
}

async function testConn (vaultRoot) {
  const { getProviderConfig, testConnection } = require(lib('llm'))
  const c = getProviderConfig(vaultRoot)
  const r = await testConnection({ provider: c.provider, apiKey: c.apiKey, model: c.model, baseUrl: c.baseUrl })
  return `Connection to ${c.provider} (${c.model || 'default model'}): ` +
    (r.success ? `OK — replied "${String(r.reply).trim().slice(0, 60)}"` : `FAILED — ${r.error}`)
}

function setSkill (input, vaultRoot) {
  const { discoverSkills } = require(lib('skills'))
  const name = String(input.skill || '').trim()
  if (!name) throw new KipControlError('"skill" (the skill name) is required.')
  if (typeof input.enabled !== 'boolean') throw new KipControlError('"enabled" must be true or false.')

  const known = discoverSkills(vaultRoot, { includeDisabled: true }).map((s) => s.name)
  if (!known.includes(name)) throw new KipControlError(`no skill named "${name}". Known: ${known.join(', ')}.`)
  if (name === 'kip-control' && input.enabled === false) {
    throw new KipControlError('refusing to disable kip-control itself — that removes this control surface. Edit .henhouse/skills.json by hand if you really mean to.')
  }

  const file = path.join(vaultRoot, '.henhouse', 'skills.json')
  const cfg = readJson(file) || {}
  const disabled = new Set(Array.isArray(cfg.disabled) ? cfg.disabled : [])
  if (input.enabled) disabled.delete(name)
  else disabled.add(name)
  cfg.disabled = [...disabled]
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')

  return `Skill "${name}" is now ${input.enabled ? 'enabled' : 'disabled'} — effective on Peck's next turn.`
}

/**
 * Runs one kip-control operation and returns its markdown/output string.
 * Throws `KipControlError` for an unknown operation or a failed step.
 * `input` is `{ operation, limit?, provider?, model?, baseUrl?, apiKey?, skill?, enabled? }`.
 */
async function runKipControlOperation (input = {}, { vaultRoot = DEFAULT_VAULT_ROOT } = {}) {
  const roost = path.join(vaultRoot, '.roost')
  const op = String(input.operation || '').trim()
  if (!op) throw new KipControlError(`"operation" is required. One of: ${OPERATIONS.join(', ')}.`)
  if (!OPERATIONS.includes(op)) throw new KipControlError(`unknown operation "${op}". One of: ${OPERATIONS.join(', ')}.`)

  switch (op) {
    case 'status':
      return status(vaultRoot)
    case 'hatch-preview':
      return '```json\n' + runScript('hatch-all.js', ['--preview'], { vaultRoot }).trim() + '\n```'
    case 'hatch': {
      const n = Number(input.limit)
      const args = Number.isFinite(n) && n > 0 ? ['--limit', String(Math.floor(n))] : []
      const pid = launchDetached('hatch-all.js', args, { vaultRoot })
      return `Started a Hatch run in the background (pid ${pid}, ${args.length ? `limit ${args[1]}` : 'default batch of 10'}). ` +
        'Ask me for `hatch-progress` to watch it — it makes one LLM call per source file.'
    }
    case 'hatch-progress':
      return progressReport('Hatch', path.join(roost, 'hatch-progress.json'))
    case 'groom':
      return groomSummary(JSON.parse(runScript('groom.js', ['--json'], { vaultRoot })))
    case 'groom-deep': {
      const pid = launchDetached('groom.js', ['--deep'], { vaultRoot })
      return `Started a deep Groom in the background (pid ${pid}). It makes many LLM calls and can take several minutes. ` +
        'Ask me for `groom-progress` to watch it, then `groom-report` for the checklist when it finishes.'
    }
    case 'groom-progress':
      return progressReport('Deep groom', path.join(roost, 'groom-progress.json'))
    case 'groom-report': {
      const f = path.join(roost, 'groom-report.md')
      if (!fs.existsSync(f)) return 'No groom report yet — run `groom-deep` first.'
      const txt = fs.readFileSync(f, 'utf8')
      return txt.length > 6000
        ? txt.slice(0, 6000) + '\n\n_…truncated — open `.roost/groom-report.md` for the rest._'
        : txt
    }
    case 'rebuild-roost':
      return runScript('rebuild-roost.js', [], { vaultRoot }).trim()
    case 'settings':
      return settings(vaultRoot)
    case 'set-provider':
      return setProvider(input, vaultRoot)
    case 'test-connection':
      return testConn(vaultRoot)
    case 'set-skill':
      return setSkill(input, vaultRoot)
    default:
      throw new KipControlError(`unknown operation "${op}".`)
  }
}

module.exports = {
  OPERATIONS,
  PROVIDERS,
  KipControlError,
  runKipControlOperation
}
