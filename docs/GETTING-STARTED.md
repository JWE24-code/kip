# Getting started with Kip

Kip is a personal knowledge base that reads your documents and turns them into a cross-linked wiki. You drop raw files into your **coop**; Kip **hatches** them into wiki pages under **The Nest**, where you can then **peck** around with questions and **groom** the result.

This guide assumes you have Kip running (from a [release](https://github.com/JWE24-code/kip-app/releases) or a dev build) and want to use it for the first time. For build instructions, see [`BUILD.md`](BUILD.md).

Kip is **pecking-first**: it opens straight into the Peck prompt. The Logseq editor (journals, pages, whiteboards) is a mode you switch to with **`Ctrl/⌘+1`** or the **`[ Peck | Documents ]`** toggle at the top of the window.

---

## 1. Open or create a coop

A **coop** is just a folder on your computer. Everything Kip creates lives inside it.

1. Launch Kip.
2. At the startup screen, click **"Open a local directory"** (or **"Open a graph"**).
3. Pick any empty or existing folder. That folder becomes your coop.

Kip will create these subfolders inside it automatically as you use it:

```
my-coop/
├── eggs/        # source documents you drop in
├── nest/        # the LLM-maintained wiki
├── clucks/      # monthly activity log
├── .roost/      # search index and run artifacts
├── .henhouse/   # LLM config and skills
└── logseq/      # Logseq's own settings (kept as-is)
```

You can have more than one coop. Each one is a separate knowledge base.

---

## 2. Set up your LLM provider

Kip needs an LLM to hatch sources and answer questions.

1. In Kip, open the **"..." menu** → **Settings** → **LLM**.
2. Choose a provider:
   - **Anthropic** (default) — uses your Anthropic API key.
   - **OpenAI** — any OpenAI-compatible endpoint.
   - **DeepSeek** — DeepSeek's chat API.
   - **Local** — a model running on your machine via Ollama.
3. Enter your API key, model name, and base URL if needed.
4. Click **Test connection** to verify.
5. Click **Save**.

The settings are written to `<coop>/.henhouse/llm.json`. That file is **plain text** and contains your key, so keep your coop folder private.

> **Privacy note:** Hosted providers (Anthropic, OpenAI, DeepSeek) receive the contents of your sources and questions. Choose **Local** if you want everything to stay on your machine.

---

## 3. Drop your first source into `eggs/`

**Eggs** are raw source documents: meeting notes, article exports, journal dumps, health data, anything you want synthesized.

1. Outside Kip, copy or move a file into `<coop>/eggs/`.
2. Kip prefers plain Markdown (`.md`), but will also accept text files.
3. Treat eggs as **read-only** once they are in the folder. Kip copies them there if you hatch from elsewhere; if you drop them yourself, don't edit them afterward.

Example:

```
my-coop/eggs/2026-08-team-retro.md
```

---

## 4. Hatch it into The Nest

**Hatching** turns a source into wiki pages.

### From the app (batch, no review)

1. Click the **"..." menu** → **Hatch sources**.
2. The modal shows a preview: pending files, total size, and any skipped files.
3. Click **Start**. Kip processes files in batches of 10.
4. Watch the activity feed. When it finishes, check **The Nest** for new pages.

### From the command line (one file, with review)

```powershell
npm run hatch my-coop/eggs/2026-08-team-retro.md
```

Kip will show you a plan, ask for confirmation, then write the pages.

### What hatching creates

For a typical source, Kip creates:

- one page in `nest/sources/` summarizing the source itself
- one page in `nest/entities/` for each person, place, or recurring thing mentioned
- one page in `nest/concepts/` for each theme or topic worth tracking

Every page is a plain Markdown file with YAML frontmatter. You can open and edit it like any other note.

---

## 5. Peck — ask, tell, or remind

Kip opens straight into Peck — the prompt in the middle of the window. (You can
also pop it into the right sidebar alongside a document via the **"..." menu →
Peck**; it's the same conversation.)

### Ask a question

Type a question and press Enter, for example:

- `what did we decide about the migration timeline?`
- `who is working on the onboarding flow?`

Kip searches The Nest, reads the matching pages, and returns an answer. Each
claim is cited with a `[[slug]]` link — click it to open the source page (which
switches you to Documents mode).

### Tell Kip a fact

Feed it a short statement instead of a question:

```
the CDO of Acme is Jane Doe
```

Kip detects this as a statement, finds the right page (or creates one), and
appends the fact under a dated `_Update_` section. A **"✓ Learned"** note
appears.

### Set a reminder

Mention something coming up:

```
I have a meeting with Acme on Friday at 15h, remind me a day before
```

Kip stores it (in `<coop>/reminders.json`) and, while it's running, fires an OS
notification ahead of the event — with a short prep brief pulled from your
nest. The **Reminders** panel ("..." menu) lists upcoming ones; each has a
🔔 toggle if you want it silent. It also works from the CLI:
`node scripts/reminders.js list`.

---

## 6. Check the activity log (clucks)

Every hatch, peck, and told-fact is recorded in `clucks/YYYY-MM.md`. You can read it as a normal Markdown file, or:

- open **Coop status** from the **"..." menu** to see recent clucks inside the app
- run `npm run recent-clucks` from the project root

---

## 7. Groom the nest

Over time, pages accumulate `_Update_` sections and possible duplicates. **Groom** is a read-only health check.

### Quick groom

1. Open **Coop status** from the **"..." menu**.
2. Click **Run groom**. This takes a few seconds and checks for orphans, drift, near-duplicate pages, and light contradictions.

### Deep groom (weekly)

1. In the same **Coop status** modal, click **Deep groom (weekly)**.
2. This runs many LLM checks and may take several minutes.
3. When it finishes, click **Open report** to read `.roost/groom-report.md`, a dated checklist of suggestions to work through.

Groom **never edits pages automatically**. It only reports problems for you to fix.

---

## 8. Rebuild the index if something looks wrong

The search index lives in `<coop>/.roost/meta.db`. It is fully derived from the Markdown files in `nest/`. If you hand-edit a page, move files, or suspect the index is out of sync, run:

```powershell
npm run rebuild-roost
```

This is safe to run at any time.

---

## 9. Where things live — quick reference

| What | Where | Edited by |
|---|---|---|
| Your source documents | `eggs/` | you, read-only to Kip |
| Your daily notes / pages | `journals/`, `pages/` | you, via the app |
| The LLM wiki | `nest/` | Kip (you can hand-edit) |
| Activity log | `clucks/` | Kip only |
| Search index | `.roost/meta.db` | rebuilt from `nest/` |
| LLM config | `.henhouse/llm.json` | you, via Settings |
| Generated catalog | `nest/index.md` | rebuilt automatically |

---

## Common first mistakes

- **Editing `nest/index.md` by hand.** It is regenerated by `rebuild-roost`. Your changes will be overwritten.
- **Editing files in `eggs/` after hatching.** Eggs are meant to be immutable. If a source changes, drop the new version in with a new filename and hatch again.
- **Forgetting the LLM provider.** Without a provider configured, Hatch and Peck will fail or fall back to outline-only mode for whiteboards.
- **Expecting Groom to fix things.** Groom reports only; you decide what to change.
- **Putting huge files in `eggs/`.** Files over ~1 MB are skipped. Split or summarize them first.

---

## Next steps

- Read [`DESIGN.md`](DESIGN.md) to understand how Hatch, Peck, and Groom fit together.
- Read [`FEATURES.md`](FEATURES.md) for the complete feature list.
- Try drawing a mindmap on a whiteboard and hatching it — it becomes a searchable outline page under The Nest.
- Found a bug or have an idea? [Open an issue](https://github.com/JWE24-code/kip-app/issues) or start a [discussion](https://github.com/JWE24-code/kip-app/discussions).
