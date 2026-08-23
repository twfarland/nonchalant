// A postMessage transport as a userland construct — Worker, MessagePort, or a
// worker's own global scope, ~20 lines. Nothing in the wire assumes a network:
// a transport is send + subscribe over anything ordered and reliable, and the
// port between two threads is both. Used by `examples/worker`.

import type { Transport, TransportHandlers } from '@nonchalant/wire'

/** The postMessage surface shared by Worker, MessagePort, and a worker global. */
export interface Endpoint {
  postMessage(data: unknown): void
  addEventListener(type: 'message', fn: (ev: { data?: unknown }) => void): void
  /** A MessagePort stays silent until started; a Worker has no such method. */
  start?(): void
}

/** Both halves of the wire use the same one — `expose` in the worker, `connect` in the tab. */
export function portTransport(port: Endpoint): Transport {
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
      // a port never drops what it is sent: messages posted before the worker
      // has evaluated its script are queued, so open is immediate and final —
      // no reconnect story, no announce
      queueMicrotask(() => h.open?.())
      return () => {
        if (handlers === h) handlers = null
      }
    },
  }
}

/** Inside a worker the global scope is the port. TypeScript's DOM lib types `self` as a Window; this is the one cast. */
export function workerEndpoint(): Endpoint {
  return globalThis as unknown as Endpoint
}
