---
name: docx
description: Create a Word document (.docx) — built from a structured outline, or by filling a .docx template that lives in the coop.
when_to_use: >
  The user wants a Word document, a written report as a file, a formatted write-up, meeting
  notes as a .docx, or wants a .docx template in the coop filled in with values.
entry: run.js
network: false
timeout: 60
parameters:
  - { name: content, type: array, required: false, description: "Blocks, in order, for a from-scratch document. Each is one of: {\"heading\":\"...\",\"level\":1-4}, {\"text\":\"...\"} (\\n splits paragraphs), {\"bullets\":[\"...\",\"...\"]}, {\"table\":{\"headers\":[...],\"rows\":[[...],...]}}. Ignored when \"template\" is set." }
  - { name: title, type: string, required: false, description: "Document title — added as the first heading in content mode." }
  - { name: template, type: string, required: false, description: "Coop-relative path to a .docx whose text has {placeholder} and {#section}...{/section} tags (docxtemplater syntax)." }
  - { name: data, type: object, required: false, description: "Values for the template's tags. Required when \"template\" is set." }
  - { name: filename, type: string, required: false, description: "Output name, e.g. \"q3-report.docx\". Defaults to the title (or a timestamp). Always written under exports/." }
---
Two ways to call this:

**From an outline** — pass `content` (and optionally `title`):
`{ "title": "Q3 Review", "content": [ {"heading":"Summary","level":1}, {"text":"Revenue rose 12%."}, {"bullets":["EMEA beat target","APAC missed"]}, {"table":{"headers":["Region","Result"],"rows":[["EMEA","+8%"],["APAC","-3%"]]}} ] }`

**Filling a template** — pass `template` (a .docx path in the coop) and `data`:
`{ "template": "templates/memo.docx", "data": { "client": "Acme", "items": [ {"name":"Setup","hours":4} ] } }`

The file is written to `exports/` and the skill prints its path — pass that path
back to the user. It does not return the document's contents.
