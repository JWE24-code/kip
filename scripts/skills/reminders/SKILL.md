---
name: reminders
description: Set, list, or cancel time-based reminders for meetings, calls, appointments, deadlines, and tasks.
when_to_use: >
  The user mentions an upcoming event with a time they want reminding about — "I have a
  meeting with Acme on Friday at 15h", "remind me to email Bob tomorrow", "don't let me
  forget the review on the 20th", "dentist next Tuesday 9am, remind me a day before".
  Also "what reminders do I have" / "what's coming up", "cancel the … reminder", and
  "mute / silence the … reminder" (or "no sound"). NOT for past events or general facts.
entry: run.js
network: false
timeout: 30
parameters:
  - { name: action, type: string, required: true, enum: [create, list, cancel, mute, unmute], description: "What to do." }
  - { name: text, type: string, required: false, description: "action=create: the whole request in the user's words ('meeting with Acme friday at 15h, remind me a day before'). Preferred — the skill parses the date, title, lead time, and whether it should be silent." }
  - { name: title, type: string, required: false, description: "action=create: an explicit event title, if 'text' is ambiguous." }
  - { name: when, type: string, required: false, description: "action=create: an explicit time phrase ('next Friday 15:00', '2026-09-20 10am') if you can state it more clearly than the raw text." }
  - { name: lead, type: string, required: false, description: "action=create: how far ahead to remind — minutes as a number, or '1h' / '1d' / '30m'. Default 60 minutes (or the user's configured default)." }
  - { name: sound, type: boolean, required: false, description: "action=create: whether the reminder dings when it fires. Defaults to true; set false when the user asks for a silent / muted reminder." }
  - { name: id, type: number, required: false, description: "action=cancel / mute / unmute: which reminder (from a list)." }
---
`create` stores a reminder and replies with a one-line confirmation — relay it
verbatim; do not restate the time yourself. Kip fires the notification ahead of
the event (with prep pulled from the nest) — you don't need to do anything else.

`list` returns upcoming reminders. `cancel` / `mute` / `unmute` need an `id`
from a prior list. A muted reminder still fires and still shows its prep — it
just doesn't make a sound.

If the date can't be worked out the skill says so — ask the user for a clearer
date rather than guessing.
