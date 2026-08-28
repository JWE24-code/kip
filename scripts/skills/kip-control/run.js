// kip-control skill — lets Peck drive Kip's own maintenance workflows and LLM
// settings instead of answering a wiki question: coop status, Hatch (preview /
// launch / progress), Groom (quick inline / deep in the background / progress /
// report), rebuild-roost, and the settings page (read the provider+skills,
// switch provider/model/key, test the connection, toggle a skill).
//
// Long jobs (hatch, groom-deep) are spawned DETACHED — the same CLI scripts the
// app's buttons shell out to — and keep running after this process exits; their
// progress lands in <coop>/.roost/*-progress.json, which the *-progress ops
// read. Everything else runs inline and prints markdown to stdout.
//
// Reads SKILL_INPUT { operation, ... }. KIP_COOP_ROOT (set by the skill runner)
// selects the graph; lib/paths.js resolves it.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')

const SCRIPTS_DIR = path.resolve(__dirname, '..', '..')
const lib = (name) => path.join(SCRIPTS_DIR, 'lib', name)
const { DEFAULT_VAULT_ROOT } = require(lib('paths'))
const VAULT = DEFAULT_VAULT_ROOT
const ROOST = path.join(VAULT, '.roost')

const OPERATIONS = [
  'status', 'hatch-preview', 'hatch', 'hatch-progress', 'groom', 'groom-deep',
  'groom-progress', 'groom-report', 'rebuild-roost', 'settings', 'set-provider',
  'test-connection', 'set-skill'
]
const PROVIDERS = ['anthropic', 'openai', 'deepseek', 'local', 'other']

function out (s) { console.log(typeof s === 'string' ? s : JSON.stringify(s, null, 2)) }
function fail (msg) { console.error(`kip-control: ${msg}`); process.exit(1) }

