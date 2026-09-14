// Managed-backend usage reporting (P7, kip#79) — the one place a managed
// (kip) call's token counts go *up* to the backend, and nowhere else.
//
// The backend owns all pricing/plan/aggregation (kip-backend#97); this module
// deliberately knows nothing about money. It forwards a closed set of opaque
// counters — call id, model, workload, input/output tokens — and nothing more.
// BYOK calls are a hard no-op: they never touch this path, so no BYOK usage
// exists to report anywhere.
//
// Rules, mirroring scripts/lib/feedback-poster.js:
//   * managed provider only — report() no-ops otherwise
//   * best-effort — never throws into a turn; every network error is swallowed
//   * never delays a turn — flush() caps its own wait; the timer is unref()'d
//   * closed field set — no free text, no cost, no price can ride along
//
// The exact wire shape is the coordination point with kip-backend#97: the
// request is built in `writeBody()` below, so if the backend settles on a
// different one it changes in a single function.

import { createRequire } from 'node:module'
import { resolveActive, KIP_BASE_URL_DEFAULT } from './config.ts'
import { silentLogger, type Logger } from '../logger.ts'

const require = createRequire(import.meta.url)
const paths = require('../../scripts/lib/paths.js') as { DEFAULT_VAULT_ROOT: string }

const DEFAULT_FLUSH_MS = 5000
const DEFAULT_FLUSH_BUDGET_MS = 1000

/** What the client is willing to tell the backend about one call. No price. */
export interface CallUsageReport {
  provider: string
  model: string | null
  label: string | null
  callId: string | null
  inputTokens: number
  outputTokens: number
}

/** The only keys that may cross the wire. */
interface WireCall {
  call_id: string | null
  model: string | null
  workload: string | null
  input_tokens: number
  output_tokens: number
}

export interface UsageReporter {
  /** Queue one call's token counts. Silent no-op unless the managed backend is active. */
  report: (report: CallUsageReport) => void
  /** Flush now, capped at the budget so a slow backend can't delay shutdown. */
  flush: () => Promise<void>
  /** Drop everything pending and cancel the timer. */
  stop: () => void
  readonly pending: number
}

export interface UsageReporterOptions {
  vaultRoot?: string
  fetchImpl?: typeof fetch
  flushMs?: number
  flushBudgetMs?: number
  logger?: Logger
  env?: NodeJS.ProcessEnv
}

interface ManagedTarget {
  baseUrl: string
  apiKey: string
}

/**
 * The managed backend's URL + key when — and only when — the active provider
 * is kip and it has a key. Returns null for every BYOK provider, for a missing
 * key, and for a corrupt config file (reporting is best-effort, never fatal).
 */
function managedTarget (vaultRoot: string, env: NodeJS.ProcessEnv): ManagedTarget | null {
  let active
  try {
    active = resolveActive(vaultRoot, env)
  } catch {
    return null
  }
  if (active.info.id !== 'kip') return null
  const apiKey = active.config.apiKey
  if (!apiKey) return null
  return { baseUrl: (active.config.baseUrl || KIP_BASE_URL_DEFAULT).replace(/\/+$/, ''), apiKey }
}

/** Reduce a report to the closed wire field set. */
function toWireCall (report: CallUsageReport): WireCall {
  return {
    call_id: report.callId,
    model: report.model,
    workload: report.label,
    input_tokens: report.inputTokens,
    output_tokens: report.outputTokens
  }
}

export function createUsageReporter (options: UsageReporterOptions = {}): UsageReporter {
  const vaultRoot = options.vaultRoot ?? paths.DEFAULT_VAULT_ROOT
  const env = options.env ?? process.env
  const doFetch = options.fetchImpl ?? fetch
  const flushMs = options.flushMs ?? DEFAULT_FLUSH_MS
  const flushBudgetMs = options.flushBudgetMs ?? DEFAULT_FLUSH_BUDGET_MS
  const logger = options.logger ?? silentLogger

  let queue: WireCall[] = []
  let timer: NodeJS.Timeout | null = null

  const drain = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!queue.length) return
    const batch = queue
    queue = []
    const target = managedTarget(vaultRoot, env)
    if (!target) return // provider changed away from kip / no key — drop
    try {
      await doFetch(`${target.baseUrl}/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${target.apiKey}`
        },
        body: JSON.stringify(writeBody(batch))
      })
    } catch (err) {
      logger.warn(`[usage] report failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    report (report: CallUsageReport): void {
      if (report.provider !== 'kip') return // BYOK: nothing to report, ever
      queue.push(toWireCall(report))
      if (!timer) {
        timer = setTimeout(() => { void drain() }, flushMs)
        timer.unref()
      }
    },

    async flush (): Promise<void> {
      await Promise.race([
        drain(),
        new Promise<void>((resolve) => {
          const budget = setTimeout(resolve, flushBudgetMs)
          budget.unref()
        })
      ])
    },

    stop (): void {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      queue = []
    },

    get pending (): number {
      return queue.length
    }
  }
}

/** The request body posted to the backend. One function, one shape to change. */
function writeBody (calls: WireCall[]): { calls: WireCall[] } {
  return { calls }
}
