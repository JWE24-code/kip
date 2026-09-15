// The reminders skill's operation logic, in one trusted place (kip#78).
//
// A sandboxed skill has no vault access, so it asks for a reminder operation
// over the `internal_action` hostcall and this module — running in the parent
// — reads and writes <coop>/reminders.json via lib/reminders. The same code
// backs the skill's legacy CLI path.
const {
  addReminder, listReminders, cancelReminder, setReminderSound, describeReminder,
  fmtWhen, fmtLead, DEFAULT_LEAD_MIN
} = require('./reminders')
const { loadSkillsConfig } = require('./skills')
const { DEFAULT_VAULT_ROOT } = require('./paths')

function configuredLead (vaultRoot) {
  try {
    const n = Number(loadSkillsConfig(vaultRoot).config.reminders?.DEFAULT_LEAD_MIN)
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LEAD_MIN
  } catch { return DEFAULT_LEAD_MIN }
}

/**
 * Runs one reminders operation and returns the line(s) to relay to the model:
 * `create`, `list`, `cancel`, `mute`, `unmute`. A date the parser can't work
 * out is a normal outcome, returned as text (the model asks the user), not a
 * thrown error.
 */
function runReminderOperation (input = {}, { vaultRoot = DEFAULT_VAULT_ROOT } = {}) {
  const action = String(input.action || '').toLowerCase()

  try {
    if (action === 'create') {
      const text = String(input.text || input.title || '').trim()
      if (!text && !input.when) return 'reminders: nothing to schedule — tell me what the event is and when.'
      const row = addReminder(vaultRoot, {
        text,
        title: input.title,
        when: input.when,
        lead: input.lead,
        ...(typeof input.sound === 'boolean' ? { sound: input.sound } : {}),
        defaultLeadMin: configuredLead(vaultRoot),
        source: 'peck'
      })
      return describeReminder(row)
    }

    if (action === 'list') {
      const rows = listReminders(vaultRoot, { upcomingOnly: true }).filter((r) => r.status !== 'canceled')
      if (!rows.length) return 'No upcoming reminders.'
      const lines = ['Upcoming reminders:']
      for (const r of rows) {
        lines.push(`- #${r.id}  ${fmtWhen(r.eventAt)} — ${r.title}  (remind ${fmtLead(r.leadMin)} before` +
          `${r.sound === false ? ', silent' : ''}${r.status === 'notified' ? ', already notified' : ''})`)
      }
      return lines.join('\n')
    }

    if (action === 'cancel') {
      const row = cancelReminder(vaultRoot, input.id)
      return row ? `Canceled reminder #${row.id} — "${row.title}".` : `No reminder #${input.id} to cancel.`
    }

    if (action === 'mute' || action === 'unmute') {
      const row = setReminderSound(vaultRoot, input.id, action === 'unmute')
      return row
        ? `${action === 'mute' ? 'Muted' : 'Unmuted'} reminder #${row.id} — "${row.title}".`
        : `No reminder #${input.id}.`
    }

    return `reminders: unknown action "${action}". Use create, list, cancel, mute, or unmute.`
  } catch (err) {
    // A parse failure ("couldn't work out a date/time") is a normal outcome the
    // model should relay, not a crash.
    return `reminders: ${(err && err.message) || String(err)}`
  }
}

module.exports = { runReminderOperation }
