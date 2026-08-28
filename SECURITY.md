# Security Policy

**Do not open a public issue for security problems.**

Report privately through GitHub's private vulnerability reporting:

> **https://github.com/JWE24-code/kip/security/advisories/new**

## Scope / known non-issues

Kip is pre-1.0, maintained by one person — only the latest release is
supported.

- `<graph>/.henhouse/llm.json` holds LLM API keys in plaintext on your own
  machine, by design. Keep `.henhouse/` out of version control and shared
  folders.
- Skills (`scripts/skills/`, `<graph>/.henhouse/skills/`) are arbitrary Node
  scripts run with your privileges — no sandbox. Built-ins are reviewed here;
  a user-added skill is like running a shell script.
- `web-search` (built-in, on by default) makes outbound HTTP requests when Peck
  needs external facts. Turn it off in Settings → Skills.
- Your notes and questions go to whichever LLM provider you configure; use
  `local` (Ollama) to keep everything on-device.
