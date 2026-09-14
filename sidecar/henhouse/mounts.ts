// The skill sandbox's filesystem mounts (P6, kip#77).
//
// A skill never sees the live vault. It gets exactly two materialized roots:
//
//   input/    a read-only snapshot of the notes/data it was handed
//   exports/  the coop's exports/ folder, the only place it may write
//
// Everything else is denied by the executor's OS-level permission scope. This
// module owns the *virtual* half of that contract: taking a map of snapshot
// files and materializing them under the input mount, and resolving a
// skill-supplied relative path against a mount such that it provably cannot
// climb out (`../../..`, an absolute path, a NUL) into the vault or anywhere
// else. The physical half — the permission flags that back these mounts — is
// enforced when the process is spawned (executor.ts).
//
// Both layers are deliberate: resolving here gives a clean, typed refusal and
// keeps mount-relative APIs honest; the process scope is what actually makes a
// `require('node:fs')` escape fail even if a skill ignores this module.

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

export const MOUNT_ESCAPE = 'MOUNT_ESCAPE'

export class MountEscapeError extends Error {
  code = MOUNT_ESCAPE
  mount: string

  constructor (mount: string, requested: string) {
    super(`path "${requested}" escapes the "${mount}" mount`)
    this.name = 'MountEscapeError'
    this.mount = mount
  }
}

export interface RunMounts {
  /** The per-run root; `input` and `exports` live directly under it. */
  root: string
  /** Read-only materialized snapshot. */
  input: string
  /** Where the skill writes deliverables (the coop's `exports/`). */
  exports: string
}

export type SnapshotEntry = string | Uint8Array
export type SkillSnapshot = Record<string, SnapshotEntry>

/** The run roots for a fresh run — `input` and `exports` are created lazily. */
export function createRunMounts (runRoot: string): RunMounts {
  const root = resolve(runRoot)
  return { root, input: join(root, 'input'), exports: join(root, 'exports') }
}

/** True when `child` is inside `parent` (or is `parent`). Both must be resolved. */
export function isInside (parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`))
}

/**
 * Resolves a skill-supplied relative path against one mount, refusing anything
 * that would land outside it. Absolute paths, `..` segments, and NUL bytes are
 * rejected before touching the filesystem.
 */
export function resolveMountPath (mounts: RunMounts, mountName: keyof Omit<RunMounts, 'root'>, requested: string): string {
  const requestedRaw = String(requested ?? '')
  if (!requestedRaw || requestedRaw.includes('\0')) throw new MountEscapeError(mountName, requestedRaw)
  if (requestedRaw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(requestedRaw)) {
    throw new MountEscapeError(mountName, requestedRaw)
  }
  const base = mountName === 'input' ? mounts.input : mounts.exports
  const abs = resolve(base, requestedRaw)
  if (abs !== resolve(base) && !isInside(base, abs)) throw new MountEscapeError(mountName, requestedRaw)
  return abs
}

/**
 * Writes the snapshot into the read-only input mount. Keys are mount-relative
 * paths (a note slug, a template name); an escaping key is a hard error rather
 * than a silent skip, because a caller building an unsafe snapshot is a bug.
 * Returns the relative paths written, sorted.
 */
export async function materializeSnapshot (mounts: RunMounts, snapshot: SkillSnapshot = {}): Promise<string[]> {
  await mkdir(mounts.input, { recursive: true })
  const written: string[] = []
  for (const [relPath, content] of Object.entries(snapshot)) {
    const abs = resolveMountPath(mounts, 'input', relPath)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content)
    written.push(relative(mounts.input, abs))
  }
  return written.sort()
}
