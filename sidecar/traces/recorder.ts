// Full-fidelity, per-session JSONL traces (SPEC-1 NFR-7; ADD-1 AD-20).
//
// One file per session under the local workspace (the P0 relocation in
// scripts/lib/paths.js), never inside the coop: the coop is frequently inside
// Dropbox, and a trace is machine-local dev state, not user data. A superset of
// what clucks records today — prompting, every tool call with its untruncated
// result, usage, and skill execs — and dev-only: off in production unless
// KIP_TRACES explicitly turns it on.

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import paths from '../../scripts/lib/paths.js'

export type TraceRecord = {
  type: string
  ts?: number
  turnId?: string
  sessionId?: string
  [key: string]: unknown
}

export interface TraceRecorderOptions {
  sessionId: string
  // Overrides the workspace-derived directory (tests, mostly).
  dir?: string
  // Overrides the environment gate. `false` is a true no-op.
  enabled?: boolean
  // Which coop's workspace to trace into; defaults to the ambient coop.
  vaultRoot?: string
}

// The trace dir hangs off the same per-coop workspace as the roost index, so it
// inherits the "never synced" guarantee without a second path scheme.
export function tracesDir(vaultRoot?: string): string {
  return join(paths.workspaceRoot(vaultRoot), 'traces')
}

// Defensive: a session id arrives from the client. Keep it a single safe path
// segment so it can't escape the traces dir.
export function sanitizeSessionId(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return safe || 'session'
}

// Dev-only gate (AD-20). An explicit KIP_TRACES wins either way; otherwise
// traces are on everywhere except a production process. Never enable tracing of
// production traffic by accident — turn on KIP_TRACES=1 to do it deliberately.
export function tracesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const flag = env.KIP_TRACES
  if (flag === '1' || flag === 'true') return true
  if (flag === '0' || flag === 'false') return false
  return env.NODE_ENV !== 'production'
}

function stringifyLine(record: TraceRecord): string {
  return JSON.stringify(record, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value)
}

export class TraceRecorder {
  sessionId: string
  dir: string
  enabled: boolean
  file: string

  constructor(options: TraceRecorderOptions) {
    this.sessionId = options.sessionId
    this.dir = options.dir ?? tracesDir(options.vaultRoot)
    this.enabled = options.enabled ?? tracesEnabled()
    this.file = join(this.dir, `${sanitizeSessionId(this.sessionId)}.jsonl`)
  }

  // Append one event line. Synchronous on purpose: acceptance requires every
  // event of a turn to appear *in order*, and ordering is only guaranteed if a
  // record is durable before the loop moves on. Tracing must never break a
  // turn, so failures are swallowed.
  record(event: TraceRecord): void {
    if (!this.enabled) return
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(this.file, stringifyLine(event) + '\n')
    } catch {
      // A trace is observability, not correctness.
    }
  }

  close(): void {
    // Nothing buffered — every record is written through. Present for the
    // lifecycle the sidecar will want in #68.
  }
}
