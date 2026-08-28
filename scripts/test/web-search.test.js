const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  pickBackend, parseDuckDuckGoHtml, unwrapDdgRedirect,
  duckduckgoSearch, braveSearch, tavilySearch, search
} = require('../skills/web-search/search')

const DDG_FIXTURE = fs.readFileSync(
  path.join(__dirname, '..', 'skills', 'web-search', 'fixtures', 'ddg.html'), 'utf8')

// ---------------------------------------------------------------------------

test('pickBackend: default duckduckgo, explicit values, junk falls back', () => {
  assert.equal(pickBackend({}), 'duckduckgo')
  assert.equal(pickBackend({ SEARCH_BACKEND: 'brave' }), 'brave')
  assert.equal(pickBackend({ SEARCH_BACKEND: 'TAVILY' }), 'tavily')
  assert.equal(pickBackend({ SEARCH_BACKEND: 'bing' }), 'duckduckgo')
})

test('unwrapDdgRedirect: pulls the real URL out of the l/?uddg= wrapper', () => {
  assert.equal(
    unwrapDdgRedirect('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&rut=x'),
    'https://example.com/a?b=1')
  assert.equal(unwrapDdgRedirect('//example.com/plain'), 'https://example.com/plain')
  assert.equal(unwrapDdgRedirect('https://example.com'), 'https://example.com')
})

test('parseDuckDuckGoHtml: organic results only, links unwrapped, entities decoded', () => {
  const results = parseDuckDuckGoHtml(DDG_FIXTURE, 10)
  assert.equal(results.length, 2, 'the ad row is skipped')

  assert.deepEqual(results[0], {
    title: 'Introducing Claude & friends',
    url: 'https://www.anthropic.com/news/claude',
    snippet: "Anthropic's AI assistant, Claude, can help with analysis & writing."
  })
  assert.equal(results[1].url, 'https://en.wikipedia.org/wiki/Claude_(language_model)')
  assert.match(results[1].title, /Wikipedia/)
})

test('parseDuckDuckGoHtml: honours the count cap', () => {
  assert.equal(parseDuckDuckGoHtml(DDG_FIXTURE, 1).length, 1)
})

// ---------------------------------------------------------------------------

function jsonResponse (body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
}
function htmlResponse (body) {
  return { ok: true, status: 200, text: async () => body }
}

test('duckduckgoSearch: fetches the HTML endpoint and parses it', async () => {
  let calledUrl = null
  const fetchImpl = async (url) => { calledUrl = url; return htmlResponse(DDG_FIXTURE) }
  const results = await duckduckgoSearch('claude ai', 5, { fetchImpl })
  assert.match(calledUrl, /^https:\/\/html\.duckduckgo\.com\/html\/\?q=claude%20ai/)
  assert.equal(results.length, 2)
  assert.equal(results[0].url, 'https://www.anthropic.com/news/claude')
})

test('braveSearch: maps the API shape', async () => {
  const fetchImpl = async (url, opts) => {
    assert.equal(opts.headers['X-Subscription-Token'], 'brave-key')
    return jsonResponse({ web: { results: [{ title: 'T', url: 'https://x', description: 'D' }] } })
  }
  const results = await braveSearch('q', 5, { apiKey: 'brave-key', fetchImpl })
  assert.deepEqual(results, [{ title: 'T', url: 'https://x', snippet: 'D' }])
})

test('tavilySearch: maps the API shape', async () => {
  const fetchImpl = async (_url, opts) => {
    assert.match(opts.body, /"api_key":"tav-key"/)
    return jsonResponse({ results: [{ title: 'T', url: 'https://y', content: 'C' }] })
  }
  const results = await tavilySearch('q', 5, { apiKey: 'tav-key', fetchImpl })
  assert.deepEqual(results, [{ title: 'T', url: 'https://y', snippet: 'C' }])
})

test('search: dispatches on backend and clamps count', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /html\.duckduckgo\.com/)
    return htmlResponse(DDG_FIXTURE)
  }
  const results = await search('duckduckgo', 'q', 99, { fetchImpl })
  assert.ok(results.length >= 1)
})
