// The Node host serves a registry over WebSockets. Each connection gets its
// own expose() session — over the shared registry, or over the Exposable the
// `scope` option builds for that connection — and is torn down on disconnect.
// Watches release, then registry reference counts and eviction timers reclaim
// idle processes.
//
// GET /schema serves the name whitelist ({ protocol: 3, names }) — the typed
// contract itself lives in the shared TypeScript schema module; the registry
// rejects lookups outside it either way.
//
// Every connection is a principal: the one its scope names, or else one of its
// own. Client-chosen callIds are namespaced by it (see Exposable.principal).
// Lookup buckets are per client, not per connection (rate.ts).

import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { registry, type Definition } from '@nonchalant/core'
import type { Exposable } from '@nonchalant/wire'
import { rejectUpgrade, schemaRoute, screenUpgrade } from './http.ts'
import { resolveLimits } from './options.ts'
import { bucket, clientKey, keyedBuckets } from './rate.ts'
import { openSession, sessionGate } from './session.ts'
import type { HostHandle, ServeOpts } from './types.ts'

export type { HostHandle, OriginPolicy, RateLimit, ServeOpts } from './types.ts'

/** Start hosting `defs` over WebSockets. Resolves once listening. */
export async function serve<S extends { [K in keyof S]: Definition<unknown, unknown, unknown> }>(
  defs: S,
  opts?: ServeOpts<S>,
): Promise<HostHandle<S>> {
  const limits = resolveLimits(opts)
  const reg = registry(defs, { maxEntries: limits.maxEntries })
  const takeClient = keyedBuckets(limits.lookupRate)
  const takeTotal = bucket(limits.totalRate)
  const path = opts?.path ?? '/'
  const authorize = async (request: IncomingMessage): Promise<boolean> =>
    opts?.authorize === undefined || await opts.authorize(request)
  // resolved during the upgrade (before any frame can arrive) so an async
  // scope factory can never lose a client's first lookup
  const scopes = new WeakMap<IncomingMessage, Exposable>()

  const http = createServer(schemaRoute(Object.keys(defs), authorize))
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts?.maxPayloadBytes ?? 1 << 20 })

  http.on('upgrade', (request, socket, head) => {
    void (async () => {
      const refused = await screenUpgrade(request, path, opts?.allowedOrigins, authorize)
      if (refused !== undefined) {
        rejectUpgrade(socket, refused)
        return
      }
      if (opts?.scope !== undefined) scopes.set(request, await opts.scope(request, reg))
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request))
    })().catch(() => rejectUpgrade(socket, 500))
  })

  const sessions = new Set<() => void>()
  wss.on('connection', (ws, request) => {
    const gate: Exposable = scopes.get(request) ?? reg
    const key = clientKey(gate.principal, request.socket.remoteAddress)
    const takeOwn = key === undefined ? bucket(limits.lookupRate) : () => takeClient(key, Date.now())
    const session = sessionGate(gate, takeOwn, takeTotal)
    openSession(ws, session, limits, sessions)
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
