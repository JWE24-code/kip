// The writer side of the roost index (kip#70, AD-4): a thin async client for
// the writer worker. Each call posts a message and resolves when that thread
// has applied it, so ordering is guaranteed (one worker, FIFO messages) and
// every mutation happens on the single write connection.
//
// Callers that want a writer scoped to one coop can construct a `RoostWriter`
// and `close()` it; the module-level helpers below cache one worker per coop so
// a caller can keep the original roost.js call shapes.

import { Worker } from 'node:worker_threads'
import { DEFAULT_VAULT_ROOT } from './schema.ts'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface WriterResponse {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

export interface SectionSummaryInput {
  heading: string
  summary: string
}

export class RoostWriter {
  readonly vaultRoot: string
  #worker: Worker
  #pending = new Map<number, Pending>()
  #seq = 0
  #closing: Promise<void> | null = null
  #dead = false

  constructor (vaultRoot: string = DEFAULT_VAULT_ROOT) {
    this.vaultRoot = String(vaultRoot)
    this.#worker = new Worker(new URL('./writer-worker.ts', import.meta.url), {
      workerData: { vaultRoot: this.vaultRoot }
    })
    // The worker shouldn't keep the process alive on its own; callers still
    // await every write before they exit.
    this.#worker.unref()
    this.#worker.on('message', (response: WriterResponse) => {
      const pending = this.#pending.get(response.id)
      if (!pending) return
      this.#pending.delete(response.id)
      if (response.ok) pending.resolve(response.result)
      else pending.reject(new Error(response.error || 'roost writer op failed'))
    })
    this.#worker.on('error', (err) => this.#failAll(err instanceof Error ? err : new Error(String(err))))
    this.#worker.on('exit', (code) => {
      this.#dead = true
      if (code !== 0) this.#failAll(new Error(`roost writer worker exited with code ${code}`))
    })
  }

  /** True once the worker thread has exited (crash, error, or close). */
  get dead (): boolean {
    return this.#dead
  }

  #failAll (err: Error): void {
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const p of pending) p.reject(err)
  }

  #call<T> (op: string, args: unknown[]): Promise<T> {
    if (this.#closing) return Promise.reject(new Error('roost writer is closed'))
    if (this.#dead) return Promise.reject(new Error('roost writer worker is not running'))
    const id = ++this.#seq
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      try {
        this.#worker.postMessage({ id, op, args })
      } catch (err) {
        this.#pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  upsertPage (
    slug: string,
    filePath: string,
    type: string,
    tags: string[],
    summary: string,
    body: string,
    aliases: string[] = []
  ): Promise<void> {
    return this.#call('upsertPage', [slug, filePath, type, tags, summary, body, aliases])
  }

  removePage (slug: string): Promise<boolean> {
    return this.#call('removePage', [slug])
  }

  setPageSummary (slug: string, summary: string): Promise<boolean> {
    return this.#call('setPageSummary', [slug, summary])
  }

  setSectionSummaries (slug: string, summaries: SectionSummaryInput[]): Promise<number> {
    return this.#call('setSectionSummaries', [slug, summaries])
  }

  appendLog (kind: string, title: string, pagesTouched: string[] = []): Promise<void> {
    return this.#call('appendLog', [kind, title, pagesTouched])
  }

  regenerateIndexMd (): Promise<void> {
    return this.#call('regenerateIndexMd', [])
  }

  recordHatchedSource (relPath: string, hash: string): Promise<void> {
    return this.#call('recordHatchedSource', [relPath, hash])
  }

  rebuild (): Promise<{ indexed: number }> {
    return this.#call('rebuild', [])
  }

  /** Flushes the worker, closes its connection, and stops the thread. */
  close (): Promise<void> {
    if (this.#closing) return this.#closing
    this.#closing = (async () => {
      try {
        await this.#call('close', [])
      } catch {
        // worker already gone
      }
      await this.#worker.terminate()
    })()
    return this.#closing
  }
}

const writers = new Map<string, RoostWriter>()

export function writerFor (vaultRoot: string = DEFAULT_VAULT_ROOT): RoostWriter {
  const key = String(vaultRoot)
  let writer = writers.get(key)
  if (!writer || writer.dead) {
    writer = new RoostWriter(key)
    writers.set(key, writer)
  }
  return writer
}

/** Stops the cached writer for one coop (test/teardown use). */
export async function closeWriter (vaultRoot: string = DEFAULT_VAULT_ROOT): Promise<void> {
  const key = String(vaultRoot)
  const writer = writers.get(key)
  if (!writer) return
  writers.delete(key)
  await writer.close()
}

/** Stops every cached writer (test/teardown use). */
export async function closeWriters (): Promise<void> {
  const all = [...writers.values()]
  writers.clear()
  await Promise.all(all.map((w) => w.close()))
}

// ---- roost.js-shaped convenience wrappers --------------------------------
// These keep the call sites identical to scripts/lib/roost.js, with the write
// now async because it crosses to the worker thread.

export function upsertPage (
  slug: string,
  filePath: string,
  type: string,
  tags: string[],
  summary: string,
  body: string,
  vaultRoot: string = DEFAULT_VAULT_ROOT,
  aliases: string[] = []
): Promise<void> {
  return writerFor(vaultRoot).upsertPage(slug, filePath, type, tags, summary, body, aliases)
}

export function removePage (slug: string, vaultRoot: string = DEFAULT_VAULT_ROOT): Promise<boolean> {
  return writerFor(vaultRoot).removePage(slug)
}

export function setPageSummary (slug: string, summary: string, vaultRoot: string = DEFAULT_VAULT_ROOT): Promise<boolean> {
  return writerFor(vaultRoot).setPageSummary(slug, summary)
}

export function setSectionSummaries (
  slug: string,
  summaries: SectionSummaryInput[],
  vaultRoot: string = DEFAULT_VAULT_ROOT
): Promise<number> {
  return writerFor(vaultRoot).setSectionSummaries(slug, summaries)
}

export function appendLog (
  kind: string,
  title: string,
  pagesTouched: string[] = [],
  vaultRoot: string = DEFAULT_VAULT_ROOT
): Promise<void> {
  return writerFor(vaultRoot).appendLog(kind, title, pagesTouched)
}

export function regenerateIndexMd (vaultRoot: string = DEFAULT_VAULT_ROOT): Promise<void> {
  return writerFor(vaultRoot).regenerateIndexMd()
}

export function recordHatchedSource (relPath: string, hash: string, vaultRoot: string = DEFAULT_VAULT_ROOT): Promise<void> {
  return writerFor(vaultRoot).recordHatchedSource(relPath, hash)
}

/** Rebuilds meta.db + nest/index.md from the markdown under coop/nest/. */
export function rebuildRoost (vaultRoot: string = DEFAULT_VAULT_ROOT): Promise<{ indexed: number }> {
  return writerFor(vaultRoot).rebuild()
}
