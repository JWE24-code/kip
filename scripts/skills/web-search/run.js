// web-search skill — reads SKILL_INPUT {query, count?} and returns search
// results to the model.
//
// Under the sandboxed executor (kip#78) this skill has no network of its own:
// it asks the parent for a `web_search`, and the parent runs the configured
// backend with its key. The returned results are always fenced as quoted,
// non-instructional source material (see ./untrusted) before they reach the
// model.
//
// The `require` fallback is only for the legacy `scripts/lib/skills.js` CLI
// runner, which predates the sandbox and provides no `globalThis.kip`. That
// path keeps the historical `- [title](url) — snippet` shape because the old
// Peck flow parses it with lib/web-sources.js.
const input = (() => {
  try { return JSON.parse(process.env.SKILL_INPUT || '{}') } catch { return {} }
})()

const query = typeof input.query === 'string' ? input.query.trim() : ''
if (!query) {
  console.error('web-search: "query" is required.')
  process.exit(1)
}
const count = Math.min(Math.max(1, Number(input.count) || 5), 10)

async function viaHostcall () {
  const value = await globalThis.kip.hostcall('web_search', { query, count })
  const { wrapUntrustedWebResults } = require('./untrusted')
  const results = (value && value.results) || []
  if (!results.length) return `No results for "${query}" (via ${(value && value.backend) || 'search'}).`
  return wrapUntrustedWebResults(results, { query, backend: (value && value.backend) || '' })
}

async function viaLegacy () {
  const { pickBackend, search } = require('./search')
  const backend = pickBackend(process.env)
  const braveApiKey = process.env.BRAVE_API_KEY
  const tavilyApiKey = process.env.TAVILY_API_KEY

  const needsKey = (label, envVar) =>
    `web-search is set to the ${label} backend but no API key is configured. ` +
    `Add one in Settings -> Skills (or set ${envVar} in <coop>/.henhouse/skills.json), ` +
    'or switch to the keyless DuckDuckGo backend. Answering from the wiki for now.'
  if (backend === 'brave' && !braveApiKey) return needsKey('Brave', 'BRAVE_API_KEY')
  if (backend === 'tavily' && !tavilyApiKey) return needsKey('Tavily', 'TAVILY_API_KEY')

  const results = await search(backend, query, count, { braveApiKey, tavilyApiKey })
  if (!results.length) return `No results for "${query}" (via ${backend}).`
  const lines = [`Results for "${query}" (via ${backend}):`, '']
  for (const r of results) {
    const snip = String(r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 240)
    lines.push(`- [${r.title}](${r.url})${snip ? ` — ${snip}` : ''}`)
  }
  return lines.join('\n')
}

;(async () => {
  try {
    const hasBridge = globalThis.kip && typeof globalThis.kip.hostcall === 'function'
    const out = hasBridge ? await viaHostcall() : await viaLegacy()
    console.log(out)
  } catch (err) {
    console.error(`web-search: ${(err && err.message) || String(err)}`)
    process.exit(1)
  }
})()
