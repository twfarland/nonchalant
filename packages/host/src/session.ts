// One accepted WebSocket = one expose() session: the socket as a transport
// with backpressure, the lookup path through the per-client and host-wide
// buckets, and the heartbeat that reclaims half-open connections.

import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import { expose, type Exposable, type Transport } from '@nonchalant/wire'

export const wsTransport = (ws: WebSocket, maxBuffered: number): Transport => ({
  send: (data) => {
    if (ws.readyState !== ws.OPEN) return
    if (ws.bufferedAmount > maxBuffered) ws.terminate() // fires 'close', which runs cleanup
    else ws.send(data)
  },
  subscribe: (handlers) => {
    const onMessage = (data: unknown): void => handlers.message(String(data))
    const onClose = (): void => handlers.close?.()
    ws.on('message', onMessage)
    ws.on('close', onClose)
    queueMicrotask(() => handlers.open?.())
    return () => {
      ws.off('message', onMessage)
      ws.off('close', onClose)
    }
  },
})

/** Ping every `ms`; a socket that missed the last pong is terminated. Returns the stopper. */
export const heartbeat = (ws: WebSocket, ms: number): (() => void) => {
  let alive = true
  ws.on('pong', () => {
    alive = true
  })
  const timer = setInterval(() => {
    if (!alive) {
      ws.terminate() // fires 'close', which runs cleanup
      return
    }
    alive = false
    ws.ping()
  }, ms)
  return () => clearInterval(timer)
}

/**
 * The Exposable a connection's expose() serves: `gate`'s lookups behind this
 * client's bucket and then the host-wide one, and a principal for every
 * connection — the gate's, or else one of its own.
 */
export const sessionGate = (
  gate: Exposable,
  takeClient: () => boolean,
  takeTotal: () => boolean,
): Exposable => {
  const session: Exposable = {
    lookup: (name, ...args) => {
      if (!takeClient()) throw new Error('lookup rate exceeded')
      if (!takeTotal()) throw new Error('host lookup rate exceeded')
      return gate.lookup(name, ...args)
    },
    principal: gate.principal ?? randomUUID(),
  }
  const admit = gate.admit?.bind(gate)
  if (admit !== undefined) session.admit = admit
  return session
}

export interface SessionOpts {
  maxBuffered: number
  maxWatches: number | undefined
  heartbeatMs: number
}

/** Serve `session` on `ws` until it closes. Its cleanup is in `live` exactly while it runs. */
export function openSession(ws: WebSocket, session: Exposable, opts: SessionOpts, live: Set<() => void>): void {
  // a client protocol violation (oversize payload, bad frame) must drop that
  // connection, not crash the host via an unhandled 'error' event
  ws.on('error', () => ws.terminate())
  const stop = expose(session, wsTransport(ws, opts.maxBuffered), opts.maxWatches === undefined ? {} : { maxWatches: opts.maxWatches })
  const stopBeat = opts.heartbeatMs > 0 ? heartbeat(ws, opts.heartbeatMs) : undefined
  const cleanup = (): void => {
    stopBeat?.()
    live.delete(cleanup)
    stop()
  }
  live.add(cleanup)
  ws.on('close', cleanup)
}
