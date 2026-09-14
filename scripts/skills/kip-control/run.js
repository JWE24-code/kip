// kip-control skill — lets Peck drive Kip's own maintenance workflows and LLM
// settings instead of answering a wiki question: coop status, Hatch (preview /
// launch / progress), Groom (quick inline / deep in the background / progress /
// report), rebuild-roost, and the settings page (read the provider+skills,
// switch provider/model/key, test the connection, toggle a skill).
//
// The skill holds no vault access (kip#78): it asks the parent for the
// operation over the `internal_action` hostcall, and the parent — which owns
// the vault — performs it. Reads SKILL_INPUT { operation, ... }.
//
// The `require` fallback is only for the legacy `scripts/lib/skills.js` CLI
// runner, which predates the sandbox and provides no `globalThis.kip`. Under
// the new executor the hostcall path is always taken.
const input = (() => {
  try { return JSON.parse(process.env.SKILL_INPUT || '{}') } catch { return {} }
})()

function viaHostcall () {
  return globalThis.kip.hostcall('internal_action', { action: 'kip-control', params: input })
}

async function viaLegacy () {
  const { runKipControlOperation } = require('../../lib/kip-control')
  return runKipControlOperation(input, { vaultRoot: process.env.KIP_COOP_ROOT || undefined })
}

;(async () => {
  try {
    const hasBridge = globalThis.kip && typeof globalThis.kip.hostcall === 'function'
    const out = hasBridge ? await viaHostcall() : await viaLegacy()
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2))
  } catch (err) {
    console.error(`kip-control: ${(err && err.message) || String(err)}`)
    process.exit(1)
  }
})()
