// How kip-app finds a running sidecar: the server drops a small JSON file into
// the per-coop workspace root (the same non-synced app-data location the roost
// index moved to, kip#67) and removes it on the way out. The token is a bearer
// secret, so the file is written 0600 and atomically (temp + rename) — a
// reader either sees the previous complete file or the new complete one, never
// a half-written frame.

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const paths = require('../scripts/lib/paths.js') as {
  DEFAULT_VAULT_ROOT: string
  workspaceRoot: (vaultRoot?: string) => string
}

export const DISCOVERY_FILE = 'sidecar.json'

export interface DiscoveryInfo {
  port: number
  token: string
  pid: number
  protocolVersion: number
  vaultRoot: string
  workspaceRoot: string
  url: string
  startedAt: number
}

export function discoveryPath (vaultRoot: string = paths.DEFAULT_VAULT_ROOT): string {
  return path.join(paths.workspaceRoot(vaultRoot), DISCOVERY_FILE)
}

export function writeDiscovery (
  info: DiscoveryInfo,
  vaultRoot: string = paths.DEFAULT_VAULT_ROOT
): string {
  const file = discoveryPath(vaultRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
  return file
}

/** Reads and shape-checks the discovery file, or null when there is none (or
 *  it is unreadable/partial — both mean "no sidecar to talk to"). */
export function readDiscovery (
  vaultRoot: string = paths.DEFAULT_VAULT_ROOT
): DiscoveryInfo | null {
  const file = discoveryPath(vaultRoot)
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!isDiscoveryInfo(parsed)) return null
  return parsed
}

export function removeDiscovery (
  vaultRoot: string = paths.DEFAULT_VAULT_ROOT
): void {
  try {
    fs.rmSync(discoveryPath(vaultRoot), { force: true })
  } catch {
    // Best-effort: a leftover discovery file is harmless, readDiscovery()
    // shape-checks whatever it finds.
  }
}

function isDiscoveryInfo (value: unknown): value is DiscoveryInfo {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.port === 'number' &&
    typeof v.token === 'string' &&
    v.token.length > 0 &&
    typeof v.pid === 'number' &&
    typeof v.protocolVersion === 'number' &&
    typeof v.vaultRoot === 'string' &&
    typeof v.workspaceRoot === 'string' &&
    typeof v.url === 'string' &&
    typeof v.startedAt === 'number'
  )
}
