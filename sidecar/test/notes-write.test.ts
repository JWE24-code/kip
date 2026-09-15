// Acceptance tests for the P4 write path (#73). Every behavior here mirrors
// what `scripts/test/peck.test.js` treats as the spec for filed answers:
// create-vs-update resolution, the dated-append update (never a raw
// overwrite), the `## Sources` footer, and the summary-in-frontmatter mirror.
// On top of that, P4 adds two contracts of its own: exactly one commit per
// user-visible write, and no tool that can name a `pages/` (vault) path.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LlmStreamEvent, LlmStreamRequest, Tool } from '../session/loop.ts'
import { ASK_USER_SPEC, TurnLoop } from '../session/loop.ts'
import {
  SEARCH_NOTES_TOOL_NAME,
  createNoteTools
} from '../session/notes.ts'
import {
  WRITE_AGENT_NOTE_TOOL_NAME,
  UPDATE_AGENT_NOTE_TOOL_NAME,
  createWriteTools,
  updateAgentNote,
  updateNoteSchema,
  writeAgentNote,
  writeNoteSchema
} from '../session/notes-write.ts'
import { history, workspacePaths } from '../workspace/git.ts'

const require = createRequire(import.meta.url)
const { rebuildRoost } = require('../../scripts/rebuild-roost.js') as {
  rebuildRoost: (vaultRoot: string) => { indexed: number }
}
const paths = require('../../scripts/lib/paths.js') as {
  nestGitPath: (vaultRoot: string) => string
  nestPath: (vaultRoot: string) => string
}
const matter = require('gray-matter') as {
  (raw: string): { data: Record<string, unknown>, content: string }
}

function makeTempVault (): string {
  const root = mkdtempSync(join(tmpdir(), 'coop-write-test-'))
  for (const dir of ['nest/entities', 'nest/concepts', 'nest/sources', 'pages', 'journals', '.roost', '.henhouse']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  return root
}

function readPage (root: string, slug: string): { data: Record<string, unknown>, content: string } {
  const dirs = ['concepts', 'entities', 'sources', 'people']
  for (const dir of dirs) {
    const file = join(root, 'nest', dir, `${slug}.md`)
    try {
      return matter(readFileSync(file, 'utf8'))
    } catch {
      // try the next directory
    }
  }
  throw new Error(`no page ${slug}`)
}

function nestFiles (root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(full)
    }
  }
  walk(join(root, 'nest'))
  return out
}

async function commitCount (root: string): Promise<number> {
  return (await history(workspacePaths(root))).length
}

test('write_agent_note creates a valid Logseq page and produces exactly one commit', async (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const result = await writeAgentNote(
    { title: 'Sleep hygiene', body: 'Consistent bedtime; no screens after 22:00.', tags: ['sleep'] },
    root
  )
  assert.equal(result.action, 'create')
  assert.equal(result.slug, 'sleep-hygiene')
  assert.equal(result.path, 'nest/concepts/sleep-hygiene.md')
  assert.ok(result.committed, 'the write committed')
  assert.equal(await commitCount(root), 1, 'exactly one commit')

  const { data, content } = readPage(root, 'sleep-hygiene')
  assert.equal(data.type, 'concept')
  assert.deepEqual(data.tags, ['sleep'])
  assert.match(String(data.updated), /^\d{4}-\d{2}-\d{2}$/)
  assert.match(content, /Consistent bedtime/)

  // a second, unrelated note is a second commit — not folded into the first
  await writeAgentNote({ title: 'Dr Alvarez', body: 'No screens before bed.', type: 'entity' }, root)
  assert.equal(await commitCount(root), 2, 'one commit per write')

  const { dir, gitdir } = workspacePaths(root)
  assert.equal(dir, paths.nestPath(root), 'the worktree is the coop nest')
  assert.equal(gitdir, paths.nestGitPath(root), 'the git dir resolves under the workspace')
  assert.ok(!gitdir.startsWith(root + require('node:path').sep), 'the git dir never sits inside the coop (kip#67)')
})

