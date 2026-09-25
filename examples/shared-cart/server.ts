// The server half of the pitch demo: `pnpm cart-server`. Hosts the same cart
// definition the tab runs locally, behind the layers docs/hosting.md asks of
// any host that leaves localhost:
//
// - allowedOrigins: only pages this demo serves may open a socket
// - authorize: no valid token, no connection (and no /schema)
// - scope: the server picks whose cart a connection reaches — the userId a
//   client sends in its lookup args is ignored
// - admit: every message is checked and rebuilt before the cart sees it, so a
//   malformed one cannot crash a cart
// - principal: durable callIds are namespaced per user
//
// The tokens below are demo fixtures. A real server resolves its own session:
// a cookie (browsers send it with the upgrade) or a bearer token.

import type { IncomingMessage } from 'node:http'
import { define } from '@nonchalant/core'
import type { Json } from '@nonchalant/core'
import { serve } from '@nonchalant/host'
import { cart } from './shared.ts'

// ---------- sessions ----------

const sessions = new Map([
  ['alice-demo-token', { userId: 'alice' }],
  ['bob-demo-token', { userId: 'bob' }],
])

const sessionOf = (request: IncomingMessage): { userId: string } | undefined =>
  sessions.get(new URL(request.url ?? '/', 'http://localhost').searchParams.get('token') ?? '')

// the dev server's pages; a deployment lists its real origins instead
const loopback = (origin: string | undefined): boolean =>
  origin !== undefined && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)

// ---------- screening ----------

type Wire = { type: string } & { [key: string]: Json }

const text = (v: Json | undefined, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

const admitCart = (msg: Wire): Json | undefined => {
  switch (msg.type) {
    case 'add': {
      const item = msg['item']
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined
      const { name, price } = item
      if (!text(name, 80) || typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 1e6)
        return undefined
      return { type: 'add', item: { name, price } }
    }
    case 'remove':
      return text(msg['name'], 80) ? { type: 'remove', name: msg['name'] } : undefined
    case 'checkout':
      return { type: 'checkout' }
    default:
      return undefined
  }
}

// ---------- the host ----------

const host = await serve({ cart: define(cart, { evict: 60_000 }) }, {
  port: 4321,
  allowedOrigins: loopback,
  authorize: (request) => sessionOf(request) !== undefined,
  scope: (request, reg) => {
    const session = sessionOf(request)
    if (session === undefined) throw new Error('unauthorized') // rejects the upgrade
    return {
      lookup: (name: string) => {
        if (name !== 'cart') throw new Error(`not exposed: ${name}`)
        return reg.lookup('cart', { userId: session.userId })
      },
      admit: (_name, msg) => admitCart(msg),
      principal: session.userId,
    }
  },
  maxWatchesPerConnection: 4,
})
console.log(`nonchalant host on ${host.url}?token=alice-demo-token`)
console.log(`schema at http://127.0.0.1:${host.port}/schema?token=alice-demo-token`)
