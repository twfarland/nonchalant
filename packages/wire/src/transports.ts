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
  /** Base delay between reconnect attempts in ms (doubles up to 8x). Default 500. */
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
        const delay = baseDelay * Math.min(8, 2 ** attempts++)
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

/**
 * A BroadcastChannel bus transport (multi-tab). Every peer hears every
 * message; the codec's direction filtering and per-session refs make that
 * safe. One tab plays host (expose), the rest connect.
 */
export function broadcastChannelTransport(name: string): Transport & { close(): void } {
  const BC = (globalThis as { BroadcastChannel?: new (name: string) => BroadcastChannelLike }).BroadcastChannel
  if (BC === undefined) throw new Error('nonchalant/wire: no BroadcastChannel global in this environment')
  const ch = new BC(name)
  let handlers: TransportHandlers | null = null
  ch.addEventListener('message', (ev) => {
    if (typeof ev.data === 'string') handlers?.message(ev.data)
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
    close: () => ch.close(),
  }
}
