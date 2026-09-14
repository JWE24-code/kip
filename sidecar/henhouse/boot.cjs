'use strict'

// Preloaded into every skill process (`node --require __kip_boot.cjs <entry>`).
//
// Its whole job is to give the skill the parent-side hostcall bridge without
// handing it any capability directly. The parent enforces the manifest: this
// file only forwards `{name, args}` and settles the promise with what comes
// back. The IPC channel is unref'd while no call is in flight so the skill
// process exits naturally when its own work is done — and ref'd during a call
// so a pending hostcall keeps it alive.

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
