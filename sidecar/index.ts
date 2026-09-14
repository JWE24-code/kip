#!/usr/bin/env node
// Sidecar entry point. One process per app session: bind the WS server to a
// random loopback port, publish a discovery file so kip-app can find it, and
// tear the whole thing down on SIGTERM/SIGINT, parent death, or 5s of socket
// silence. Everything the protocol itself does lives in server/ and session/.

import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { startSidecarServer, generateToken, type SidecarServer } from './server/ws.ts'
import { removeDiscovery, writeDiscovery } from './discovery.ts'
import { createLLMCompleter } from './llm.ts'
import { createLogger } from './logger.ts'
import { PROTOCOL_VERSION } from './server/protocol.ts'

const require = createRequire(import.meta.url)
const paths = require('../scripts/lib/paths.js') as {
  DEFAULT_VAULT_ROOT: string
  workspaceRoot: (vaultRoot?: string) => string
}

const DEFAULT_SILENCE_MS = 5000
const PARENT_CHECK_MS = 2000

export interface CliOptions {
  port: number
  vaultRoot: string
  token: string
  silenceMs: number
  parentPid: number
  noDiscovery: boolean
}

export function parseArgs (argv: string[]): CliOptions {
  const options: CliOptions = {
    port: 0,
    vaultRoot: paths.DEFAULT_VAULT_ROOT,
    token: '',
    silenceMs: DEFAULT_SILENCE_MS,
    parentPid: process.ppid,
    noDiscovery: false
  }
  for (let i = 0; i < argv.length; i += 1) {
    const take = (): string => argv[i + 1] ?? ''
    switch (argv[i]) {
      case '--port': {
        const port = Number(take())
        options.port = Number.isInteger(port) && port >= 0 ? port : 0
        i += 1
        break
      }
      case '--vault-root':
        options.vaultRoot = take()
        i += 1
        break
      case '--token':
        options.token = take()
        i += 1
        break
      case '--silence-ms': {
        const ms = Number(take())
        options.silenceMs = Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_SILENCE_MS
        i += 1
        break
      }
      case '--no-discovery':
        options.noDiscovery = true
        break
      default:
        break
    }
  }
  return options
}

export async function main (argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv)
  const logger = createLogger('index')
  const token = options.token || generateToken()
  const complete = createLLMCompleter(options.vaultRoot)

  let parentTimer: NodeJS.Timeout | null = null
  let server: SidecarServer | null = null
  let shuttingDown = false

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`shutting down (${reason})`)
    if (parentTimer) clearInterval(parentTimer)
    if (server) await server.close()
    if (!options.noDiscovery) removeDiscovery(options.vaultRoot)
    process.exit(0)
  }

  server = await startSidecarServer({
    token,
    complete,
    vaultRoot: options.vaultRoot,
    port: options.port,
    silenceMs: options.silenceMs,
    onSilence: () => {
      void shutdown('socket silence')
    },
    logger
  })

  const url = `ws://127.0.0.1:${server.port}`
  if (!options.noDiscovery) {
    const file = writeDiscovery({
      port: server.port,
      token,
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION,
      vaultRoot: options.vaultRoot,
      workspaceRoot: paths.workspaceRoot(options.vaultRoot),
      url,
      startedAt: Date.now()
    }, options.vaultRoot)
    logger.info(`discovery file: ${file}`)
  } else {
    logger.info(`discovery disabled; connect at ${url}`)
  }

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
  process.on('disconnect', () => {
    void shutdown('parent disconnect')
  })

  parentTimer = setInterval(() => {
    if (process.ppid !== options.parentPid) void shutdown('parent exited')
  }, PARENT_CHECK_MS)
  parentTimer.unref()

  logger.info(`sidecar ready on ${url}`)
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`[sidecar:index] fatal ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    process.exit(1)
  })
}
