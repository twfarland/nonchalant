// End-to-end over real sockets: the Node host serving a registry, clients on
// the reconnecting WebSocket transport. This is also where webSocketTransport
// earns its test coverage (deferred from M6).

import { describe, it, expect } from 'vitest'
import { define, effect } from '@nonchalant/core'
import type { Call, Definition, Proc } from '@nonchalant/core'
import { connect, webSocketTransport } from '@nonchalant/wire'
import { serve } from '../src/index.ts'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const until = async (cond: () => boolean, tries = 200): Promise<void> => {
  for (let i = 0; i < tries && !cond(); i++) await tick()
  if (!cond()) throw new Error('condition never became true')
}

type CartState = { items: string[]; total: number }
type CartMsg =
  | { type: 'add'; item: string; price: number }
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
    cartA.send({ type: 'add', item: 'boots', price: 120 })
    await until(() => cartB()?.total === 120)
    expect(cartB()?.items).toEqual(['boots'])

    // ask round-trips over the socket
    await expect(cartA.ask({ type: 'checkout' })).resolves.toStrictEqual({ ok: true, count: 1 })
    await until(() => cartB()?.total === 0)

    // remote reads stay path-precise across a real socket
    let itemRuns = 0
    const stop = effect(() => {
      itemRuns++
      void cartB()?.items.length
    })
    cartA.send({ type: 'add', item: 'hat', price: 5 }) // touches items AND total
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
})
