// The skill executor (P6, kip#77) — the replacement for `scripts/lib/skills.js`'s
// unsandboxed `execFile`.
//
// It runs one skill as its own Node process under the platform's permission
// model, so a manifest's declared capabilities are enforced by the OS rather
// than documented and hoped for:
//
//   * mounts       — only the run's input snapshot (ro) and the coop's
//                    `exports/` (rw) are readable/writable; the live vault is
//                    not. Path traversal is refused twice: by the mount
//                    resolver (mounts.ts) and, ultimately, by the kernel-level
//                    permission scope.
//   * network:none — the process cannot reach the network: the permission
//                    model denies it on Node 25+, and boot.cjs removes
//                    `fetch`, `WebSocket`, and the network built-ins on every
//                    Node line. The only way out is a declared,
//                    parent-mediated hostcall (hostcalls.ts).
//   * limits       — wall clock (kill), V8 heap (`--max-old-space-size`), and
//                    captured stdout are bounded; hitting a limit terminates
//                    the process rather than truncating a live run.
//   * secrets      — the child env is built from a whitelist, never inherited.
//                    Provider keys, `skills.json` secrets, and every other
//                    parent env var never enter it (FR-25).
//
// The `node-inproc` backend runs the skill on Node's own runtime and module
// system. It uses a dedicated subprocess because Node derives the permission
// model's default read scope from the *process* cwd, so a stable, non-vault cwd
// is what makes the mount contract hold — and because a real process is what
// makes abort a true kill. A `pyodide` (WASM) backend is reserved for v1.5.

import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SkillManifest } from './manifest.ts'
import { createRunMounts, materializeSnapshot, type RunMounts, type SkillSnapshot } from './mounts.ts'
import { invokeHostcall, type HostcallContext, type LlmCompleteFn } from './hostcalls.ts'

const require = createRequire(import.meta.url)
const paths = require('../../scripts/lib/paths.js') as {
  workspaceRoot: (vaultRoot: string) => string
  exportsPath: (vaultRoot: string) => string
}

const BOOT_PATH = fileURLToPath(new URL('./boot.cjs', import.meta.url))
const INPUT_CAP_BYTES = 16 * 1024
const STDERR_CAP_BYTES = 16 * 1024

/** `--permission` became the stable spelling in Node 23.5; earlier lines only
 *  know `--experimental-permission`. Everything else in the flag set is shared. */
function permissionFlag (): string {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  return major > 23 || (major === 23 && minor >= 5) ? '--permission' : '--experimental-permission'
}

export type SkillBackend = 'node-inproc'

export type SkillRunReason = 'ok' | 'error' | 'timeout' | 'aborted' | 'mem-limit'

export interface SkillRunRequest {
  manifest: SkillManifest
  /** The model's arguments; JSON-serialized into the child env (capped). */
  input?: unknown
  /** Notes/data materialized read-only under the input mount. */
  snapshot?: SkillSnapshot
  signal?: AbortSignal
  vaultRoot: string
  runId?: string
  /** Parent-side LLM used by the `llm.complete` hostcall (key stays here). */
  llm?: LlmCompleteFn
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Extra non-secret env for the child (never inherited from the parent). */
  env?: Record<string, string>
}

export interface SkillRunResult {
  skill: string
  runId: string
  backend: SkillBackend
  ok: boolean
  reason: SkillRunReason
  output: string
  error: string | null
  ms: number
  timedOut: boolean
  aborted: boolean
  truncated: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
  /** Absolute paths under `<coop>/exports` created by a successful run. */
  artifacts: string[]
}

export interface SkillExecutor {
  readonly backend: SkillBackend
  run (request: SkillRunRequest): Promise<SkillRunResult>
  /** Kill an in-flight run (by runId). Returns false when it isn't running. */
  abort (runId: string): boolean
  abortAll (): void
}

interface ActiveRun {
  child: ChildProcess
  killed: boolean
  reason: Extract<SkillRunReason, 'timeout' | 'aborted'> | null
  kill: (reason: 'timeout' | 'aborted') => void
}

