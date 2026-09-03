// Turns a Peck turn's web-search results into a hatchable source doc
// (kip-app#81). When Peck runs the `web-search` skill to answer a question,
// the results otherwise vanish with the turn; this lets the app offer to save
// them into pages/ so they become reference material in the nest.
//
// v1 saves the result list (title / url / snippet). Fetching the full text of
// each page is a follow-up.

const SLUG_MAX = 60

function slugify (s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '') || 'query'
}

/**
 * Parse one `web-search` skill run's stdout back into structured results.
 * The skill prints:
 *   Results for "<query>" (via <backend>):
 *
 *   - [title](url) — snippet
 *   ...
 * or `No results for "<query>" (via <backend>).`
 * Returns { query, backend, results: [{title, url, snippet}] } or null.
 */
function parseWebSearchOutput (text) {
  const s = String(text || '')
  const head = s.match(/^(?:Results|No results) for "([^"]*)" \(via ([^)]+)\)/m)
  if (!head) return null
  const query = head[1]
  const backend = head[2].trim()
  const results = []
  const line = /^-\s+\[([^\]]+)\]\(([^)]+)\)(?:\s+[—-]\s+(.*))?$/gm
  let m
  while ((m = line.exec(s))) {
    results.push({ title: m[1].trim(), url: m[2].trim(), snippet: (m[3] || '').trim() })
  }
  return { query, backend, results }
}

/**
 * Build the source doc (front-matter + markdown) for one Peck turn's web
 * searches. `question` is the user's original question; `searches` is the
 * array of parsed { query, backend, results } (one per web-search run).
 * Returns { filename, content } or null when there's nothing worth saving.
 */
function buildWebSource (question, searches, { now = new Date() } = {}) {
  const kept = (searches || []).filter((x) => x && Array.isArray(x.results) && x.results.length)
  if (!kept.length) return null

  const date = now.toISOString().slice(0, 10)
  const filename = `web-search-${date}-${slugify(question || kept[0].query)}.md`

  const fm = [
    '---',
    'source: web-search',
    `question: ${JSON.stringify(String(question || '').trim())}`,
    `saved: "${date}"`,
    `backends: [${[...new Set(kept.map((s) => JSON.stringify(s.backend)))].join(', ')}]`,
    '---',
    ''
  ]

  const body = [`# Web search — ${String(question || kept[0].query).trim()}`, '',
    `Saved ${date}. These are search results (title, link, snippet), not the full page text.`, '']

  for (const s of kept) {
    if (kept.length > 1) body.push(`## "${s.query}" (via ${s.backend})`, '')
    for (const r of s.results) {
      body.push(`- [${r.title}](${r.url})${r.snippet ? ` — ${r.snippet}` : ''}`)
    }
    body.push('')
  }

  return { filename, content: fm.join('\n') + body.join('\n').trimEnd() + '\n' }
}

module.exports = { parseWebSearchOutput, buildWebSource, slugify }
