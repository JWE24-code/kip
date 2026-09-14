// The nest's git workspace (P4, kip#73): a commit-per-action repo wrapping
// the markdown the agent writes, using isomorphic-git rather than the system
// `git` binary.
//
// Why isomorphic-git: Kip is a zero-configuration desktop app for a
// non-technical audience on Windows and Linux (ADD-1 G3). Requiring a system
// `git`, or bundling a platform-specific binary, is friction the product
// shouldn't add; isomorphic-git is pure JS and ships in the app bundle like any
// other npm package, so the history works on a machine with no `git` installed.
//
// Where the repo lives (kip#67): the working tree is the coop's `nest/` (the
// markdown syncs with the user's graph like any other page), but the git
// metadata directory lives under the per-coop workspace *outside* the coop, so
// a sync engine never writes into `.git/` mid-commit. Every call therefore
// threads both `dir` (worktree) and `gitdir` through isomorphic-git.

import { createRequire } from 'node:module'
import { mkdir, rm } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import git from 'isomorphic-git'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const paths = require('../../scripts/lib/paths.js') as {
  nestPath: (vaultRoot: string) => string
  nestGitPath: (vaultRoot: string) => string
}

/** Commits are authored by the app, never the user's global git identity — the
 *  user's git config is not read (and may not exist). */
export const WORKSPACE_AUTHOR = { name: 'Kip', email: 'kip@kip-ai.be' } as const

export interface WorkspacePaths {
  /** The repo's working tree: <coop>/nest. */
  dir: string
  /** The repo's metadata directory, under the non-synced workspace root. */
  gitdir: string
}

export interface CommitResult {
  /** False when there was nothing to stage (never an empty commit). */
  committed: boolean
  /** The new commit sha, or the current HEAD when nothing changed. */
  sha: string | null
  /** Worktree-relative paths that made up the commit. */
  files: string[]
}

export interface CommitOptions {
  vaultRoot: string
  message: string
  dir?: string
  gitdir?: string
  author?: { name: string, email: string }
}

