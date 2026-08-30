// The one gate every preference-signal surface checks (epic kip-app#73).
//
// Preference signals — implicit behaviour, micro-ratings, blind arena — feed
// three content-free numbers back to the managed Kip backend so its router
// can tune perceived-quality-per-price. They are ENTIRELY INERT unless the
// active LLM provider is the managed `kip` connector: a direct
// Anthropic/OpenAI/DeepSeek/local provider has no managed router to inform
// and no X-Kip-Call-Id to reference, so nothing collects, marks, or posts.
//
// The renderer has its own thin cljs shim over an IPC call into this module;
// the retrieval-layer scripts call these directly.

const { getProviderConfig } = require('./llm')

const KIP_PROVIDER_ID = 'kip'
const DEFAULT_BASE_URL = 'https://api.kip-ai.be'

/**
 * True only when the active provider is the managed Kip connector, resolved
 * exactly as describeProvider() / the settings UI resolve it (llm.json's
 * `provider`, else $PROVIDER, else "anthropic"). Never throws — a broken or
 * absent config is simply "not enabled".
 */
function preferenceSignalsEnabled (vaultRoot) {
  try {
    return getProviderConfig(vaultRoot).provider === KIP_PROVIDER_ID
  } catch {
    return false
  }
}

/**
 * The managed backend's resolved base URL + bearer key, for the feedback and
 * arena POSTs to reuse rather than re-resolving — or null when preference
 * signals aren't enabled (wrong provider, or no key). Callers treat null as
 * "do nothing".
 */
function preferenceSignalsTarget (vaultRoot) {
  try {
    const cfg = getProviderConfig(vaultRoot)
    if (cfg.provider !== KIP_PROVIDER_ID || !cfg.apiKey) return null
    return {
      baseUrl: (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
      apiKey: cfg.apiKey
    }
  } catch {
    return null
  }
}

module.exports = { KIP_PROVIDER_ID, preferenceSignalsEnabled, preferenceSignalsTarget }