// ---- filesystem helpers ----------------------------------------------------

/** Every file under `dir` as a path relative to `dir` (recursive). */
async function listRelativeFiles (dir: string): Promise<Set<string>> {
  const out = new Set<string>()
  async function walk (current: string): Promise<void> {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = join(current, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(abs)
      else if (entry.isFile()) out.add(relative(dir, abs))
    }
  }
  await walk(dir)
  return out
}

/** Removes directories left empty after a rollback (bottom-up). */
async function pruneEmptyDirs (root: string): Promise<void> {
  async function walk (dir: string): Promise<boolean> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return false
    }
    let empty = true
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const childEmpty = await walk(abs)
        if (childEmpty) await rm(abs, { recursive: true, force: true }).catch(() => {})
        else empty = false
      } else {
        empty = false
      }
    }
    return empty && resolve(dir) !== resolve(root)
  }
  await walk(root)
}

/** Drops any file (and now-empty directory) a failed run left behind. */
async function rollbackNewFiles (exportsDir: string, baseline: Set<string>): Promise<void> {
  const current = await listRelativeFiles(exportsDir)
  for (const rel of current) {
    if (!baseline.has(rel)) await rm(join(exportsDir, rel), { force: true }).catch(() => {})
  }
  await pruneEmptyDirs(exportsDir)
}

