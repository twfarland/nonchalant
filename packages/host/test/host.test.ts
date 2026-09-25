// End-to-end over real sockets: the Node host serving a registry, clients on
// the reconnecting WebSocket transport. This is also where webSocketTransport
// earns its test coverage (deferred from M6).

import { describe, it, expect, vi } from 'vitest'
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

// Resolves once the host has answered a frame sent now. Frames on one socket
// arrive in order, so anything this socket sent earlier (a pong, say) has been
// handled by then. The probe is a call on a ref nobody watches: it costs no
// lookup and the host answers it at once.
let probes = 0
const roundTrip = (ws: WebSocket): Promise<void> =>
  new Promise((resolve) => {
    const ref = `probe-${++probes}`
    const onMessage = (data: unknown): void => {
      if ((JSON.parse(String(data)) as { ref?: string }).ref !== ref) return
      ws.off('message', onMessage)
      resolve()
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ op: 'call', ref, id: 1, msg: { type: 'probe' } }))
  })

type CartState = { items: string[]; total: number }
type CartMsg =
  | Cast<{ type: 'add'; item: string; price: number }>
  | Call<{ type: 'checkout' }, { ok: boolean; count: number }>

const cart: Proc<CartState, CartMsg, { userId: string }> = async function* (self) {
  let s: CartState = { items: [], total: 0 }
  yield s
  for await (const msg of self) {
    switch (msg.type) {
      case 'add':
        s = { items: [...s.items, msg.item], total: s.total + msg.price }
        yield s
        break
      case 'checkout':
        msg.reply({ ok: true, count: s.items.length })
        s = { items: [], total: 0 }
        yield s
        break
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
    expect(schema).toStrictEqual({ protocol: 3, names: ['cart'] })

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
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const host = await serve<Shop>({ cart: define(cart) }, { heartbeatMs: 1_000 })
      const live = new WebSocket(host.url)
      const halfOpen = new WebSocket(host.url)
      await Promise.all([live, halfOpen].map((ws) => new Promise((resolve) => ws.on('open', resolve))))
      await until(() => host.sessions() === 2)
      let pongs = 0
      live.on('ping', () => pongs++)
      // a peer that stops reading never sees pings, so it never pongs
      ;(halfOpen as unknown as { _socket: { pause(): void } })._socket.pause()

      vi.advanceTimersByTime(1_000) // round 1: both pinged
      await until(() => pongs === 1)
      await roundTrip(live) // the pong is on the wire ahead of this, so the host has it
      vi.advanceTimersByTime(1_000) // round 2: the silent one missed its pong
      await until(() => host.sessions() === 1)
      await until(() => pongs === 2)
      await roundTrip(live)
      vi.advanceTimersByTime(1_000) // round 3: the live one answered, so it stays
      await until(() => pongs === 3)
      expect(host.sessions()).toBe(1)

      halfOpen.terminate()
      live.close()
      await until(() => host.sessions() === 0)
      await host.close()
    } finally {
      vi.useRealTimers()
    }
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

// ---------- hardening: options, status codes, backpressure, principals ----------

const handshake = (url: string, headers: Record<string, string> = {}): Promise<number> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers })
    ws.on('open', () => {
      resolve(101)
      ws.close()
    })
    ws.on('unexpected-response', (_request, response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    ws.on('error', reject)
  })

interface RawSocket {
  ws: WebSocket
  received: Record<string, unknown>[]
  send(frame: unknown): void
}

/** A raw socket client: frames out as JSON, host messages in as parsed objects. */
const rawSocket = async (url: string): Promise<RawSocket> => {
  const ws = new WebSocket(url)
  const received: Record<string, unknown>[] = []
  ws.on('message', (data) => received.push(JSON.parse(String(data)) as Record<string, unknown>))
  await new Promise((resolve) => ws.on('open', resolve))
  return { ws, received, send: (frame) => ws.send(JSON.stringify(frame)) }
}

type ReceiptMsg = Call<{ type: 'receipt'; callId: string }, string>
const receipts: Proc<number, ReceiptMsg, void> = async function* (self) {
  yield 0
  for await (const msg of self) msg.reply(msg.callId)
}

type BlobMsg = Cast<{ type: 'grow'; bytes: number }>
const blob: Proc<{ data: string }, BlobMsg, void> = async function* (self) {
  let n = 0
  yield { data: '' }
  for await (const msg of self) yield { data: String(++n % 10).repeat(msg.bytes) }
}