test('a near-duplicate title updates the existing page instead of creating a second (AD-10)', async (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const first = await writeAgentNote({ title: 'sleep quality', body: 'Deeper sleep.' }, root)
  assert.equal(first.slug, 'sleep-quality')

  const second = await writeAgentNote({ title: 'sleep quality', body: 'Also: no caffeine after noon.' }, root)
  assert.equal(second.action, 'update', 'the near-duplicate updated')
  assert.equal(second.slug, first.slug, 'old filed answers still resolve to the same slug')
  assert.equal(await commitCount(root), 2, 'the update is one new commit')
  assert.equal(
    nestFiles(root).filter((f) => f.endsWith('sleep-quality.md')).length,
    1,
    'no duplicate page was created'
  )

  const { content } = readPage(root, 'sleep-quality')
  assert.match(content, /Deeper sleep\./)
  assert.match(content, /_Update \d{4}-\d{2}-\d{2}:_/)
  assert.match(content, /Also: no caffeine after noon\./, 'the update appended rather than overwrote')
})

test('update_agent_note appends under a dated section and keeps the old body byte-for-byte', async (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  await writeAgentNote({ title: 'Atlas deadline', body: 'The Atlas deadline is 2026-11-01.', summary: 'Atlas ships 2026-11-01' }, root)
  const before = readPage(root, 'atlas-deadline').content

  const updated = await updateAgentNote({ id: 'aw:atlas-deadline', body: 'Moved to 2026-12-01.' }, root)
  assert.equal(updated.action, 'update')
  assert.equal(updated.slug, 'atlas-deadline')
  assert.equal(await commitCount(root), 2, 'the update is one new commit')

  const { data, content } = readPage(root, 'atlas-deadline')
  assert.ok(content.startsWith(before.trimEnd()), 'the original content is preserved')
  assert.match(content, /---\n_Update \d{4}-\d{2}-\d{2}:_\n\nMoved to 2026-12-01\./)
  assert.equal(data.summary, 'Atlas ships 2026-11-01', 'an omitted summary keeps the existing one (kip-app#115)')

  // a bare slug (no aw: prefix) resolves the same page
  const again = await updateAgentNote({ id: 'atlas-deadline', body: 'Confirmed.' }, root)
  assert.equal(again.slug, 'atlas-deadline')
})

test('an update mirrors the summary into frontmatter so a rebuild keeps it (kip-app#115)', async (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  await writeAgentNote({ title: 'Rebuild check', body: 'A long body that should not become the summary.' }, root)
  rebuildRoost(root)
  const { getPage } = require('../../scripts/lib/roost.js') as {
    getPage: (slug: string, vaultRoot: string) => { summary: string } | null
  }
  const summary = getPage('rebuild-check', root)?.summary ?? ''
  assert.match(summary, /A long body that should not become the summary/, 'the derived summary is mirrored and read back')

  const { data } = readPage(root, 'rebuild-check')
  assert.equal(data.summary, summary, 'frontmatter and the index agree')
})

