// The WebSocket surface: bind 127.0.0.1 only, authenticate the first frame
// (hello/ready), then route catalogued events to the real turn loop. The server
// owns the wire; process lifecycle (signals, parent death, the idle timeout)
// lives in index.ts, which the silence hook below calls back into.
//
// Since kip#94 this dispatches through `session/loop.ts`'s `TurnLoop` — the
// implementation every P1–P7 tool was built against — and never the retired P1
// stub. `session/llm-client.ts` bridges the BYOK text client to the loop;
// `server/turn-events.ts` maps the loop's events onto the wire.

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
import { ProtocolError, type TurnEvent } from '../protocol.ts'
import { TurnLoop, type LlmClient, type LlmMessage, type Tool } from '../session/loop.ts'
import { createReActLlmClient, type CompleteFn } from '../session/llm-client.ts'
import { createDefaultTools } from '../session/default-tools.ts'
import { TurnEventTranslator } from './turn-events.ts'
import { UndoUnavailableError, undo, workspacePaths } from '../workspace/git.ts'
import { silentLogger, type Logger } from '../logger.ts'

export interface SidecarServerOptions {
  token: string
  /** The BYOK text-completion seam. Wrapped as the loop's `LlmClient` unless
   *  `llm` is supplied directly (tests inject a scripted client this way). */
  complete?: CompleteFn
  /** An already-built loop client; wins over `complete`. */
  llm?: LlmClient
  /** Override the tool set (tests, or a future capability gate). */
  tools?: Tool[]
  /** The coop whose git-versioned `nest/` workspace undo operates on, and whose
   *  notes/skills the default tool set binds to. */
  vaultRoot?: string
  port?: number
  protocolVersion?: number
  maxToolCalls?: number
  maxResultChars?: number
  /** Hard ceiling for a cancel to unwind the loop (loop.ts cancelTimeoutMs). */
  cancelTimeoutMs?: number
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
  loop: TurnLoop
  translator: TurnEventTranslator
}

/** The validated `chat.send` payload (server/protocol.ts). `arenaCompareTo` is
 *  listed so the descope is explicit at the dispatch site; ws.ts deliberately
 *  does not act on it yet (see the schema comment in protocol.ts and kip#98). */
