// The Node host serves a registry over WebSockets. Each connection gets its
// own expose() session — over the shared registry, or over the Exposable the
// `scope` option builds for that connection — and is torn down on disconnect.
// Watches release, then registry reference counts and eviction timers reclaim
// idle processes.
//
// GET /schema serves the name whitelist ({ protocol: 2, names }) — the typed
// contract itself lives in the shared TypeScript schema module; the registry
// rejects lookups outside it either way.

import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { registry, type Definition, type RegistryHandle } from '@nonchalant/core'
import { expose, type Exposable, type Transport } from '@nonchalant/wire'

export interface ServeOpts<S extends { [K in keyof S]: Definition<unknown, unknown, unknown> }> {
  /** TCP port; 0 (default) picks an ephemeral one. */
  port?: number
  /** WebSocket path. Default '/'. */
  path?: string
  /** Largest accepted client message in bytes; oversize closes the connection (ws code 1009). Default 1 MiB. */
  maxPayloadBytes?: number
  /** Browser origins allowed to open a WebSocket. An array rejects clients with no Origin header. */
  allowedOrigins?: readonly string[] | OriginPolicy
  /** Authenticate the schema request and WebSocket upgrade. Omit only for trusted/local use. */
  authorize?: (request: IncomingMessage) => boolean | Promise<boolean>
  /**
   * Build the Exposable this connection's lookups go through. Runs once per
   * accepted connection, after `authorize`, before any message is served —
   * closing over the request is how a session scopes, quotas, or audits
   * lookups without the host knowing what a session is. Throwing rejects the
   * upgrade (500). Default: every connection shares the registry unscoped.
   */
  scope?: (request: IncomingMessage, reg: RegistryHandle<S>) => Exposable | Promise<Exposable>
  /** Cap on concurrently watched refs per connection; a lookup past it raises to that client. Omit for no cap. */
  maxWatchesPerConnection?: number
  /**
   * Ping each socket at this interval (ms) and terminate it after a missed
   * pong, so half-open connections release their watches. Omit to disable.
   */
  heartbeatMs?: number
}

export type OriginPolicy = (
  origin: string | undefined,
  request: IncomingMessage,
) => boolean | Promise<boolean>

export interface HostHandle<S extends { [K in keyof S]: Definition<unknown, unknown, unknown> }> {
  /** Host-side access to the same processes clients see. */
  registry: RegistryHandle<S>
  port: number
  url: string
  /** Live session (connection) count. */
  sessions(): number
  close(): Promise<void>
}

const wsTransport = (ws: WebSocket): Transport => ({
  send: (data) => {
    if (ws.readyState === ws.OPEN) ws.send(data)
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

/** Start hosting `defs` over WebSockets. Resolves once listening. */
export async function serve<S extends { [K in keyof S]: Definition<unknown, unknown, unknown> }>(
  defs: S,
  opts?: ServeOpts<S>,
): Promise<HostHandle<S>> {
  const heartbeatMs = opts?.heartbeatMs
  if (heartbeatMs !== undefined && (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0))
    throw new Error('nonchalant/host: heartbeatMs must be a positive duration')
  const maxWatches = opts?.maxWatchesPerConnection
  if (maxWatches !== undefined && (!Number.isInteger(maxWatches) || maxWatches < 0))
    throw new Error('nonchalant/host: maxWatchesPerConnection must be a non-negative integer')

  const reg = registry(defs)
  const names = Object.keys(defs)
  const path = opts?.path ?? '/'
  const authorize = async (request: IncomingMessage): Promise<boolean> =>
    opts?.authorize === undefined || await opts.authorize(request)
  // resolved during the upgrade (before any frame can arrive) so an async
  // scope factory can never lose a client's first lookup
  const scopes = new WeakMap<IncomingMessage, Exposable>()

  const http = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && req.url === '/schema') {
        if (!await authorize(req)) {
          res.statusCode = 401
          res.end()
          return
        }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ protocol: 2, names }))
        return
      }
      res.statusCode = 404
      res.end()
    })().catch(() => {
      res.statusCode = 500
      res.end()
    })
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts?.maxPayloadBytes ?? 1 << 20 })

  const rejectUpgrade = (socket: Duplex, status: 401 | 403 | 404 | 500): void => {
    if (socket.destroyed) return
    const reason =
      status === 401
        ? 'Unauthorized'
        : status === 403
          ? 'Forbidden'
          : status === 404
            ? 'Not Found'
            : 'Internal Server Error'
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    socket.destroy()
  }

  http.on('upgrade', (request, socket, head) => {
    void (async () => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      if (pathname !== path) {
        rejectUpgrade(socket, 404)
        return
      }
      const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined
      const policy = opts?.allowedOrigins
      const originAllowed =
        policy === undefined
          ? true
          : typeof policy === 'function'
            ? await policy(origin, request)
            : origin !== undefined && policy.includes(origin)
      if (!originAllowed) {
        rejectUpgrade(socket, 403)
        return
      }
      if (!await authorize(request)) {
        rejectUpgrade(socket, 401)
        return
      }
      if (opts?.scope !== undefined) scopes.set(request, await opts.scope(request, reg))
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request))
    })().catch(() => rejectUpgrade(socket, 500))
  })

  const sessions = new Set<() => void>()
  wss.on('connection', (ws, request) => {
    // a client protocol violation (oversize payload, bad frame) must drop that
    // connection, not crash the host via an unhandled 'error' event
    ws.on('error', () => ws.terminate())
    const stop = expose(
      scopes.get(request) ?? reg,
      wsTransport(ws),
      maxWatches === undefined ? undefined : { maxWatches },
    )
    let heartbeat: ReturnType<typeof setInterval> | undefined
    if (heartbeatMs !== undefined) {
      let alive = true
      ws.on('pong', () => {
        alive = true
      })
      heartbeat = setInterval(() => {
        if (!alive) {
          ws.terminate() // fires 'close', which runs cleanup
          return
        }
        alive = false
        ws.ping()
      }, heartbeatMs)
    }
    const cleanup = (): void => {
      if (heartbeat !== undefined) clearInterval(heartbeat)
      sessions.delete(cleanup)
      stop()
    }
    sessions.add(cleanup)
    ws.on('close', cleanup)
  })

  await new Promise<void>((resolve) => http.listen(opts?.port ?? 0, resolve))
  const port = (http.address() as AddressInfo).port

  return {
    registry: reg,
    port,
    url: `ws://127.0.0.1:${port}${path}`,
    sessions: () => sessions.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const cleanup of [...sessions]) cleanup()
        for (const client of wss.clients) client.terminate()
        wss.close(() => {
          http.close(() => resolve())
        })
      }),
  }
}
