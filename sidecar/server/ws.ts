// The WebSocket surface: bind 127.0.0.1 only, authenticate the first frame
// (hello/ready), then route catalogued events to the turn loop. The server
// owns the wire; process lifecycle (signals, parent death, the idle timeout)
// lives in index.ts, which the silence hook below calls back into.

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import {
  ErrorCode,
  PROTOCOL_VERSION,
  isClientEvent,
  makeEnvelope,
  parseEnvelope,
  validatePayload,
  type ServerEventType
} from './protocol.ts'
import { runTurn, type CompleteFn } from '../session/turn.ts'
import { Workspace, WorkspaceError } from '../workspace/git.ts'
import { silentLogger, type Logger } from '../logger.ts'

export interface SidecarServerOptions {
  token: string
  complete: CompleteFn
  /** The git-versioned agent workspace (`nest/`); undo is served from it. */
  workspaceDir?: string
  port?: number
  protocolVersion?: number
  maxToolCalls?: number
  deltaBatchMs?: number
  maxResultChars?: number
  /** Kills the process after this many ms with no socket traffic in either
   *  direction. 0 disables the watchdog (the default — index.ts sets 5000). */
  silenceMs?: number
  idleCheckMs?: number
  onSilence?: () => void
  logger?: Logger
}

export interface SidecarServer {
  port: number
  sessionId: string
  close: () => Promise<void>
}

interface ConnState {
  socket: WebSocket
  authed: boolean
  turnBusy: boolean
  abort: AbortController | null
}

