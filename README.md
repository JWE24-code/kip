# Kip

**Kip** (Dutch for chicken) is a pecking-first knowledge base: a fork of
[Logseq](https://github.com/logseq/logseq) with an LLM retrieval layer.

It has a coherent farm metaphor — source documents are **eggs**, the
LLM-maintained wiki is the **nest**, the activity log is **clucks**, the index
cache is the **roost**, and the config folder is the **henhouse**. The verbs:

- **Hatch** — turn an egg into linked `entity` / `concept` / `source` pages
- **Peck** — ask the nest a question (cited with `[[links]]`), tell it a fact,
  or set a reminder. A bounded skill loop can run mid-answer (web search,
  spreadsheets, Word/PowerPoint).
- **Groom** — read-only health checks over the nest
- **Reminders** — natural-language, with a meeting-prep brief from your notes

This repo is the **retrieval layer** (`scripts/`, Node). The desktop app that
bundles it — the Logseq fork — is at
**[JWE24-code/kip-app](https://github.com/JWE24-code/kip-app)**; grab a build
from its [Releases](https://github.com/JWE24-code/kip-app/releases). More at the
**[kip website](https://www.kip-ai.be/)**.

> Early and rough. Built to gather feedback.

## Try it

You almost certainly want the **[desktop app](https://github.com/JWE24-code/kip-app)**
— see its README for install, and **[docs/GETTING-STARTED.md](docs/GETTING-STARTED.md)**
for a first-run walkthrough.

The retrieval layer also runs standalone from the CLI (Node 20+):

```bash
npm install
cp .env.example .env          # set PROVIDER + an API key (or PROVIDER=local)

node scripts/hatch.js path/to/notes.md          # ingest one file (with review)
node scripts/peck.js  "what do I know about X?"  # ask
node scripts/peck.js  "the CDO of Acme is Jane Doe"   # tell it a fact
node scripts/reminders.js add "review friday 15h"     # a reminder
node scripts/groom.js --json                      # health check
npm test
```

It operates on `./coop/` by default, or the folder in `KIP_COOP_ROOT`.

## Docs

| | |
|---|---|
| [GETTING-STARTED.md](docs/GETTING-STARTED.md) | first-run walkthrough (app) |
| [FEATURES.md](docs/FEATURES.md) | everything Kip adds on top of Logseq |
| [DESIGN.md](docs/DESIGN.md) | how Hatch / Peck / Groom / the app shell fit together |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | build & dev-environment notes |
| [BUILD.md](docs/BUILD.md) | packaging the app |
| [VS-LOGSEQ.md](docs/VS-LOGSEQ.md) | what changed vs upstream Logseq |

Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md). Changes:
[CHANGELOG.md](CHANGELOG.md). Vulnerabilities: [SECURITY.md](SECURITY.md).

## License

Copyright © 2026 Joeri Weitmann.

This retrieval layer (`scripts/`) is licensed under the **Apache License,
Version 2.0** — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). The Kip
desktop app is a fork of Logseq
([`logseq/og`](https://github.com/logseq/og) — the file-based, markdown-first
line, not the newer `logseq/logseq` rewrite), AGPL-3.0, versioned separately at
[JWE24-code/kip-app](https://github.com/JWE24-code/kip-app). **Kip is not
affiliated with or endorsed by Logseq.** The wiki content under `coop/` is
personal data and not part of this repo.