const input = (() => {
  try { return JSON.parse(process.env.SKILL_INPUT || '{}') } catch { return {} }
})()
const op = String(input.operation || '').trim()
if (!op) fail(`"operation" is required. One of: ${OPERATIONS.join(', ')}.`)
if (!OPERATIONS.includes(op)) fail(`unknown operation "${op}". One of: ${OPERATIONS.join(', ')}.`)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function readJson (file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** First non-empty line of a message — keeps multi-line Node errors (native
 *  ABI mismatches, stack traces) from blowing past the 8 KB output cap. */
function oneLine (msg) {
  return String(msg || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || String(msg || '')
}

/** Run a sibling CLI script and return its stdout. Surfaces its stderr on failure. */
function runScript (name, args = []) {
  try {
    return execFileSync(process.execPath, [path.join(SCRIPTS_DIR, name), ...args], {
      cwd: SCRIPTS_DIR, env: process.env, encoding: 'utf8', timeout: 110_000, maxBuffer: 8 * 1024 * 1024
    })
  } catch (err) {
    const detail = oneLine((err.stderr && String(err.stderr).trim()) || err.message)
    throw new Error(`${name} ${args.join(' ')} failed: ${detail}`)
  }
}

/** Launch a sibling CLI script detached — it outlives this process. Returns its pid. */
function launchDetached (name, args = []) {
  const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, name), ...args], {
    cwd: SCRIPTS_DIR, env: process.env, detached: true, stdio: 'ignore', windowsHide: true
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

// ---------------------------------------------------------------------------
// operations
// ---------------------------------------------------------------------------

function status () {
  const lines = ['# Kip status', '']

  try {
    const { describeProvider } = require(lib('llm'))
    lines.push(describeProvider(VAULT))
  } catch (e) { lines.push(`Provider: error — ${oneLine(e.message)}`) }

  try {
    const { openDb } = require(lib('db'))
    const db = openDb(VAULT)
    try {
      const total = db.prepare('SELECT COUNT(*) AS n FROM pages').get().n
      const byType = db.prepare('SELECT type, COUNT(*) AS n FROM pages GROUP BY type ORDER BY n DESC').all()
      lines.push(`Nest: ${total} page(s)${byType.length ? ` — ${byType.map((r) => `${r.n} ${r.type}`).join(', ')}` : ''}`)
    } finally { db.close() }
  } catch (e) { lines.push(`Nest: error reading meta.db — ${oneLine(e.message)}`) }

  try {
    const prev = JSON.parse(runScript('hatch-all.js', ['--preview']))
    const extra = []
    if (prev.oversized && prev.oversized.length) extra.push(`${prev.oversized.length} oversized`)
    if (prev.empty && prev.empty.length) extra.push(`${prev.empty.length} skipped-empty`)
    lines.push(`Pending sources: ${prev.pending.length} (${prev.totalKb} KB)${extra.length ? ` · ${extra.join(', ')}` : ''}`)
  } catch (e) { lines.push(`Pending sources: error — ${oneLine(e.message)}`) }

  lines.push('')
  lines.push(jobLine('Hatch', path.join(ROOST, 'hatch-progress.json'), path.join(ROOST, 'hatch-metrics.json')))
  lines.push(jobLine('Deep groom', path.join(ROOST, 'groom-progress.json'), path.join(ROOST, 'groom-metrics.json')))

  try {
    const { discoverSkills } = require(lib('skills'))
    const skills = discoverSkills(VAULT, { includeDisabled: true })
    const on = skills.filter((s) => s.enabled).map((s) => s.name)
    const off = skills.filter((s) => !s.enabled).map((s) => s.name)
    lines.push('', `Skills on: ${on.join(', ') || 'none'}`)
    if (off.length) lines.push(`Skills off: ${off.join(', ')}`)
  } catch (e) { lines.push('', `Skills: error — ${oneLine(e.message)}`) }

  try {
    const { recentClucks } = require(lib('roost'))
    const recent = recentClucks(6, VAULT)
    if (recent.length) {
      lines.push('', 'Recent activity:')
      for (const r of recent) {
        lines.push(`- ${String(r.timestamp).slice(0, 16).replace('T', ' ')} · ${r.kind} · ${r.title}`)
      }
    }
  } catch { /* clucks are optional */ }

  out(lines.join('\n'))
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

function settings () {
  const lines = ['# Kip settings', '', '## LLM provider']
  try {
    const { getProviderConfig, loadLLMConfig } = require(lib('llm'))
    const c = getProviderConfig(VAULT)
    lines.push(`- provider: ${c.provider}`)
    lines.push(`- model: ${c.model || '(none configured)'}`)
    if (c.baseUrl) lines.push(`- baseUrl: ${c.baseUrl}`)
    lines.push(`- API key: ${c.apiKey ? 'set' : 'not set'}`)
    lines.push(`- config source: ${loadLLMConfig(VAULT) ? '.henhouse/llm.json' : 'environment variables only'}`)
  } catch (e) { lines.push(`- error — ${oneLine(e.message)}`) }

  lines.push('', '## Skills')
  try {
    const { discoverSkills } = require(lib('skills'))
    for (const s of discoverSkills(VAULT, { includeDisabled: true })) {
      lines.push(`- **${s.name}** — ${s.enabled ? 'on' : 'off'} · ${s.source}${s.network ? ' · network' : ''} — ${s.description}`)
    }
  } catch (e) { lines.push(`- error — ${oneLine(e.message)}`) }

  lines.push('', 'Change the provider with `set-provider` (provider / model / baseUrl / apiKey), re-check it with `test-connection`, or flip a skill with `set-skill` (skill + enabled).')
  out(lines.join('\n'))
}

async function setProvider () {
  const { loadLLMConfig, saveLLMConfig, getProviderConfig, testConnection } = require(lib('llm'))
  const provider = String(input.provider || '').trim().toLowerCase()
  if (provider && !PROVIDERS.includes(provider)) fail(`unknown provider "${provider}". One of: ${PROVIDERS.join(', ')}.`)

  const cfg = loadLLMConfig(VAULT) || {}
  const target = provider || cfg.provider
  if (!target) fail('no "provider" given and none is currently configured — pass one.')

  cfg.provider = target
  cfg.providers = cfg.providers || {}
  const pc = { ...(cfg.providers[target] || {}) }
  const changed = [`provider = ${target}`]
  if (input.model !== undefined) { pc.model = String(input.model); changed.push(`model = ${pc.model}`) }
  if (input.baseUrl !== undefined) { pc.baseUrl = String(input.baseUrl); changed.push(`baseUrl = ${pc.baseUrl}`) }
  if (input.apiKey !== undefined) { pc.apiKey = String(input.apiKey); changed.push('apiKey = (updated)') }
  cfg.providers[target] = pc
  saveLLMConfig(cfg, VAULT)

  const lines = [`Wrote .henhouse/llm.json: ${changed.join(', ')}.`]
  try {
    const c = getProviderConfig(VAULT)
    const r = await testConnection({ provider: c.provider, apiKey: c.apiKey, model: c.model, baseUrl: c.baseUrl })
    lines.push(r.success
      ? `Connection test: OK — replied "${String(r.reply).trim().slice(0, 60)}"`
      : `Connection test: FAILED — ${r.error}`)
  } catch (e) {
    lines.push(`Connection test skipped — ${e.message}`)
  }
  out(lines.join('\n'))
}

async function testConn () {
  const { getProviderConfig, testConnection } = require(lib('llm'))
  let c
  try { c = getProviderConfig(VAULT) } catch (e) { return fail(e.message) }
  const r = await testConnection({ provider: c.provider, apiKey: c.apiKey, model: c.model, baseUrl: c.baseUrl })
  out(`Connection to ${c.provider} (${c.model || 'default model'}): ` +
    (r.success ? `OK — replied "${String(r.reply).trim().slice(0, 60)}"` : `FAILED — ${r.error}`))
}

function setSkill () {
  const { discoverSkills } = require(lib('skills'))
  const name = String(input.skill || '').trim()
  if (!name) fail('"skill" (the skill name) is required.')
  if (typeof input.enabled !== 'boolean') fail('"enabled" must be true or false.')

  const known = discoverSkills(VAULT, { includeDisabled: true }).map((s) => s.name)
  if (!known.includes(name)) fail(`no skill named "${name}". Known: ${known.join(', ')}.`)
  if (name === 'kip-control' && input.enabled === false) {
    fail('refusing to disable kip-control itself — that removes this control surface. Edit .henhouse/skills.json by hand if you really mean to.')
  }

  const file = path.join(VAULT, '.henhouse', 'skills.json')
  const cfg = readJson(file) || {}
  const disabled = new Set(Array.isArray(cfg.disabled) ? cfg.disabled : [])
  if (input.enabled) disabled.delete(name)
  else disabled.add(name)
  cfg.disabled = [...disabled]
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')

  out(`Skill "${name}" is now ${input.enabled ? 'enabled' : 'disabled'} — effective on Peck's next turn.`)
}

// ---------------------------------------------------------------------------

async function main () {
  switch (op) {
    case 'status':
      return status()

    case 'hatch-preview':
      return out('```json\n' + runScript('hatch-all.js', ['--preview']).trim() + '\n```')

    case 'hatch': {
      const n = Number(input.limit)
      const args = Number.isFinite(n) && n > 0 ? ['--limit', String(Math.floor(n))] : []
      const pid = launchDetached('hatch-all.js', args)
      return out(`Started a Hatch run in the background (pid ${pid}, ${args.length ? `limit ${args[1]}` : 'default batch of 10'}). ` +
        'Ask me for `hatch-progress` to watch it — it makes one LLM call per source file.')
    }

    case 'hatch-progress':
      return out(progressReport('Hatch', path.join(ROOST, 'hatch-progress.json')))

    case 'groom':
      return out(groomSummary(JSON.parse(runScript('groom.js', ['--json']))))

    case 'groom-deep': {
      const pid = launchDetached('groom.js', ['--deep'])
      return out(`Started a deep Groom in the background (pid ${pid}). It makes many LLM calls and can take several minutes. ` +
        'Ask me for `groom-progress` to watch it, then `groom-report` for the checklist when it finishes.')
    }

    case 'groom-progress':
      return out(progressReport('Deep groom', path.join(ROOST, 'groom-progress.json')))

    case 'groom-report': {
      const f = path.join(ROOST, 'groom-report.md')
      if (!fs.existsSync(f)) return out('No groom report yet — run `groom-deep` first.')
      const txt = fs.readFileSync(f, 'utf8')
      return out(txt.length > 6000
        ? txt.slice(0, 6000) + '\n\n_…truncated — open `.roost/groom-report.md` for the rest._'
        : txt)
    }

    case 'rebuild-roost':
      return out(runScript('rebuild-roost.js').trim())

    case 'settings':
      return settings()

    case 'set-provider':
      return setProvider()

    case 'test-connection':
      return testConn()

    case 'set-skill':
      return setSkill()
  }
}

main().catch((e) => fail((e && e.message) || String(e)))
