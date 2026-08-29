// The "Kip (managed)" connector — routes every LLM call through the managed
// Kip backend (api.kip-ai.be or a self-hosted equivalent) instead of a
// per-provider key. One `kip_` key; the backend picks the model per
// workload, enforces the plan, and meters usage.
//
// This is an AGPL-3.0 ProviderSpec that ships with Kip (see kip-app#62 and
// kip-backend/KIP-BACKEND.md §15-16 for why an AGPL client leaves the
// backend proprietary). It's registered as a built-in in connectors.js but
// hidden from the settings dropdown until the user opts in (kip-app#58) —
// invite-only for now, gated by whether the backend issues you a key.
//
// Contract (KIP-BACKEND.md §3):
//   POST {baseUrl}/v1/chat/completions
//   Authorization: Bearer kip_…
//   X-Kip-Workload: <full call label>      e.g. "hatch:generate:entity"
//   X-Kip-Phase:    <first ":"-segment>    e.g. "hatch"
//   body { model: "auto", max_tokens, messages: [system?, user], response_format? }
//   -> OpenAI-shaped response; `model` is the real upstream model (telemetry),
//      `usage` carries the token counts.
//   errors: 401 bad key · 402 plan/budget · 429 rate limit · 5xx upstream,
//           OpenAI-shaped { error: { message, type, code } }.

const CONNECTOR_API = 1
const DEFAULT_BASE_URL = 'https://api.kip-ai.be'
const JSON_MODE_INSTRUCTION =
  'Respond with ONLY valid JSON and no other text — no markdown code fences, no explanation.'

function stripCodeFences (text) {
  const trimmed = String(text).trim()
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/)
  return fenced ? fenced[1].trim() : trimmed
}

/** "hatch:generate:entity" -> "hatch"; "" / no label -> null (header omitted). */
function phaseOf (label) {
  if (!label || typeof label !== 'string') return null
  const first = label.split(':')[0].trim()
  return first || null
}

function buildMessages (system, prompt) {
  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt })
  return messages
}

async function post (baseUrl, apiKey, body, headers, doFetch, signal) {
  const res = await doFetch(`${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...headers
    },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok) {
    let detail
    try {
      const j = await res.json()
      detail = j && j.error && j.error.message
    } catch { /* non-JSON error body */ }
    if (!detail) detail = await res.text().catch(() => '')
    const err = new Error(`Kip backend request failed (${res.status})${detail ? `: ${detail}` : ''}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

/** Shared by complete() and testConnection(): one call, returns { text, raw }. */
async function callBackend (resolved, call, ctx) {
  const doFetch = (ctx && ctx.fetch) || fetch
  const signal = ctx && ctx.signal
  const baseUrl = resolved.baseUrl || DEFAULT_BASE_URL

  const routingHeaders = {}
  if (call.label) {
    routingHeaders['X-Kip-Workload'] = call.label
    const phase = phaseOf(call.label)
    if (phase) routingHeaders['X-Kip-Phase'] = phase
  }

  const base = {
    model: 'auto',
    max_tokens: call.maxTokens,
    messages: buildMessages(call.system, call.prompt)
  }

  let data
  if (call.json) {
    try {
      data = await post(baseUrl, resolved.apiKey, { ...base, response_format: { type: 'json_object' } }, routingHeaders, doFetch, signal)
    } catch (err) {
      // a routing/plan/auth error is real — only retry a plain 400 (upstream
      // rejected response_format), matching the OpenAI-compatible path.
      if (err.status !== 400) throw err
      const sys = call.system ? `${call.system}\n\n${JSON_MODE_INSTRUCTION}` : JSON_MODE_INSTRUCTION
      data = await post(baseUrl, resolved.apiKey, { ...base, messages: buildMessages(sys, call.prompt) }, routingHeaders, doFetch, signal)
    }
  } else {
    data = await post(baseUrl, resolved.apiKey, base, routingHeaders, doFetch, signal)
  }

  const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ''
  return { text: call.json ? stripCodeFences(raw) : String(raw).trim(), raw: data }
}

/** @type {import('./connectors').ProviderSpec} */
module.exports = {
  kipConnectorApi: CONNECTOR_API,
  id: 'kip',
  label: 'Kip (managed)',
  fields: [
    { key: 'apiKey', label: 'API key', type: 'password', required: true, placeholder: 'kip_…', help: 'From your Kip backend admin → Accounts → Keys.' },
    { key: 'baseUrl', label: 'Base URL', type: 'text', required: false, default: DEFAULT_BASE_URL, help: 'Leave as-is for the hosted service, or point it at a self-hosted Kip backend.' }
  ],
  envDefaults: { apiKey: 'KIP_API_KEY', baseUrl: 'KIP_BASE_URL' },
  isReady: (cfg) => !!(cfg && cfg.apiKey),

  async complete (resolved, call, ctx) {
    return callBackend(resolved, call, ctx)
  },

  async testConnection (resolved, ctx) {
    try {
      const { text } = await callBackend(
        resolved,
        { system: '', prompt: 'Reply with exactly: OK', json: false, maxTokens: 10, label: 'test:connection' },
        ctx
      )
      return { success: true, reply: text }
    } catch (err) {
      return { success: false, error: err.message || String(err) }
    }
  },

  humanizeError (raw) {
    const s = String(raw)
    if (/\(401\)|invalid.{0,12}api.?key|bad.?api.?key/i.test(s)) {
      return { title: 'The Kip backend rejected your key.', hint: 'Check the kip_ key in Settings → LLM, or ask your backend admin for a new one.' }
    }
    if (/\(402\)|plan limit|payment required|insufficient_quota|budget/i.test(s)) {
      return { title: "You've hit your Kip plan limit.", hint: "You've used this period's included tokens or calls. Ask your backend admin to raise the budget." }
    }
    if (/\(429\)|rate.?limit|too many requests/i.test(s)) {
      return { title: 'The Kip backend is rate-limiting you.', hint: 'Wait a moment and try again — or ask for a higher rate limit.' }
    }
    if (/\(503\)|no_route|no route/i.test(s)) {
      return { title: 'The Kip backend has no route for this call.', hint: 'The backend admin needs a routing rule for this workload — send them the error details.' }
    }
    return null
  },

  // exported for tests
  _internals: { phaseOf, DEFAULT_BASE_URL }
}
