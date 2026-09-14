'use strict'

// Preloaded into every skill process (`node --require __kip_boot.cjs <entry>`).
//
// Two jobs:
//
//   1. Give the skill the parent-side hostcall bridge. The parent enforces the
//      manifest; this file only forwards `{name, args}` and settles the promise
//      with what comes back. The IPC channel is unref'd while no call is in
//      flight so the skill process exits naturally when its own work is done —
//      and ref'd during a call so a pending hostcall keeps it alive.
//
//   2. Close off direct network access in *this* process. The executor also
//      runs under Node's permission model (which blocks `fetch`/sockets on
//      Node 25+), but that model did not gate network on Node 24, so a skill
//      must not be able to rely on it. Direct network is never a capability a
//      skill has — the only path out is a declared hostcall — so `fetch`,
//      `WebSocket`, and the network built-ins are removed unconditionally.
//      Hard containment against a determined native-escape attacker is the
//      pyodide backend's job (v1.5); this is the node-inproc perimeter.

const pending = new Map()
let seq = 0

function refChannel () {
  try {
    if (process.channel && process.channel.ref) process.channel.ref()
  } catch {
    /* channel already gone */
  }
}

function unrefChannel () {
  try {
    if (process.channel && process.channel.unref) process.channel.unref()
  } catch {
    /* channel already gone */
  }
}

function capabilityError (message, code) {
  const error = new Error(message || 'hostcall failed')
  if (code) error.code = code
  return error
}

process.on('message', (message) => {
  if (!message || message.type !== 'hostcall.result') return
  const waiter = pending.get(message.id)
  if (!waiter) return
  pending.delete(message.id)
  if (!pending.size) unrefChannel()
  if (message.ok) waiter.resolve(message.value)
  else waiter.reject(capabilityError(message.error, message.code))
})

globalThis.kip = Object.freeze({
  /**
   * Ask the parent to perform one declared capability. `name` must be listed
   * in the skill's manifest `hostcalls:`; the parent rejects anything else.
   */
  hostcall (name, args) {
    return new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      refChannel()
      try {
        process.send({ type: 'hostcall', id, name, args })
      } catch (err) {
        pending.delete(id)
        if (!pending.size) unrefChannel()
        reject(err)
      }
    })
  },
  /** Absolute mount dirs. `input` is the read-only snapshot; `exports` is rw. */
  mounts: Object.freeze({
    input: process.env.KIP_INPUT_DIR || '',
    exports: process.env.KIP_EXPORTS_DIR || ''
  }),
  network: process.env.KIP_NETWORK || 'none'
})

unrefChannel()

// ---- direct-network denial (see header) ------------------------------------

const DENIED_BUILTINS = new Set([
  'net', 'tls', 'http', 'https', 'http2', 'dns', 'dgram',
  'node:net', 'node:tls', 'node:http', 'node:https', 'node:http2', 'node:dns', 'node:dgram'
])

function networkDenied () {
  const error = new Error('network access is denied in the skill sandbox; use a declared hostcall')
  error.code = 'ERR_ACCESS_DENIED'
  return error
}

try {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: () => Promise.reject(networkDenied())
  })
} catch {
  try { globalThis.fetch = () => Promise.reject(networkDenied()) } catch { /* frozen global */ }
}

try {
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: class { constructor () { throw networkDenied() } }
  })
} catch {
  /* no global WebSocket on this Node line, or a frozen global */
}

try {
  const Module = require('node:module')
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (DENIED_BUILTINS.has(request)) throw networkDenied()
    return originalLoad.apply(this, arguments)
  }
} catch {
  /* if the module system can't be patched, the permission model is the fallback */
}
