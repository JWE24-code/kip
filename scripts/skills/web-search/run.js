// web-search skill — reads SKILL_INPUT {query, count?}, prints a markdown list
// of results as `- [title](url) — snippet`.
//
// Backend is chosen by SEARCH_BACKEND (Settings -> Skills writes it into
// <coop>/.henhouse/skills.json). Default: "duckduckgo" — keyless, works out of
// the box. "brave" / "tavily" need BRAVE_API_KEY / TAVILY_API_KEY (also from
// skills.json); without the key the skill prints a "configure me" note and
// exits 0 so Peck just answers from the wiki.

const { pickBackend, search } = require('./search')

const input = (() => {
  try { return JSON.parse(process.env.SKILL_INPUT || '{}') } catch { return {} }
})()

const query = typeof input.query === 'string' ? input.query.trim() : ''
if (!query) {
  console.error('web-search: "query" is required.')
  process.exit(1)
}
const count = Math.min(Math.max(1, Number(input.count) || 5), 10)
const backend = pickBackend(process.env)

const braveApiKey = process.env.BRAVE_API_KEY
const tavilyApiKey = process.env.TAVILY_API_KEY

function needsKey (label, envVar) {
  console.log(
    `web-search is set to the ${label} backend but no API key is configured. ` +
    `Add one in Settings -> Skills (or set ${envVar} in <coop>/.henhouse/skills.json), ` +
    'or switch to the keyless DuckDuckGo backend. Answering from the wiki for now.'
  )
  process.exit(0)
}

if (backend === 'brave' && !braveApiKey) needsKey('Brave', 'BRAVE_API_KEY')
if (backend === 'tavily' && !tavilyApiKey) needsKey('Tavily', 'TAVILY_API_KEY')

;(async () => {
  try {
    const results = await search(backend, query, count, { braveApiKey, tavilyApiKey })
    if (!results.length) {
      console.log(`No results for "${query}" (via ${backend}).`)
      return
    }
    const lines = [`Results for "${query}" (via ${backend}):`, '']
    for (const r of results) {
      const snip = String(r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 240)
      lines.push(`- [${r.title}](${r.url})${snip ? ` — ${snip}` : ''}`)
    }
    console.log(lines.join('\n'))
  } catch (err) {
    console.error(`web-search (${backend}): ${err.message}`)
    process.exit(1)
  }
})()
