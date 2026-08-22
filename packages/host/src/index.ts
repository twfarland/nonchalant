// @nonchalant/host — the Node host (M7): serve a registry schema over real
// WebSockets. Each connection is a session: its own expose() over the shared
// registry, torn down on disconnect (watches release; registry refcounting
// and evict timers reclaim idle processes). Supervision is not a new
// mechanism here — it is M3's restart policies and ownership cascade,
// configured per definition and composed through spawning.
//
// GET /schema serves the name whitelist ({ protocol: 2, names }) — the typed
// contract itself lives in the shared TypeScript schema module; the registry
// rejects lookups outside it either way.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { registry, type Definition, type RegistryHandle } from '@nonchalant/core'
import { expose, type Transport } from '@nonchalant/wire'

export interface ServeOpts {
  /** TCP port; 0 (default) picks an ephemeral one. */
  port?: number
  /** WebSocket path. Default '/'. */
  path?: string
}

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
  opts?: ServeOpts,
): Promise<HostHandle<S>> {
  const reg = registry(defs)
  const names = Object.keys(defs)
  const path = opts?.path ?? '/'

  const http = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/schema') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ protocol: 2, names }))
      return
    }
    res.statusCode = 404
    res.end()
  })
  const wss = new WebSocketServer({ server: http, path })

  const sessions = new Set<() => void>()
  wss.on('connection', (ws) => {
    const stop = expose(reg, wsTransport(ws))
    const cleanup = (): void => {
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