/** Existing `node_modules` dirs on the path from `dir` up to the fs root. */
function moduleRootsFor (dir: string): string[] {
  const roots: string[] = []
  let current = resolve(dir)
  for (;;) {
    const candidate = join(current, 'node_modules')
    if (existsSync(candidate)) roots.push(candidate)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return roots
}

// ---- the backend -----------------------------------------------------------

interface RunState {
  stdout: string
  stderr: string
  truncated: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
}

class NodeInprocExecutor implements SkillExecutor {
  readonly backend: SkillBackend = 'node-inproc'
  private readonly active = new Map<string, ActiveRun>()

  run (request: SkillRunRequest): Promise<SkillRunResult> {
    return this.execute(request)
  }

  abort (runId: string): boolean {
    const active = this.active.get(runId)
    if (!active) return false
    active.kill('aborted')
    return true
  }

  abortAll (): void {
    for (const active of this.active.values()) active.kill('aborted')
  }

  private async execute (request: SkillRunRequest): Promise<SkillRunResult> {
    const { manifest, vaultRoot } = request
    const runId = request.runId ?? randomUUID()
    const started = Date.now()
    const exportsDir = paths.exportsPath(vaultRoot)
    const runRoot = join(paths.workspaceRoot(vaultRoot), 'skill-runs', runId)
    const mounts = createRunMounts(runRoot)

    await mkdir(exportsDir, { recursive: true })
    const baseline = await listRelativeFiles(exportsDir)

    const state: RunState = { stdout: '', stderr: '', truncated: false, exitCode: null, signal: null }
    let reason: SkillRunReason | null = null
    let hostcallController: AbortController | null = null

    try {
      await mkdir(runRoot, { recursive: true })
      await materializeSnapshot(mounts, request.snapshot)
      const bootPath = join(runRoot, '__kip_boot.cjs')
      await writeFile(bootPath, await readFile(BOOT_PATH))

      const execArgv = this.buildExecArgv(request, mounts, bootPath, exportsDir)
      const env = this.buildEnv(request, runId, mounts, exportsDir)
      const hostcallCtx: HostcallContext = {
        network: manifest.network,
        hostcalls: manifest.hostcalls,
        fetchImpl: request.fetchImpl ?? globalThis.fetch,
        llm: request.llm,
        signal: (hostcallController = new AbortController()).signal
      }

      reason = await this.spawnAndWait(manifest, runId, runRoot, execArgv, env, state, hostcallCtx, request)
    } catch (err) {
      reason = 'error'
      state.stderr = state.stderr || (err instanceof Error ? err.message : String(err))
    } finally {
      hostcallController?.abort()
    }

    const ok = reason === 'ok'
    const artifacts: string[] = []
    try {
      if (ok) {
        const current = await listRelativeFiles(exportsDir)
        for (const rel of current) {
          if (!baseline.has(rel)) artifacts.push(join(exportsDir, rel))
        }
        artifacts.sort()
      } else {
        await rollbackNewFiles(exportsDir, baseline)
      }
    } finally {
      await rm(runRoot, { recursive: true, force: true }).catch(() => {})
      this.active.delete(runId)
    }

    return this.result(request, runId, reason ?? 'error', state, Date.now() - started, artifacts)
  }

  private async spawnAndWait (
    manifest: SkillManifest,
    runId: string,
    runRoot: string,
    execArgv: string[],
    env: Record<string, string>,
    state: RunState,
    hostcallCtx: HostcallContext,
    request: SkillRunRequest
  ): Promise<SkillRunReason> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess
      try {
        child = fork(manifest.entryPath, [], {
          cwd: runRoot,
          execArgv,
          env,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc']
        })
      } catch (err) {
        reject(err)
        return
      }

      let settled = false
      const settle = (reason: SkillRunReason): void => {
        if (settled) return
        settled = true
        resolve(reason)
      }

      const kill = (killReason: 'timeout' | 'aborted'): void => {
        if (active.killed) return
        active.killed = true
        active.reason = killReason
        child.kill('SIGKILL')
      }
      const active: ActiveRun = { child, killed: false, reason: null, kill }
      this.active.set(runId, active)

      const wall = setTimeout(() => kill('timeout'), manifest.limits.wallMs)
      const onAbort = (): void => kill('aborted')
      request.signal?.addEventListener('abort', onAbort, { once: true })

      child.stdout?.on('data', (chunk: Buffer) => capture(state, 'stdout', chunk, manifest.limits.outputBytes))
      child.stderr?.on('data', (chunk: Buffer) => capture(state, 'stderr', chunk, STDERR_CAP_BYTES))
      child.on('message', (message: unknown) => {
        void handleMessage(child, message, hostcallCtx)
      })
      child.on('error', (err) => {
        state.stderr = state.stderr || err.message
        clearTimeout(wall)
        request.signal?.removeEventListener('abort', onAbort)
        settle(active.reason ?? 'error')
      })
      child.on('exit', (code, signal) => {
        clearTimeout(wall)
        request.signal?.removeEventListener('abort', onAbort)
        state.exitCode = code
        state.signal = signal
        settle(active.reason ?? classifyExit(code, signal, state.stderr))
      })
    })
  }

  private buildExecArgv (
    request: SkillRunRequest,
    mounts: RunMounts,
    bootPath: string,
    exportsDir: string
  ): string[] {
    const { manifest } = request
    const readRoots = new Set<string>([
      mounts.root,
      manifest.dir,
      exportsDir,
      ...moduleRootsFor(manifest.dir)
    ])
    const execArgv = [permissionFlag(), `--max-old-space-size=${manifest.limits.memMb}`]
    for (const root of readRoots) execArgv.push(`--allow-fs-read=${root}`)
    execArgv.push(`--allow-fs-write=${exportsDir}`)
    execArgv.push('--require', bootPath)
    return execArgv
  }

  /** The child env is a whitelist. Parent env, provider keys, and skills.json
   *  secrets are deliberately not inherited (FR-25). */
  private buildEnv (request: SkillRunRequest, runId: string, mounts: RunMounts, exportsDir: string): Record<string, string> {
    const { manifest, vaultRoot } = request
    const inputJson = JSON.stringify(request.input == null ? {} : request.input)
    if (inputJson.length > INPUT_CAP_BYTES) {
      throw new Error(`skill input is too large (${inputJson.length} > ${INPUT_CAP_BYTES} bytes)`)
    }
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      NODE_NO_WARNINGS: '1',
      KIP_RUN_ID: runId,
      KIP_NETWORK: manifest.network.mode,
      KIP_INPUT_DIR: mounts.input,
      KIP_EXPORTS_DIR: exportsDir,
      KIP_COOP_ROOT: vaultRoot,
      SKILL_DIR: manifest.dir,
      SKILL_INPUT: inputJson,
      KIP_SKILL_INPUT: inputJson
    }
    for (const [key, value] of Object.entries(request.env ?? {})) {
      if (typeof value === 'string') env[key] = value
    }
    return env
  }

  private result (
    request: SkillRunRequest,
    runId: string,
    reason: SkillRunReason,
    state: RunState,
    ms: number,
    artifacts: string[]
  ): SkillRunResult {
    const maxBytes = request.manifest.limits.outputBytes
    const output = state.stdout.trim().slice(0, maxBytes)
    const error = reason === 'ok'
      ? null
      : reason === 'timeout' ? `timed out after ${request.manifest.limits.wallMs}ms`
        : reason === 'aborted' ? 'aborted'
          : (lastLine(state.stderr) || (state.exitCode === null ? `killed by ${state.signal ?? 'signal'}` : `exited ${state.exitCode}`))
    return {
      skill: request.manifest.name,
      runId,
      backend: this.backend,
      ok: reason === 'ok',
      reason,
      output,
      error,
      ms,
      timedOut: reason === 'timeout',
      aborted: reason === 'aborted',
      truncated: state.truncated || state.stdout.length > maxBytes,
      exitCode: state.exitCode,
      signal: state.signal,
      artifacts
    }
  }
}