/** True when `child` is inside `parent` (or is `parent` itself). */
function isInside (parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`))
}

/**
 * Resolves the worktree/gitdir pair for a coop. The gitdir is asserted to live
 * outside the coop — a `.git/` inside a synced folder is the corruption risk
 * kip#67 exists to close, so it is a hard error rather than a convention.
 */
export function workspacePaths (vaultRoot: string): WorkspacePaths {
  const dir = paths.nestPath(vaultRoot)
  const gitdir = paths.nestGitPath(vaultRoot)
  if (isInside(vaultRoot, gitdir)) {
    throw new Error(`Refusing to keep the nest git dir inside the coop: ${gitdir}`)
  }
  return { dir, gitdir }
}

async function headSha (dir: string, gitdir: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs, dir, gitdir, ref: 'HEAD' })
  } catch {
    return null
  }
}

/** True when a repo with a resolvable HEAD already exists at this pair. */
export async function isRepo ({ dir, gitdir }: WorkspacePaths): Promise<boolean> {
  return (await headSha(dir, gitdir)) !== null
}

/**
 * Idempotently initializes the nest repo: creates the worktree and gitdir,
 * `init`s when there is no HEAD yet. Safe to call before every action.
 */
export async function ensureRepo ({ dir, gitdir }: WorkspacePaths): Promise<void> {
  await mkdir(dir, { recursive: true })
  await mkdir(gitdir, { recursive: true })
  if (await isRepo({ dir, gitdir })) return
  await git.init({ fs, dir, gitdir, defaultBranch: 'main' })
}

/** Files whose worktree/index state differs from HEAD. */
async function changedFiles (dir: string, gitdir: string): Promise<string[]> {
  const matrix = await git.statusMatrix({ fs, dir, gitdir })
  return matrix
    .filter(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1))
    .map(([filepath]) => filepath)
}

/**
 * Stages every worktree change and makes exactly one commit. Returns
 * `{ committed: false }` (no empty commit) when nothing changed. This is the
 * single write point for the workspace: a tool that writes a page calls it
 * once, so one user-visible action is always one commit.
 */
export async function commitAction (options: CommitOptions): Promise<CommitResult> {
  const { dir, gitdir } = options.dir && options.gitdir
    ? { dir: options.dir, gitdir: options.gitdir }
    : workspacePaths(options.vaultRoot)

  await ensureRepo({ dir, gitdir })

  const changed = await changedFiles(dir, gitdir)
  if (!changed.length) {
    return { committed: false, sha: await headSha(dir, gitdir), files: [] }
  }

  for (const filepath of changed) {
    const present = fs.existsSync(resolve(dir, filepath))
    if (present) await git.add({ fs, dir, gitdir, filepath })
    else await git.remove({ fs, dir, gitdir, filepath })
  }

  const sha = await git.commit({
    fs,
    dir,
    gitdir,
    message: options.message,
    author: options.author ?? WORKSPACE_AUTHOR
  })
  return { committed: true, sha, files: changed }
}

export interface HistoryEntry {
  sha: string
  message: string
  author: string
  timestamp: number
}

/** The commit history, newest first (consumed by the undo path, kip#74). */
export async function history (
  { dir, gitdir }: WorkspacePaths,
  { depth }: { depth?: number } = {}
): Promise<HistoryEntry[]> {
  if (!(await isRepo({ dir, gitdir }))) return []
  const entries = await git.log({ fs, dir, gitdir, ...(depth ? { depth } : {}) })
  return entries.map((entry) => ({
    sha: entry.oid,
    message: entry.commit.message.trim(),
    author: `${entry.commit.author.name} <${entry.commit.author.email}>`,
    timestamp: entry.commit.author.timestamp * 1000
  }))
}

// ---- Undo (kip#74) ---------------------------------------------------------

/** Thrown when an undo cannot proceed. `code` is the wire error the sidecar
 *  reports, matching SPEC-1's explicit UNDO_UNAVAILABLE rule. */
export class UndoUnavailableError extends Error {
  code = 'UNDO_UNAVAILABLE'

  constructor (message: string) {
    super(message)
    this.name = 'UndoUnavailableError'
  }
}

export interface UndoOptions {
  /** How many commits to undo. Defaults to 1. */
  count?: number
}

export interface UndoResult {
  /** The sha of the new commit that reverts the undone history. */
  revertedSha: string
  /** Worktree-relative paths restored to their earlier state, sorted. */
  restoredFiles: string[]
}

/** Every blob in a tree, `path -> oid`, recursively. */
async function treeEntries (dir: string, gitdir: string, treeOid: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const walk = async (oid: string, prefix: string): Promise<void> => {
    const { tree } = await git.readTree({ fs, dir, gitdir, oid })
    for (const entry of tree) {
      const filepath = prefix ? `${prefix}/${entry.path}` : entry.path
      if (entry.type === 'tree') await walk(entry.oid, filepath)
      else out.set(filepath, entry.oid)
    }
  }
  await walk(treeOid, '')
  return out
}

/**
 * Undoes the last `count` agent commits (kip#74, SPEC-1 FR-18).
 *
 * isomorphic-git has no revert porcelain, and needs none: the workspace is
 * single-writer and linear (never shared, no merge can exist), so undoing the
 * last N commits is exactly "make the tree match the commit N steps back, then
 * commit that state as the new HEAD" — the same file state a real `git revert`
 * would produce, without revert's conflict machinery.
 *
 * Refuses with UndoUnavailableError when the workspace is not a repo, when
 * there is not enough history, or when the commits made no net file change.
 */
export async function undo (
  { dir, gitdir }: WorkspacePaths,
  { count = 1 }: UndoOptions = {}
): Promise<UndoResult> {
  if (!Number.isInteger(count) || count < 1) {
    throw new UndoUnavailableError(`undo count must be a positive integer (got ${count})`)
  }
  if (!(await isRepo({ dir, gitdir }))) {
    throw new UndoUnavailableError('the agent workspace is not a git repository yet')
  }

  const entries = await git.log({ fs, dir, gitdir, depth: count + 1 })
  if (entries.length < count) {
    throw new UndoUnavailableError(
      `cannot undo ${count} commit(s): only ${entries.length} in history`
    )
  }

  const current = entries[0]
  // `target` is the state before the undone commits. It is absent only when
  // every commit is being undone, in which case the target is the empty tree
  // (nest initialized, nothing written yet).
  const target = entries[count]
  const targetTree = target
    ? target.commit.tree
    : await git.writeTree({ fs, dir, gitdir, tree: [] })
  if (current.commit.tree === targetTree) {
    throw new UndoUnavailableError(`the last ${count} commit(s) changed no files`)
  }

  const before = await treeEntries(dir, gitdir, current.commit.tree)
  const after = target ? await treeEntries(dir, gitdir, target.commit.tree) : new Map<string, string>()
  const changed: string[] = []
  const deleted: string[] = []
  for (const [filepath, oid] of after) {
    if (before.get(filepath) !== oid) changed.push(filepath)
  }
  for (const filepath of before.keys()) {
    if (!after.has(filepath)) deleted.push(filepath)
  }
  const restoredFiles = [...changed, ...deleted].sort()

  // One checkout moves every changed path to the target bytes and updates the
  // index in the same pass. Staging per file would re-read and rewrite
  // `.git/index` hundreds of times and blow NFR-4's 2s budget.
  if (target && changed.length) {
    await git.checkout({
      fs,
      dir,
      gitdir,
      ref: target.oid,
      filepaths: changed,
      noUpdateHead: true,
      force: true
    })
  }
  if (deleted.length) {
    const cache: object = {}
    for (const filepath of deleted) {
      await rm(resolve(dir, filepath), { force: true })
      await git.updateIndex({ fs, dir, gitdir, filepath, remove: true, force: true, cache })
    }
  }

  // The target tree is known, so commit it directly rather than rebuilding it
  // from the index; the index was still updated so later status and commits
  // see a clean tree.
  const revertedSha = await git.commit({
    fs,
    dir,
    gitdir,
    message: `undo: revert last ${count} commit(s)`,
    author: WORKSPACE_AUTHOR,
    tree: targetTree,
    parent: [current.oid]
  })
  return { revertedSha, restoredFiles }
}

export { git }
