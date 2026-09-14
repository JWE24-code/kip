// reminders skill — reads SKILL_INPUT {action, text?, title?, when?, lead?, id?}
// and creates / lists / cancels reminders in <coop>/reminders.json.
//
// A sandboxed skill holds no vault access (kip#78): it asks the parent for the
// operation over the `internal_action` hostcall, and the parent reads/writes
// reminders.json via lib/reminders. Kip's electron scheduler fires the actual
// notifications (scripts/reminders.js --due).
//
// The `require` fallback is only for the legacy `scripts/lib/skills.js` CLI
// runner, which predates the sandbox and provides no `globalThis.kip`.
const input = (() => {
  try { return JSON.parse(process.env.SKILL_INPUT || '{}') } catch { return {} }
})()

function viaHostcall () {
  return globalThis.kip.hostcall('internal_action', { action: 'reminders', params: input })
}

function viaLegacy () {
  const { runReminderOperation } = require('../../lib/reminder-actions')
  return runReminderOperation(input, { vaultRoot: process.env.KIP_COOP_ROOT || undefined })
}

;(async () => {
  try {
    const hasBridge = globalThis.kip && typeof globalThis.kip.hostcall === 'function'
    const out = hasBridge ? await viaHostcall() : viaLegacy()
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2))
  } catch (err) {
    console.error(`reminders: ${(err && err.message) || String(err)}`)
    process.exit(1)
  }
})()