function capture (state: RunState, field: 'stdout' | 'stderr', chunk: Buffer, cap: number): void {
  const text = chunk.toString('utf8')
  const existing = state[field]
  if (existing.length >= cap) {
    if (field === 'stdout') state.truncated = true
    return
  }
  state[field] = existing + text.slice(0, cap - existing.length)
  if (field === 'stdout' && existing.length + text.length > cap) state.truncated = true
}

function lastLine (text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  return lines.length ? lines[lines.length - 1].slice(0, 500) : ''
}

/** Distinguishes a heap blow-up from an ordinary crash. `--max-old-space-size`
 *  makes V8 abort (SIGABRT / exit 134) with a recognizable stderr. */
function classifyExit (code: number | null, signal: NodeJS.Signals | null, stderr: string): SkillRunReason {
  if (code === 0 && !signal) return 'ok'
  if (signal === 'SIGABRT' || code === 134 || /heap out of memory|out of memory|allocation failed/i.test(stderr)) {
    return 'mem-limit'
  }
  return 'error'
}

async function handleMessage (
  child: ChildProcess,
  message: unknown,
  ctx: HostcallContext
): Promise<void> {
  if (!message || typeof message !== 'object') return
  const msg = message as { type?: unknown, id?: unknown, name?: unknown, args?: unknown }
  if (msg.type !== 'hostcall') return
  const id = msg.id
  try {
    const value = await invokeHostcall(String(msg.name ?? ''), msg.args, ctx)
    send(child, { type: 'hostcall.result', id, ok: true, value })
  } catch (err) {
    send(child, {
      type: 'hostcall.result',
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: (err as { code?: string }).code
    })
  }
}

function send (child: ChildProcess, message: Record<string, unknown>): void {
  try {
    if (child.connected) child.send(message)
  } catch {
    /* child already gone */
  }
}

export interface SkillExecutorOptions {
  backend?: SkillBackend
}

/**
 * Creates the skill executor. `node-inproc` is the only backend today; a
 * `pyodide` (WASM, separate runtime) backend is reserved for v1.5.
 */
export function createSkillExecutor (options: SkillExecutorOptions = {}): SkillExecutor {
  const backend = options.backend ?? 'node-inproc'
  if (backend === 'node-inproc') return new NodeInprocExecutor()
  throw new Error(`unknown or not-yet-implemented skill backend: ${backend}`)
}
