// End-to-end over real sockets: the Node host serving a registry, clients on
// the reconnecting WebSocket transport. This is also where webSocketTransport
// earns its test coverage (deferred from M6).

import { describe, it, expect } from 'vitest'
import { define, effect } from '@nonchalant/core'
import type { Call, Cast, Definition, Proc } from '@nonchalant/core'
import { connect, webSocketTransport } from '@nonchalant/wire'
import { WebSocket } from 'ws'
import { serve } from '../src/index.ts'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const until = async (cond: () => boolean, tries = 200): Promise<void> => {
  for (let i = 0; i < tries && !cond(); i++) await tick()
  if (!cond()) throw new Error('condition never became true')
}

type CartState = { items: string[]; total: number }
type CartMsg =
  | Cast<{ type: 'add'; item: string; price: number }>
  | Call<{ type: 'checkout' }, { ok: boolean; count: number }>

const cart: Proc<CartState, CartMsg, { userId: string }> = async function* (self) {
  let s: CartState = { items: [], total: 0 }
  yield s
  for await (const msg of self) {
    if (msg.type === 'add') {
      s = { items: [...s.items, msg.item], total: s.total + msg.price }
      yield s
    } else {
      msg.reply({ ok: true, count: s.items.length })
      s = { items: [], total: 0 }
      yield s
    }
  }
}

type Shop = { cart: Definition<CartState, CartMsg, { userId: string }> }

