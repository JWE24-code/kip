// reminders skill — reads SKILL_INPUT {action, text?, title?, when?, lead?, id?}
// and creates / lists / cancels reminders in <coop>/reminders.json via
// scripts/lib/reminders.js. Pure JS. Kip's electron scheduler fires the actual
// notifications (scripts/reminders.js --due).

const {
  addReminder, listReminders, cancelReminder, setReminderSound, describeReminder,
  fmtWhen, fmtLead, DEFAULT_LEAD_MIN
} = require('../../lib/reminders')
const { loadSkillsConfig } = require('../../lib/skills')

const vaultRoot = process.env.KIP_COOP_ROOT || undefined

const input = (() => {
  try { return JSON.parse(process.env.SKILL_INPUT || '{}') } catch { return {} }
})()

const action = String(input.action || '').toLowerCase()

function configuredLead () {
  try {
    const n = Number(loadSkillsConfig(vaultRoot).config.reminders?.DEFAULT_LEAD_MIN)
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LEAD_MIN
  } catch { return DEFAULT_LEAD_MIN }
}

try {
  if (action === 'create') {
    const text = String(input.text || input.title || '').trim()
    if (!text && !input.when) {
      console.log('reminders: nothing to schedule — tell me what the event is and when.')
      process.exit(0)
    }
    const row = addReminder(vaultRoot, {
      text,
      title: input.title,
      when: input.when,
      lead: input.lead,
      ...(typeof input.sound === 'boolean' ? { sound: input.sound } : {}),
      defaultLeadMin: configuredLead(),
      source: 'peck'
    })
    console.log(describeReminder(row))
  } else if (action === 'list') {
    const rows = listReminders(vaultRoot, { upcomingOnly: true }).filter((r) => r.status !== 'canceled')
    if (!rows.length) {
      console.log('No upcoming reminders.')
    } else {
      console.log('Upcoming reminders:')
      for (const r of rows) {
        console.log(`- #${r.id}  ${fmtWhen(r.eventAt)} — ${r.title}  (remind ${fmtLead(r.leadMin)} before` +
          `${r.sound === false ? ', silent' : ''}${r.status === 'notified' ? ', already notified' : ''})`)
      }
    }
  } else if (action === 'cancel') {
    const row = cancelReminder(vaultRoot, input.id)
    console.log(row ? `Canceled reminder #${row.id} — "${row.title}".` : `No reminder #${input.id} to cancel.`)
  } else if (action === 'mute' || action === 'unmute') {
    const row = setReminderSound(vaultRoot, input.id, action === 'unmute')
    console.log(row
      ? `${action === 'mute' ? 'Muted' : 'Unmuted'} reminder #${row.id} — "${row.title}".`
      : `No reminder #${input.id}.`)
  } else {
    console.log(`reminders: unknown action "${action}". Use create, list, cancel, mute, or unmute.`)
    process.exit(0)
  }
} catch (err) {
  // A parse failure ("couldn't work out a date/time") is a normal outcome the
  // model should relay, not a crash — print it and exit 0.
  console.log(`reminders: ${err.message}`)
  process.exit(0)
}
