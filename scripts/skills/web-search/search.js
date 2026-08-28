// Backends for the web-search skill. Pure + injectable (fetchImpl) so run.js
// stays a thin entry and the parsing is unit-testable.
//
//   pickBackend(env)                      -> 'duckduckgo' | 'brave' | 'tavily'
//   search(backend, query, count, opts)   -> [{ title, url, snippet }]
//   parseDuckDuckGoHtml(html, count)      -> same shape, from the HTML endpoint
//
// DuckDuckGo is keyless (its no-JS HTML endpoint answers a plain GET); Brave and
// Tavily need an API key passed in opts.

const DEFAULT_BACKEND = 'duckduckgo'
const BACKENDS = ['duckduckgo', 'brave', 'tavily']
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const FETCH_TIMEOUT_MS = 15_000

function pickBackend (env = {}) {
  const b = String(env.SEARCH_BACKEND || '').trim().toLowerCase()
  return BACKENDS.includes(b) ? b : DEFAULT_BACKEND
}

// --- HTML helpers ----------------------------------------------------------

function decodeEntities (s) {
  return String(s == null ? '' : s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCodePoint(parseInt(h, 16)))
}

function safeFromCodePoint (n) {
  try { return Number.isFinite(n) ? String.fromCodePoint(n) : '' } catch { return '' }
}

function stripTags (s) {
  return String(s == null ? '' : s).replace(/<[^>]+>/g, '')
}

function collapse (s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
}

/** DuckDuckGo wraps every result href as //duckduckgo.com/l/?uddg=<encoded>. */
function unwrapDdgRedirect (href) {
  const h = String(href || '').trim()
  const m = h.match(/[?&]uddg=([^&]+)/)
  if (m) {
    try { return decodeURIComponent(m[1]) } catch { /* fall through */ }
  }
  if (h.startsWith('//')) return 'https:' + h
  return h
}

/**
 * Pulls organic results out of https://html.duckduckgo.com/html/ markup:
 * an <a class="result__a" href="…">title</a> per result, each followed by an
 * <a class="result__snippet">…</a>. Ads (result--ad) carry no result__a, so
 * they're skipped for free.
 */
function parseDuckDuckGoHtml (html, count = 10) {
  const out = []
  const anchorRe = /<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = anchorRe.exec(html)) && out.length < count) {
    const url = unwrapDdgRedirect(decodeEntities(m[1]))
    const title = collapse(stripTags(decodeEntities(m[2])))
    // organic results resolve to a real external URL; ads/trackers stay on
    // duckduckgo.com (y.js) and are skipped.
    if (!title || !/^https?:\/\//i.test(url) || /^https?:\/\/(?:[^/]*\.)?duckduckgo\.com\b/i.test(url)) continue
    const after = html.slice(anchorRe.lastIndex, anchorRe.lastIndex + 4000)
    const sm = after.match(/<a\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
    const snippet = sm ? collapse(stripTags(decodeEntities(sm[1]))) : ''
    out.push({ title, url, snippet })
  }
  return out
}

// --- fetch ---------------------------------------------------------------

async function fetchWithTimeout (fetchImpl, url, opts = {}) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, { ...opts, signal: ac.signal })
    if (!res.ok) throw new Error(`request failed (${res.status})`)
    return res
  } finally {
    clearTimeout(t)
  }
}

// --- backends -----------------------------------------------------------

async function duckduckgoSearch (query, count, { fetchImpl = fetch } = {}) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query) + '&kl=us-en'
  const res = await fetchWithTimeout(fetchImpl, url, {
    headers: { 'User-Agent': UA, Accept: 'text/html' }
  })
  return parseDuckDuckGoHtml(await res.text(), count)
}

async function braveSearch (query, count, { apiKey, fetchImpl = fetch } = {}) {
  const url = 'https://api.search.brave.com/res/v1/web/search?q=' +
    encodeURIComponent(query) + '&count=' + count
  const res = await fetchWithTimeout(fetchImpl, url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey }
  })
  const data = await res.json()
  return (data.web && data.web.results ? data.web.results : []).slice(0, count).map((r) => ({
    title: r.title, url: r.url, snippet: r.description || ''
  }))
}

async function tavilySearch (query, count, { apiKey, fetchImpl = fetch } = {}) {
  const res = await fetchWithTimeout(fetchImpl, 'https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: count })
  })
  const data = await res.json()
  return (data.results || []).slice(0, count).map((r) => ({
    title: r.title, url: r.url, snippet: r.content || ''
  }))
}

async function search (backend, query, count, opts = {}) {
  const n = Math.min(Math.max(1, Number(count) || 5), 10)
  switch (backend) {
    case 'brave': return braveSearch(query, n, { apiKey: opts.braveApiKey, fetchImpl: opts.fetchImpl })
    case 'tavily': return tavilySearch(query, n, { apiKey: opts.tavilyApiKey, fetchImpl: opts.fetchImpl })
    default: return duckduckgoSearch(query, n, { fetchImpl: opts.fetchImpl })
  }
}

module.exports = {
  DEFAULT_BACKEND,
  BACKENDS,
  pickBackend,
  parseDuckDuckGoHtml,
  unwrapDdgRedirect,
  decodeEntities,
  duckduckgoSearch,
  braveSearch,
  tavilySearch,
  search
}
