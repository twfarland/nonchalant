// Real transports. Both use host globals present in browsers and Node ≥20
// (WebSocket in Node ≥21) — reached through globalThis so this module stays
// importable anywhere and fails only when actually used without support.

import type { Transport, TransportHandlers } from './transport.ts'

interface WebSocketLike {
  readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void
}

export interface WebSocketTransportOpts {
  /** Base delay between reconnect attempts in ms (doubles up to 8x, jittered to 50–100%). Default 500. */
  retryDelay?: number
}

/**
 * A reconnecting WebSocket transport. Outbound messages while disconnected are
 * dropped (the protocol's reconnect story is re-lookup + full patch, not
 * replay); `open` fires on every (re)connection so connect() re-issues lookups.
 */
export function webSocketTransport(url: string, opts?: WebSocketTransportOpts): Transport & { close(): void } {
  const WS = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket
  if (WS === undefined) throw new Error('nonchalant/wire: no WebSocket global in this environment')
  const baseDelay = opts?.retryDelay ?? 500
  let handlers: TransportHandlers | null = null
  let ws: WebSocketLike | null = null
  let closed = false
  let attempts = 0

  const dial = (): void => {
    if (closed) return
    const sock = new WS(url)
    ws = sock
    sock.addEventListener('open', () => {
      attempts = 0
      handlers?.open?.()
    })
    sock.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') handlers?.message(ev.data)
    })
    sock.addEventListener('close', () => {
      if (ws !== sock) return
      ws = null
      handlers?.close?.()
      if (!closed) {
        // jitter (50–100% of the backoff step) keeps a fleet of clients from
        // redialing in lockstep when a host restarts
        const delay = baseDelay * Math.min(8, 2 ** attempts++) * (0.5 + Math.random() / 2)
        setTimeout(dial, delay)
      }
    })
  }
  dial()

  return {
    send: (data) => {
      if (ws !== null && ws.readyState === 1) ws.send(data)
    },
    subscribe: (h) => {
      handlers = h
      if (ws !== null && ws.readyState === 1) queueMicrotask(() => h.open?.())
      return () => {
        if (handlers === h) handlers = null
      }
    },
    close: () => {
      closed = true
      // do not null ws here: the socket's own close event must still reach
      // the handlers (it clears ws and notifies subscribers)
      ws?.close()
    },
  }
}

interface BroadcastChannelLike {
  postMessage(data: unknown): void
  close(): void
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void
}

// A host that (re)starts on a bus posts this so peers treat it as a fresh
// connection and re-issue their lookups (answered with full snapshots).
const ANNOUNCE = 'nonchalant:announce'

/**
 * A BroadcastChannel bus transport (multi-tab). Every peer hears every
 * message; the codec's direction filtering and per-session refs make that
 * safe. One tab plays host (expose), the rest connect. A host should call
 * `announce()` once it is serving — subscribers see it as an `open`, so
 * clients that started first (or lost a previous host) look their processes
 * up again.
 */
export function broadcastChannelTransport(
  name: string,
): Transport & { close(): void; announce(): void } {
  const BC = (globalThis as { BroadcastChannel?: new (name: string) => BroadcastChannelLike }).BroadcastChannel
  if (BC === undefined) throw new Error('nonchalant/wire: no BroadcastChannel global in this environment')
  const ch = new BC(name)
  let handlers: TransportHandlers | null = null
  ch.addEventListener('message', (ev) => {
    if (typeof ev.data !== 'string') return
    if (ev.data === ANNOUNCE) handlers?.open?.()
    else handlers?.message(ev.data)
  })
  return {
    send: (data) => ch.postMessage(data),
    subscribe: (h) => {
      handlers = h
      queueMicrotask(() => h.open?.())
      return () => {
        if (handlers === h) handlers = null
      }
    },
    announce: () => ch.postMessage(ANNOUNCE),
    close: () => ch.close(),
  }
}

/** The postMessage surface shared by a Worker, a MessagePort, and a worker's own global scope. */
export interface MessageEndpoint {
  postMessage(data: unknown): void
  addEventListener(type: 'message', fn: (ev: { data?: unknown }) => void): void
  /** A MessagePort stays silent until started; a Worker has no such method. */
  start?(): void
}

/**
 * A transport over an already-connected port: `new Worker(...)` and a
 * `MessagePort` on one side, the worker's own global on the other. It takes
 * the endpoint rather than making one, so it is equally at home on
 * `worker_threads`' `parentPort`.
 *
 * No reconnect story and no announce: a port does not drop, and messages
 * posted before the worker has evaluated its script are queued, not lost.
 */
export function portTransport(port: MessageEndpoint): Transport {
  let handlers: TransportHandlers | null = null
  port.addEventListener('message', (ev) => {
    if (typeof ev.data !== 'string') return // not ours: other postMessage traffic on the same port
    handlers?.message(ev.data)
  })
  port.start?.()
  return {
    send: (data) => port.postMessage(data),
    subscribe: (h) => {
      handlers = h
      queueMicrotask(() => h.open?.())
      return () => {
        if (handlers === h) handlers = null
      }
    },
  }
}

/**
 * Inside a browser Worker the global scope is the port back to whoever spawned
 * it (TypeScript's DOM lib types `self` as a Window, hence this). In Node's
 * worker_threads it is `parentPort` instead — pass that to portTransport.
 */
export function workerEndpoint(): MessageEndpoint {
  return globalThis as unknown as MessageEndpoint
}