describe('node host hardening', () => {
  it('rejects nonsense limits at serve time', async () => {
    const defs = { cart: define(cart) }
    await expect(serve(defs, { heartbeatMs: -1 })).rejects.toThrow('heartbeatMs')
    await expect(serve(defs, { heartbeatMs: Number.NaN })).rejects.toThrow('heartbeatMs')
    await expect(serve(defs, { maxWatchesPerConnection: 1.5 })).rejects.toThrow('maxWatchesPerConnection')
    await expect(serve(defs, { maxWatchesPerConnection: -1 })).rejects.toThrow('maxWatchesPerConnection')
    await expect(serve(defs, { lookupRate: { max: 10, perMs: 0 } })).rejects.toThrow('lookupRate')
    await expect(serve(defs, { lookupRate: { max: 0.5, perMs: 10 } })).rejects.toThrow('lookupRate')
    await expect(serve(defs, { maxBufferedBytes: 0 })).rejects.toThrow('maxBufferedBytes')
  })

  it('answers 404 for anything but GET /schema (with or without a query) and for upgrades off the socket path', async () => {
    const host = await serve<Shop>({ cart: define(cart) }, { path: '/ws' })
    const http = `http://127.0.0.1:${host.port}`
    expect((await fetch(`${http}/nope`)).status).toBe(404)
    expect((await fetch(`${http}/schema`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${http}/schema?token=t`)).status).toBe(200) // a query string carries credentials, not a path
    expect(await handshake(`ws://127.0.0.1:${host.port}/elsewhere`)).toBe(404)
    expect(await handshake(host.url)).toBe(101)
    await until(() => host.sessions() === 0)
    await host.close()
  })

  it('an authorize that throws is a 500 for the schema and the upgrade, and the host keeps serving', async () => {
    let calls = 0
    const host = await serve<Shop>({ cart: define(cart) }, {
      authorize: () => {
        if (++calls % 2 === 1) throw new Error('session store down')
        return true
      },
    })
    expect((await fetch(`http://127.0.0.1:${host.port}/schema`)).status).toBe(500)
    expect((await fetch(`http://127.0.0.1:${host.port}/schema`)).status).toBe(200)
    expect(await handshake(host.url)).toBe(500)
    expect(await handshake(host.url)).toBe(101)
    await until(() => host.sessions() === 0)
    await host.close()
  })

  it('a scope that throws rejects the upgrade with 500', async () => {
    const host = await serve<Shop>({ cart: define(cart) }, {
      scope: () => {
        throw new Error('no session')
      },
    })
    expect(await handshake(host.url)).toBe(500)
    expect(host.sessions()).toBe(0)
    await host.close()
  })

  it('a client that stops reading is terminated once its outbound buffer passes maxBufferedBytes', async () => {
    const host = await serve({ blob: define(blob) }, { maxBufferedBytes: 256 * 1024 })
    const slow = await rawSocket(host.url)
    slow.send({ op: 'lookup', ref: 'r1', name: 'blob', v: 3 })
    await until(() => slow.received.length === 1)
    ;(slow.ws as unknown as { _socket: { pause(): void } })._socket.pause()

    const b = host.registry.lookup('blob')
    for (let i = 0; i < 400 && host.sessions() > 0; i++) {
      b.cast({ type: 'grow', bytes: 256 * 1024 })
      await tick()
    }
    expect(host.sessions()).toBe(0)
    slow.ws.terminate()
    await host.close()
  }, 30000)

  it('client callIds are namespaced per connection unless scope names a principal', async () => {
    const defs = { receipts: define(receipts) }
    const receiptFrom = async (url: string): Promise<unknown> => {
      const c = await rawSocket(url)
      c.send({ op: 'lookup', ref: 'r1', name: 'receipts', v: 3 })
      c.send({ op: 'call', ref: 'r1', id: 1, msg: { type: 'receipt', callId: 'order-7' } })
      await until(() => c.received.some((m) => m['op'] === 'reply'))
      c.ws.close()
      return c.received.find((m) => m['op'] === 'reply')?.['value']
    }

    const open = await serve(defs)
    const a = await receiptFrom(open.url)
    const b = await receiptFrom(open.url)
    expect(a).not.toBe(b) // two anonymous connections never share an answer record
    expect((JSON.parse(String(a)) as string[])[1]).toBe('order-7')
    await until(() => open.sessions() === 0)
    await open.close()

    const scoped = await serve(defs, {
      scope: (request, reg) => ({
        lookup: () => reg.lookup('receipts'),
        principal: new URL(request.url ?? '/', 'http://localhost').searchParams.get('user') ?? 'anonymous',
      }),
    })
    const alice1 = await receiptFrom(`${scoped.url}?user=alice`)
    const alice2 = await receiptFrom(`${scoped.url}?user=alice`)
    const mallory = await receiptFrom(`${scoped.url}?user=mallory`)
    expect(alice1).toBe('["alice","order-7"]')
    expect(alice2).toBe(alice1) // the same principal retries into the same record
    expect(mallory).toBe('["mallory","order-7"]')
    await until(() => scoped.sessions() === 0)
    await scoped.close()
  }, 15000)
})
