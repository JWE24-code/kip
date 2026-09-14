// A bare Node client for the sidecar — the reference implementation the
// acceptance criterion names ("a bare Node client can complete the
// hello/ready handshake…"), and what the tests use. It is deliberately small:
// connect + authenticate, send catalogued events, and await the events that
// match.

import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { PROTOCOL_VERSION, type Envelope } from './server/protocol.ts'

export interface ConnectOptions {
  url: string
  token: string
  protocolVersion?: number
  timeoutMs?: number
}

export interface MessagePredicate {
  (envelope: Envelope): boolean
}

export interface SidecarClient {
  socket: WebSocket
  sessionId: string
  events: Envelope[]
  send: (type: string, payload?: unknown) => string
  next: (type: string, predicate?: MessagePredicate, timeoutMs?: number) => Promise<Envelope>
  on: (type: string, handler: (envelope: Envelope) => void) => () => void
  close: () => void
}

export async function connect (options: ConnectOptions): Promise<SidecarClient> {
  const protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION
  const timeoutMs = options.timeoutMs ?? 5000
  const socket = new WebSocket(options.url)
  const events: Envelope[] = []
  const waiters: Array<{ type: string, predicate: MessagePredicate, resolve: (e: Envelope) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }> = []
  const handlers = new Map<string, Set<(envelope: Envelope) => void>>()

  socket.on('message', (data) => {
    let envelope: Envelope
    try {
      envelope = JSON.parse(data.toString()) as Envelope
    } catch {
      return
    }
    events.push(envelope)
    for (const handler of handlers.get(envelope.type) ?? []) handler(envelope)
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i]
      if (waiter.type === envelope.type && waiter.predicate(envelope)) {
        clearTimeout(waiter.timer)
        waiters.splice(i, 1)
        waiter.resolve(envelope)
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out opening socket')), timeoutMs)
    socket.once('open', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })

  const send = (type: string, payload?: unknown): string => {
    const id = randomUUID()
    socket.send(JSON.stringify({ v: protocolVersion, id, type, ts: Date.now(), payload }))
    return id
  }

  const next = (
    type: string,
    predicate: MessagePredicate = () => true,
    waitMs = timeoutMs
  ): Promise<Envelope> => {
    const existing = events.find((event) => event.type === type && predicate(event))
    if (existing) return Promise.resolve(existing)
    return new Promise<Envelope>((resolve, reject) => {
      const waiter = {
        type,
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error(`timed out waiting for ${type}`))
        }, waitMs)
      }
      waiters.push(waiter)
    })
  }

  const client: SidecarClient = {
    socket,
    sessionId: '',
    events,
    send,
    next,
    on: (type, handler) => {
      const set = handlers.get(type) ?? new Set()
      set.add(handler)
      handlers.set(type, set)
      return () => set.delete(handler)
    },
    close: () => socket.close()
  }

  send('hello', { token: options.token })
  const handshake = await new Promise<Envelope>((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | null = null
    let offReady: () => void = () => {}
    let offError: () => void = () => {}
    const settle = (action: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      offReady()
      offError()
      action()
    }
    offReady = client.on('ready', (envelope) => settle(() => resolve(envelope)))
    offError = client.on('error', (envelope) => {
      const payload = envelope.payload as { code?: string, message?: string }
      settle(() => reject(new Error(`handshake rejected: ${payload.code ?? 'ERROR'} ${payload.message ?? ''}`.trim())))
    })
    timer = setTimeout(() => settle(() => reject(new Error('timed out during hello/ready handshake'))), timeoutMs)
  })
  client.sessionId = (handshake.payload as { sessionId: string }).sessionId
  return client
}