test('retrieved-but-uncited pages are appended as a ## Sources footer (kip-app#117)', async (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  await writeAgentNote({
    title: 'Sleep answer',
    body: 'Per [[sleep-hygiene]] and [[dr-alvarez]].',
    sources: ['sleep-hygiene', 'dr-alvarez', 'never-mentioned']
  }, root)

  const { content } = readPage(root, 'sleep-answer')
  assert.match(content, /## Sources/)
  assert.match(content, /Also retrieved, not cited: \[\[never-mentioned\]\]/)
  assert.doesNotMatch(content, /not cited:.*\[\[sleep-hygiene\]\]/, 'an inline-cited page is not listed as uncited')
})

test('write_agent_note and update_agent_note run as real tools in the TurnLoop and each commit once', async (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  type Step = (request: LlmStreamRequest) => AsyncIterable<LlmStreamEvent>
  class ScriptedLlm {
    steps: Step[]
    requests: LlmStreamRequest[] = []
    constructor (steps: Step[]) { this.steps = steps }
    async *stream (request: LlmStreamRequest): AsyncIterable<LlmStreamEvent> {
      this.requests.push(request)
      const step = this.steps.shift()
      if (!step) { yield { type: 'done' }; return }
      yield* step(request)
    }
  }

  const seen: string[] = []
  const llm = new ScriptedLlm([
    async function * () {
      yield { type: 'tool-call', call: { id: 'c1', name: WRITE_AGENT_NOTE_TOOL_NAME, arguments: { title: 'From the loop', body: 'Written by the model.' } } }
    },
    async function * () {
      yield { type: 'tool-call', call: { id: 'c2', name: UPDATE_AGENT_NOTE_TOOL_NAME, arguments: { id: 'aw:from-the-loop', body: 'Appended by the model.' } } }
    },
    async function * (request) {
      for (const message of request.messages) if (message.role === 'tool') seen.push(message.content)
      yield { type: 'text', text: 'done' }
    }
  ])

  const tools: Tool[] = [...createNoteTools({ vaultRoot: root }), ...createWriteTools({ vaultRoot: root })]
  const loop = new TurnLoop({ llm, tools, emit: () => {} })
  const result = await loop.start('sess-1', 'remember this')

  assert.equal(result.reason, 'completed')
  assert.equal(await commitCount(root), 2, 'two tool calls -> two commits')
  const { content } = readPage(root, 'from-the-loop')
  assert.match(content, /Written by the model\./)
  assert.match(content, /Appended by the model\./)
  assert.match(seen.join('\n'), /aw:from-the-loop/)
})

test('no tool schema accepts a pages/-rooted path (SPEC-1 Acceptance D)', () => {
  const specs = [
    ...createNoteTools({ vaultRoot: '/tmp/unused' }).map((tool) => tool.spec),
    ...createWriteTools({ vaultRoot: '/tmp/unused' }).map((tool) => tool.spec),
    ASK_USER_SPEC
  ]
  const named = new Map<string, string[]>()
  for (const spec of specs) named.set(spec.name, Object.keys(spec.parameters?.properties ?? {}))

  const pathLike = /^(path|file|filepath|dir|directory|root|vault|targetfile)$/i
  for (const [name, properties] of named) {
    assert.ok(properties.length > 0, `${name} declares parameters`)
    for (const property of properties) {
      assert.doesNotMatch(property, pathLike, `${name} must not expose a path-shaped parameter "${property}"`)
    }
  }

  // The schemas are strict: smuggling a `path` is a validation error, not a
  // silently ignored key.
  assert.throws(() => writeNoteSchema.parse({ title: 'x', body: 'y', path: 'pages/leak.md' }))
  assert.throws(() => updateNoteSchema.parse({ id: 'aw:x', body: 'y', path: 'pages/leak.md' }))
})

test('a pages/-rooted update target is refused and never touches the vault', async (t) => {
  const root = makeTempVault()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'pages', 'private-note.md'), 'PRIVATE USER NOTE')

  await assert.rejects(
    updateAgentNote({ id: 'kb:private-note', body: 'leak' }, root),
    /agent workspace/,
    'a kb: id is refused'
  )
  assert.equal(readFileSync(join(root, 'pages', 'private-note.md'), 'utf8'), 'PRIVATE USER NOTE', 'the vault is untouched')
})

test('the nest history works with no system git on PATH (#73 acceptance)', async (t) => {
  const root = makeTempVault()
  const originalPath = process.env.PATH
  t.after(() => {
    process.env.PATH = originalPath
    rmSync(root, { recursive: true, force: true })
  })

  process.env.PATH = ''
  await writeAgentNote({ title: 'No git binary', body: 'isomorphic-git only.' }, root)
  await updateAgentNote({ id: 'aw:no-git-binary', body: 'Still no git.' }, root)

  assert.equal(await commitCount(root), 2, 'commits worked with no git on PATH')
  assert.match(readPage(root, 'no-git-binary').content, /Still no git\./)
})