interface ChatSendPayload {
  text: string
  history?: Array<{ role: 'user' | 'assistant', text: string }>
  depth?: 'quick' | 'full'
  arenaCompareTo?: string
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

/** The loop already speaks these codes; the wire only catalogues two of them
 *  plus TURN_IN_PROGRESS. Anything else is an internal failure. */
function protocolErrorCode (error: unknown): ErrorCode {
  if (error instanceof ProtocolError) {
    if (error.code === 'TURN_NOT_FOUND') return ErrorCode.TURN_NOT_FOUND
    if (error.code === 'NO_PENDING_ASK') return ErrorCode.NO_PENDING_ASK
    if (error.code === 'TURN_ALREADY_RUNNING') return ErrorCode.TURN_IN_PROGRESS
  }
  return ErrorCode.INTERNAL
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

  const llm = options.llm ?? (options.complete ? createReActLlmClient(options.complete) : null)
  if (!llm) throw new Error('startSidecarServer requires either `llm` or `complete`')

  const tools = options.tools ?? (
    options.vaultRoot
      ? createDefaultTools({ vaultRoot: options.vaultRoot, ...(options.complete ? { complete: options.complete } : {}) })
      : []
  )
  logger.info(`turn loop wired with ${tools.length} tool(s): ${tools.map((tool) => tool.spec.name).join(', ')}`)

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

    const translator = new TurnEventTranslator()
    const loop = new TurnLoop({
      llm,
      tools,
      emit: (event: TurnEvent) => {
        const wire = translator.translate(event)
        if (wire) send(socket, wire.type, wire.payload)
      },
      maxToolCalls: options.maxToolCalls,
      clientResultCharLimit: options.maxResultChars,
      cancelTimeoutMs: options.cancelTimeoutMs
    })
    const state: ConnState = { socket, authed: false, loop, translator }
    states.set(socket, state)

    socket.on('message', (data) => {
      touch()
      void handleMessage(state, data.toString())
    })
    socket.on('close', () => {
      const turnId = state.loop.activeTurnId()
      if (turnId) void state.loop.cancel(turnId).catch(() => {})
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
          await handleChatSend(conn, validated.data as ChatSendPayload)
          return
        case 'chat.respond':
          handleChatRespond(conn, validated.data as { toolCallId: string, value: string })
          return
        case 'chat.cancel':
          await handleChatCancel(conn, validated.data as { turnId?: string })
          return
        case 'undo':
          await handleUndo(conn, validated.data as { count?: number })
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

    // Undo the last N agent commits in the workspace (SPEC-1 FR-18); `count`
    // defaults to 1. A refusal is UNDO_UNAVAILABLE, never a silent no-op.
    async function handleUndo (
      conn: ConnState,
      payload: { count?: number }
    ): Promise<void> {
      if (!options.vaultRoot) {
        sendError(conn.socket, ErrorCode.UNDO_UNAVAILABLE, 'no agent workspace is configured')
        return
      }
      try {
        const result = await undo(workspacePaths(options.vaultRoot), { count: payload.count ?? 1 })
        send(conn.socket, 'undo.applied', {
          revertedSha: result.revertedSha,
          restoredFiles: result.restoredFiles,
          undone: true
        })
      } catch (err) {
        const code = err instanceof UndoUnavailableError ? err.code : ErrorCode.INTERNAL
        sendError(
          conn.socket,
          code as ErrorCode,
          err instanceof Error ? err.message : String(err)
        )
      }
    }

    // Fold the client-resent history into this turn's seed messages (kip#97),
    // and give `depth: "quick"` a real per-turn effect by offering only the
    // non-skill (nest) tools. `arenaCompareTo` is deliberately descoped: it is
    // parsed off the wire and ignored until the managed arena path is ported
    // (see the schema comment in server/protocol.ts).
    async function handleChatSend (
      conn: ConnState,
      payload: ChatSendPayload
    ): Promise<void> {
      const history: LlmMessage[] | undefined = payload.history?.map((turn) =>
        turn.role === 'user'
          ? { role: 'user', content: turn.text }
          : { role: 'assistant', content: turn.text }
      )
      const turnTools = payload.depth === 'quick'
        ? tools.filter((tool) => tool.kind !== 'skill')
        : undefined
      try {
        await conn.loop.start(sessionId, payload.text, {
          ...(history && history.length > 0 ? { history } : {}),
          ...(turnTools ? { tools: turnTools } : {})
        })
      } catch (err) {
        sendError(
          conn.socket,
          protocolErrorCode(err),
          err instanceof Error ? err.message : String(err)
        )
      }
    }

    // A `chat.respond` only resumes the matching suspended `ask_user`; a stray
    // one is NO_PENDING_ASK / TURN_NOT_FOUND from the loop, never a silent drop.
    function handleChatRespond (
      conn: ConnState,
      payload: { toolCallId: string, value: string }
    ): void {
      try {
        conn.loop.respond(payload.toolCallId, payload.value)
      } catch (err) {
        sendError(
          conn.socket,
          protocolErrorCode(err),
          err instanceof Error ? err.message : String(err)
        )
      }
    }

    // `chat.cancel` aborts the in-flight turn (the only one a connection can
    // have); `turnId` is optional, so a client that never saw `turn.start` can
    // still cancel. `cancel` already waits out the loop's ≤1s cancel budget.
    async function handleChatCancel (
      conn: ConnState,
      payload: { turnId?: string }
    ): Promise<void> {
      const turnId = payload.turnId ?? conn.loop.activeTurnId()
      if (!turnId) {
        sendError(conn.socket, ErrorCode.TURN_NOT_FOUND, 'no active turn to cancel')
        return
      }
      try {
        await conn.loop.cancel(turnId)
      } catch (err) {
        sendError(
          conn.socket,
          protocolErrorCode(err),
          err instanceof Error ? err.message : String(err)
        )
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
    for (const state of states.values()) {
      const turnId = state.loop.activeTurnId()
      if (turnId) void state.loop.cancel(turnId).catch(() => {})
    }
    for (const client of wss.clients) client.close(1001, 'server shutdown')
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  }

  return { port, sessionId, close }
}
