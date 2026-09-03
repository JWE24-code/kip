---
name: web-search
description: Search the web for current, external information the wiki doesn't contain.
when_to_use: >
  The question needs facts from outside the personal wiki — something recent, a public
  fact, "the latest on X", a definition or figure not in the notes. Do NOT use it for
  anything the retrieved pages already answer.
entry: run.js
network: true
timeout: 25
cache_ttl: 60
parameters:
  - { name: query, type: string, required: true, description: "The search query." }
  - { name: count, type: number, required: false, description: "How many results to return (default 5, max 10)." }
---
Returns a short list of results as `- [title](url) — snippet`. Cite the URL(s)
you use in your answer.

The backend is set in Settings → Skills. It defaults to **DuckDuckGo**, which
needs no API key and works out of the box. Brave or Tavily can be selected there
instead (each needs its own key); if one is selected without a key this skill
says so and you should answer from the wiki alone.