describe('node host over real websockets', () => {
  it('checks browser origins and authorization before accepting a connection', async () => {
    const host = await serve<Shop>(
      { cart: define(cart) },
      {
        allowedOrigins: ['https://shop.example'],
        authorize: async (request) => request.headers.authorization === 'Bearer test-token',
      },
    )

    const status = (headers: Record<string, string>): Promise<number> =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(host.url, { headers })
        let settled = false
        const finish = (code: number): void => {
          if (settled) return
          settled = true
          resolve(code)
        }
        ws.on('open', () => {
          finish(101)
          ws.close()
        })
        ws.on('unexpected-response', (_request, response) => {
          response.resume()
          finish(response.statusCode ?? 0)
        })
        ws.on('error', (error) => {
          if (!settled) reject(error)
        })
      })

    await expect(fetch(`http://127.0.0.1:${host.port}/schema`)).resolves.toHaveProperty('status', 401)
    await expect(
      fetch(`http://127.0.0.1:${host.port}/schema`, {
        headers: { authorization: 'Bearer test-token' },
      }),
    ).resolves.toHaveProperty('status', 200)
    await expect(
      status({ origin: 'https://attacker.example', authorization: 'Bearer test-token' }),
    ).resolves.toBe(403)
    await expect(status({ origin: 'https://shop.example' })).resolves.toBe(401)
    await expect(status({ origin: 'https://shop.example', authorization: 'Bearer test-token' })).resolves.toBe(101)
    await until(() => host.sessions() === 0)
    await host.close()
  })

  it('passes missing origins to a custom origin policy for non-browser clients', async () => {
    let seenOrigin: string | undefined = 'not-called'
    const host = await serve<Shop>(
      { cart: define(cart) },
      {
        allowedOrigins: (origin) => {
          seenOrigin = origin
          return origin === undefined
        },
      },
    )
    const ws = new WebSocket(host.url)
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
    })
    expect(seenOrigin).toBeUndefined()
    ws.close()
    await until(() => host.sessions() === 0)
    await host.close()
  })

  it('serves lookups, casts, calls; sessions share processes; schema endpoint lists names', async () => {
    const host = await serve<Shop>({ cart: define(cart) })

    // schema serving: the name whitelist
    const schema = (await (await fetch(`http://127.0.0.1:${host.port}/schema`)).json()) as {
      protocol: number
      names: string[]
    }
    expect(schema).toStrictEqual({ protocol: 2, names: ['cart'] })

    const t1 = webSocketTransport(host.url)
    const t2 = webSocketTransport(host.url)
    const c1 = connect<Shop>(t1)
    const c2 = connect<Shop>(t2)
    const cartA = c1.lookup('cart', { userId: 'u1' })
    const cartB = c2.lookup('cart', { userId: 'u1' })

    await until(() => cartA() !== undefined && cartB() !== undefined)
    expect(host.sessions()).toBe(2)

    // a cast from one tab is visible in the other — same named process
    cartA.cast({ type: 'add', item: 'boots', price: 120 })
    await until(() => cartB()?.total === 120)
    expect(cartB()?.items).toEqual(['boots'])

    // call round-trips over the socket
    await expect(cartA.call({ type: 'checkout' })).resolves.toStrictEqual({ ok: true, count: 1 })
    await until(() => cartB()?.total === 0)

    // remote reads stay path-precise across a real socket
    let itemRuns = 0
    const stop = effect(() => {
      itemRuns++
      void cartB()?.items.length
    })
    cartA.cast({ type: 'add', item: 'hat', price: 5 }) // touches items AND total
    await until(() => cartB()?.total === 5)
    const runsAfterAdd = itemRuns
    expect(runsAfterAdd).toBeGreaterThan(1)
    stop()

    c1.close()
    c2.close()
    t1.close()
    t2.close()
    await until(() => host.sessions() === 0)
    await host.close()
  }, 15000)

  it('disconnect marks readers stale; the host session is reclaimed', async () => {
    const host = await serve<Shop>({ cart: define(cart) })
    const t = webSocketTransport(host.url)
    const conn = connect<Shop>(t)
    const rcart = conn.lookup('cart', { userId: 'u2' })
    await until(() => rcart() !== undefined)
    expect(host.sessions()).toBe(1)

    t.close() // simulate the tab losing its connection for good
    await until(() => rcart.stale)
    expect(rcart()).toStrictEqual({ items: [], total: 0 }) // value survives the partition
    await until(() => host.sessions() === 0)

    conn.close()
    await host.close()
  }, 15000)

  it('scope gives each connection its own lookup gateway closed over the request', async () => {
    const host = await serve<Shop>(
      { cart: define(cart) },
      {
        scope: (request, reg) => {
          // identity comes from the handshake — a client cannot name another
          // user's cart, whatever arguments it sends
          const userId = new URL(request.url ?? '/', 'http://localhost').searchParams.get('user') ?? 'anonymous'
          return {
            lookup: (name) => {
              if (name !== 'cart') throw new Error(`not exposed: ${name}`)
              return reg.lookup('cart', { userId })
            },
          }
        },
      },
    )

    const t1 = webSocketTransport(`${host.url}?user=alice`)
    const t2 = webSocketTransport(`${host.url}?user=bob`)
    const t3 = webSocketTransport(`${host.url}?user=alice`)
    const c1 = connect<Shop>(t1)
    const c2 = connect<Shop>(t2)
    const c3 = connect<Shop>(t3)
    // all three send the same args; the server-side scope decides what they reach
    const cartA = c1.lookup('cart', { userId: 'ignored' })
    const cartB = c2.lookup('cart', { userId: 'ignored' })
    const cartA2 = c3.lookup('cart', { userId: 'ignored' })
    await until(() => cartA() !== undefined && cartB() !== undefined && cartA2() !== undefined)

    cartA.cast({ type: 'add', item: 'boots', price: 120 })
    await until(() => cartA2()?.total === 120) // same identity, same process
    expect(cartB()?.items).toEqual([]) // another identity never sees it

    // a name outside the gateway raises to that client only
    const bad = (c1 as unknown as { lookup(name: string): { error: unknown } }).lookup('other')
    await until(() => bad.error !== undefined)

    c1.close()
    c2.close()
    c3.close()
    t1.close()
    t2.close()
    t3.close()
    await until(() => host.sessions() === 0)
    await host.close()
  }, 15000)

  it('maxWatchesPerConnection raises past the cap without touching existing watches', async () => {
    const host = await serve<Shop>({ cart: define(cart) }, { maxWatchesPerConnection: 1 })
    const t = webSocketTransport(host.url)
    const conn = connect<Shop>(t)
    const first = conn.lookup('cart', { userId: 'w1' })
    await until(() => first() !== undefined)
    const second = conn.lookup('cart', { userId: 'w2' })
    await until(() => second.error !== undefined)
    expect(first()).toBeDefined()
    conn.close()
    t.close()
    await until(() => host.sessions() === 0)
    await host.close()
  }, 15000)

  it('heartbeat leaves responsive connections alone and reclaims half-open ones', async () => {
    const host = await serve<Shop>({ cart: define(cart) }, { heartbeatMs: 40 })
    const t = webSocketTransport(host.url)
    const conn = connect<Shop>(t)
    const rcart = conn.lookup('cart', { userId: 'hb' })
    await until(() => rcart() !== undefined)
    await new Promise((resolve) => setTimeout(resolve, 200)) // several ping rounds
    expect(host.sessions()).toBe(1) // pongs keep a live connection open

    // a peer that stops reading never sees pings, so it never pongs
    const halfOpen = new WebSocket(host.url)
    await new Promise<void>((resolve) => halfOpen.on('open', () => resolve()))
    await until(() => host.sessions() === 2)
    ;(halfOpen as unknown as { _socket: { pause(): void } })._socket.pause()
    await until(() => host.sessions() === 1)
    halfOpen.terminate()

    conn.close()
    t.close()
    await until(() => host.sessions() === 0)
    await host.close()
  }, 15000)

  it('a message over maxPayloadBytes closes the connection with 1009', async () => {
    const host = await serve<Shop>({ cart: define(cart) }, { maxPayloadBytes: 1024 })
    const ws = new WebSocket(host.url)
    await new Promise<void>((resolve) => ws.on('open', resolve))
    const closed = new Promise<number>((resolve) => ws.on('close', resolve))
    ws.on('error', () => {}) // ws surfaces the payload violation as an error before closing
    ws.send('x'.repeat(4096))
    expect(await closed).toBe(1009)
    await host.close()
  }, 15000)
})