function safeTokenEqual (a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function generateToken (): string {
  return randomBytes(32).toString('hex')
}

/** Starts the server and resolves once it is listening, with the actual port
 *  (port 0 means the OS picked one). */
export async function startSidecarServer (
  options: SidecarServerOptions
): Promise<SidecarServer> {
  const logger = options.logger ?? silentLogger
  const protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION
  const silenceMs = options.silenceMs ?? 0
  const idleCheckMs = options.idleCheckMs ?? 250
  const sessionId = randomUUID()

  const wss = new WebSocketServer({ host: '127.0.0.1', port: options.port ?? 0 })
  const states = new Map<WebSocket, ConnState>()
  let activeSocket: WebSocket | null = null
  let lastActivity = Date.now()

  const touch = (): void => {
    lastActivity = Date.now()
  }

  const send = (socket: WebSocket, type: ServerEventType, payload: unknown): string => {
    const id = randomUUID()
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(makeEnvelope(type, payload, id)))
      touch()
    }
    return id
  }

  const sendError = (socket: WebSocket, code: ErrorCode, message: string, id?: string): void => {
    send(socket, 'error', { code, message, id })
  }

  const onConnection = (socket: WebSocket): void => {
    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      sendError(socket, ErrorCode.TURN_IN_PROGRESS, 'sidecar already has an active connection')
      socket.close(1008, 'busy')
      return
    }
    activeSocket = socket
    touch()

    const state: ConnState = { socket, authed: false, turnBusy: false, abort: null }
    states.set(socket, state)

    socket.on('message', (data) => {
      touch()
      void handleMessage(state, data.toString())
    })
    socket.on('close', () => {
      state.abort?.abort()
      states.delete(socket)
      if (activeSocket === socket) activeSocket = null
    })
    socket.on('error', (err) => {
      logger.warn(`socket error: ${err.message}`)
    })

    async function handleMessage (conn: ConnState, raw: string): Promise<void> {
      touch()
      let decoded: unknown
      try {
        decoded = JSON.parse(raw)
      } catch {
        sendError(conn.socket, ErrorCode.BAD_REQUEST, 'frame is not valid JSON')
        return
      }

      const envelope = parseEnvelope(decoded)
      if (!envelope.ok) {
        sendError(conn.socket, ErrorCode.BAD_REQUEST, `bad envelope: ${envelope.error}`)
        return
      }

      const { id, v, type, payload } = envelope.data
      if (v !== protocolVersion) {
        sendError(
          conn.socket,
          ErrorCode.PROTOCOL_VERSION_MISMATCH,
          `server speaks v${protocolVersion}, client sent v${v}`
        )
        conn.socket.close(1002, 'protocol version mismatch')
        return
      }

      if (!conn.authed) {
        await handleHello(conn, type, payload)
        return
      }

      if (!isClientEvent(type)) {
        sendError(conn.socket, ErrorCode.BAD_REQUEST, `unknown event type "${type}"`)
        return
      }

      const validated = validatePayload(type, payload)
      if (!validated.ok) {
        sendError(conn.socket, ErrorCode.BAD_REQUEST, `invalid ${type} payload: ${validated.error}`)
        return
      }

      switch (type) {
        case 'ping':
          send(conn.socket, 'pong', { pingId: id })
          return
        case 'chat.send':
          await handleChatSend(conn, validated.data as { text: string })
          return
        case 'chat.respond':
        case 'chat.cancel':
          sendError(
            conn.socket,
            ErrorCode.NOT_IMPLEMENTED,
            `${type} is scheduled for kip#69`
          )
          return
        case 'undo':
          await handleUndo(conn, validated.data as { sessionId?: string, count?: number })
          return
        default:
          sendError(conn.socket, ErrorCode.BAD_REQUEST, `unhandled event type "${type}"`)
      }
    }

    async function handleHello (conn: ConnState, type: string, payload: unknown): Promise<void> {
      if (type !== 'hello') {
        sendError(conn.socket, ErrorCode.UNAUTHORIZED, 'hello must be the first frame')
        conn.socket.close(1008, 'unauthorized')
        return
      }
      const validated = validatePayload('hello', payload)
      if (!validated.ok) {
        sendError(conn.socket, ErrorCode.BAD_REQUEST, `invalid hello payload: ${validated.error}`)
        conn.socket.close(1008, 'bad hello')
        return
      }
      if (!safeTokenEqual(validated.data.token, options.token)) {
        sendError(conn.socket, ErrorCode.UNAUTHORIZED, 'invalid token')
        conn.socket.close(1008, 'unauthorized')
        return
      }
      conn.authed = true
      send(conn.socket, 'ready', { protocolVersion, sessionId, pid: process.pid })
    }

    // Undo the last N agent commits in the workspace (SPEC-1 FR-18). Scoped to
    // this sidecar session unless the client names another; `count` defaults
    // to 1. A refusal is UNDO_UNAVAILABLE, never a silent no-op.
    async function handleUndo (
      conn: ConnState,
      payload: { sessionId?: string, count?: number }
    ): Promise<void> {
      if (!options.workspaceDir) {
        sendError(conn.socket, ErrorCode.UNDO_UNAVAILABLE, 'no agent workspace is configured')
        return
      }
      try {
        const workspace = new Workspace(options.workspaceDir)
        const result = await workspace.undo({
          sessionId: payload.sessionId ?? sessionId,
          ...(payload.count ? { count: payload.count } : {})
        })
        send(conn.socket, 'undo.applied', {
          revertedSha: result.revertedSha,
          restoredFiles: result.restoredFiles,
          undone: true
        })
      } catch (err) {
        const code = err instanceof WorkspaceError ? err.code : ErrorCode.INTERNAL
        sendError(
          conn.socket,
          code as ErrorCode,
          err instanceof Error ? err.message : String(err)
        )
      }
    }

    async function handleChatSend (
      conn: ConnState,
      payload: { text: string }
    ): Promise<void> {
      if (conn.turnBusy) {
        sendError(conn.socket, ErrorCode.TURN_IN_PROGRESS, 'a turn is already running')
        return
      }
      conn.turnBusy = true
      const controller = new AbortController()
      conn.abort = controller
      const turnId = randomUUID()
      try {
        await runTurn({
          turnId,
          text: payload.text,
          emit: (eventType, eventPayload) => {
            send(conn.socket, eventType as ServerEventType, eventPayload)
          },
          complete: options.complete,
          maxToolCalls: options.maxToolCalls,
          deltaBatchMs: options.deltaBatchMs,
          maxResultChars: options.maxResultChars,
          signal: controller.signal,
          logger
        })
      } catch (err) {
        sendError(
          conn.socket,
          ErrorCode.INTERNAL,
          err instanceof Error ? err.message : String(err)
        )
      } finally {
        conn.turnBusy = false
        conn.abort = null
      }
    }
  }

  wss.on('connection', onConnection)

  await new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve())
    wss.once('error', (err) => reject(err))
  })

  const port = (wss.address() as AddressInfo).port
  logger.info(`listening on ws://127.0.0.1:${port} (protocol v${protocolVersion})`)

  let idleTimer: NodeJS.Timeout | null = null
  if (silenceMs > 0) {
    idleTimer = setInterval(() => {
      if (Date.now() - lastActivity < silenceMs) return
      if (idleTimer) clearInterval(idleTimer)
      idleTimer = null
      logger.info(`no socket traffic for ${silenceMs}ms — shutting down`)
      if (options.onSilence) options.onSilence()
      else for (const client of wss.clients) client.close(1001, 'idle')
    }, idleCheckMs)
    idleTimer.unref()
  }

  const close = async (): Promise<void> => {
    if (idleTimer) {
      clearInterval(idleTimer)
      idleTimer = null
    }
    for (const state of states.values()) state.abort?.abort()
    for (const client of wss.clients) client.close(1001, 'server shutdown')
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  }

  return { port, sessionId, close }
}
