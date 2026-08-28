---
name: pptx
description: Create a PowerPoint deck (.pptx) from a slide outline — optionally styled by a JSON theme or cloned from a .pptx template in the coop.
when_to_use: >
  The user wants a slide deck, a presentation, a .pptx, or slides built from an outline
  or a set of bullet points.
entry: run.js
network: false
timeout: 60
parameters:
  - { name: slides, type: array, required: true, description: "Slide specs, in order. Each is one of: {\"title\":\"...\",\"bullets\":[\"...\"]}, {\"title\":\"...\",\"text\":\"...\"}, {\"title\":\"...\",\"image\":\"<coop path to .png/.jpg>\"}, {\"section\":\"...\"} (a divider slide)." }
  - { name: title, type: string, required: false, description: "Deck title — adds a title slide at the front." }
  - { name: subtitle, type: string, required: false, description: "Subtitle for the title slide." }
  - { name: theme, type: string, required: false, description: "Coop-relative path to a JSON theme: {\"primary\":\"#1F4E79\",\"accent\":\"#ED7D31\",\"text\":\"#333333\",\"background\":\"#FFFFFF\",\"font\":\"Calibri\",\"logo\":\"<coop path>\",\"footer\":\"...\"}. All keys optional." }
  - { name: template, type: string, required: false, description: "Coop-relative path to a .pptx template; its first slide is cloned per outline slide and its title/body placeholders get your text (best-effort). Overrides theme." }
  - { name: filename, type: string, required: false, description: "Output name, e.g. \"kickoff.pptx\". Defaults to the title (or a timestamp). Always written under exports/." }
---
Pass `slides` — an array of slide specs. Simplest call:
`{ "title": "Kickoff", "slides": [ {"title":"Goals","bullets":["Ship v1","Cut latency"]}, {"section":"Timeline"}, {"title":"Q3","text":"Beta in August."} ] }`

Styling is optional:
- **`theme`** — a small JSON file of brand colours / font / logo / footer.
- **`template`** — a branded `.pptx` in the coop. Its first slide is cloned for
  each of your slides and the title/body placeholders are filled. This is a
  best-effort text swap; if the template has no text placeholders the deck is
  still produced with its branding intact.

The file lands in `exports/` and the skill prints its path — give that path to
the user. It does not return slide contents.
