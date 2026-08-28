---
name: kip-control
description: Drive Kip's own maintenance workflows and LLM settings — coop status, Hatch, Groom, the settings page — from a Peck turn.
when_to_use: >
  The user asks Kip to do something to itself rather than answer a wiki question:
  "hatch the new sources", "run a groom", "what's pending", "which model am I on",
  "switch the provider to deepseek", "turn off the web-search skill", "rebuild the index",
  "how's the hatch going".
entry: run.js
network: true
timeout: 120
parameters:
  - { name: operation, type: string, required: true, enum: [status, hatch-preview, hatch, hatch-progress, groom, groom-deep, groom-progress, groom-report, rebuild-roost, settings, set-provider, test-connection, set-skill], description: "What to do." }
  - { name: limit, type: number, required: false, description: "operation=hatch: how many pending source files to process (default 10)." }
  - { name: provider, type: string, required: false, enum: [kip, anthropic, openai, deepseek, local, other], description: "operation=set-provider: which LLM provider to make active." }
  - { name: model, type: string, required: false, description: "operation=set-provider: model name for that provider (ignored for kip — its backend routes the model)." }
  - { name: baseUrl, type: string, required: false, description: "operation=set-provider: base URL for an OpenAI-compatible endpoint." }
  - { name: apiKey, type: string, required: false, description: "operation=set-provider: API key for that provider (stored in .henhouse/llm.json)." }
  - { name: skill, type: string, required: false, description: "operation=set-skill: the skill name to toggle." }
  - { name: enabled, type: boolean, required: false, description: "operation=set-skill: true to enable it, false to disable it." }
---
Start with `status` for a one-screen picture: provider/model, nest page counts,
pending sources, whether a Hatch or deep Groom is running, which skills are on,
recent activity.

- `hatch-preview` lists what a Hatch run would touch (no LLM calls). `hatch`
  launches a run in the background — then `hatch-progress` reports done/total.
- `groom` runs the quick structural pass inline and returns the findings.
  `groom-deep` launches the weekly LLM pass in the background — watch it with
  `groom-progress`, read the checklist with `groom-report`.
- `settings` shows the current provider/model/key state and every skill.
  `set-provider` writes .henhouse/llm.json and immediately runs a connection
  test; `test-connection` re-tests the saved config; `set-skill` flips a skill
  on or off for the next turn.
- `rebuild-roost` regenerates meta.db + index.md from the nest markdown.

Only launch `hatch` or `groom-deep` when the user clearly asked to start one —
they make many LLM calls. Relay the exact text this skill prints.
