import { describe, it, expect } from 'vitest'
import { define, effect, registry } from '@nonchalant/core'
import type { Call, Definition, Proc } from '@nonchalant/core'
import { connect, WireError } from '../src/client.ts'
import { expose } from '../src/host.ts'
import { decodeClient, decodeHost, encode, type ClientMsg, type HostMsg } from '../src/protocol.ts'
import { memoryPair } from '../src/transport.ts'
import { broadcastChannelTransport } from '../src/transports.ts'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !cond(); i++) await tick()
  if (!cond()) throw new Error('condition never became true')
}

type CartState = { items: { done: boolean }[]; total: number }
type CartMsg =
  | { type: 'toggle'; i: number }
  | { type: 'total'; n: number }
  | { type: 'boom' }
  | Call<{ type: 'count' }, number>

const cart: Proc<CartState, CartMsg, void> = async function* (self) {
  let s: CartState = { items: [{ done: false }, { done: false }, { done: false }], total: 0 }
  yield s
  for await (const msg of self) {
    if (msg.type === 'toggle') {
      s = { ...s, items: s.items.map((it, i) => (i === msg.i ? { ...it, done: !it.done } : it)) }
      yield s
    } else if (msg.type === 'total') {
      s = { ...s, total: msg.n }
      yield s
    } else if (msg.type === 'count') {
      msg.reply(s.items.length)
    } else {
      throw new Error('boom')
    }
  }
}

type Shop = { cart: Definition<CartState, CartMsg, void> }

const setup = () => {
  const link = memoryPair()
  const reg = registry({ cart: define(cart) })
  const stop = expose(reg, link.host)
  const conn = connect<Shop>(link.client)
  const teardown = (): void => {
    conn.close()
    stop()
    reg.evict('cart')
  }
  return { link, reg, conn, teardown }
}

describe('codec', () => {
  it('round-trips both directions and rejects garbage and wrong directions', () => {
    const c: ClientMsg = { op: 'call', ref: 'r1', id: 3, msg: { type: 'get' } }
    const h: HostMsg = { op: 'yield', ref: 'r1', patch: [['set', '', { n: 1 }]] }
    expect(decodeClient(encode(c))).toStrictEqual(c)
    expect(decodeHost(encode(h))).toStrictEqual(h)
    expect(decodeClient(encode(h))).toBeNull()
    expect(decodeHost(encode(c))).toBeNull()
    expect(decodeHost('not json')).toBeNull()
    expect(decodeHost('{"op":"yield","ref":"r1","patch":[["frobnicate","/x"]]}')).toBeNull()
  })

  it('rejects patches with malformed paths or splice numbers at decode time', () => {
    expect(decodeHost('{"op":"yield","ref":"r1","patch":[["set","x",1]]}')).toBeNull()
    expect(decodeHost('{"op":"yield","ref":"r1","patch":[["splice","",-1,0,[]]]}')).toBeNull()
    expect(decodeHost('{"op":"yield","ref":"r1","patch":[["splice","",0.5,0,[]]]}')).toBeNull()
    expect(decodeHost('{"op":"yield","ref":"r1","patch":[["splice","",0,-2,[]]]}')).toBeNull()
  })
})

describe('connect / expose end to end', () => {
  it('lookup arrives as a full snapshot; sends round-trip', async () => {
    const { conn, teardown } = setup()
    const rcart = conn.lookup('cart')
    await until(() => rcart() !== undefined)
    expect(rcart()).toStrictEqual({ items: [{ done: false }, { done: false }, { done: false }], total: 0 })
    rcart.send({ type: 'total', n: 9 })
    await until(() => rcart().total === 9)
    teardown()
  })

  it('client-side get-or-spawn: one facade per name+args', () => {
    const { conn, teardown } = setup()
    expect(conn.lookup('cart')).toBe(conn.lookup('cart'))
    teardown()
  })

  it('remote reads are path-precise: a /total patch never wakes the item reader', async () => {
    const { conn, teardown } = setup()
    const rcart = conn.lookup('cart')
    await until(() => rcart() !== undefined)
    let totalRuns = 0
    let itemRuns = 0
    const stops = [
      effect(() => { totalRuns++; void rcart()?.total }),
      effect(() => { itemRuns++; void rcart()?.items[1]?.done }),
    ]
    expect([totalRuns, itemRuns]).toEqual([1, 1])
    rcart.send({ type: 'total', n: 5 })
    await until(() => rcart().total === 5)
    expect([totalRuns, itemRuns]).toEqual([2, 1])
    rcart.send({ type: 'toggle', i: 1 })
    await until(() => rcart().items[1]!.done)
    expect([totalRuns, itemRuns]).toEqual([2, 2])
    for (const stop of stops) stop()
    teardown()
  })

  it('ask round-trips as call/reply; a crash rejects pending asks and reads go stale', async () => {
    const { conn, teardown } = setup()
    const rcart = conn.lookup('cart')
    await until(() => rcart() !== undefined)
    await expect(rcart.ask({ type: 'count' })).resolves.toBe(3)
    rcart.send({ type: 'boom' })
    const pending = rcart.ask({ type: 'count' })
    await expect(pending).rejects.toBeInstanceOf(WireError)
    await until(() => rcart.stale)
    expect(rcart()).toStrictEqual({ items: [{ done: false }, { done: false }, { done: false }], total: 0 }) // last value retained
    expect(rcart.error).toBeInstanceOf(WireError)
    teardown()
  })

  it('exit releases the host watch; registry eviction then reclaims the process', async () => {
    const log: string[] = []
    const tracked: Proc<number, never, void> = async function* (self) {
      log.push('spawn')
      try {
        yield 1
        for await (const _ of self) void _
      } finally {
        log.push('dispose')
      }
    }
    const link = memoryPair()
    const reg = registry({ tracked: define(tracked, { evict: 20 }) })
    const stop = expose(reg, link.host)
    const conn = connect<{ tracked: Definition<number, never, void> }>(link.client)
    const p = conn.lookup('tracked')
    await until(() => p() !== undefined)
    ;(p as unknown as Disposable)[Symbol.dispose]() // sends exit
    await tick()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(log).toEqual(['spawn', 'dispose'])
    conn.close()
    stop()
  })

  it('an ask made while disconnected rejects immediately instead of hanging', async () => {
    const { link, conn, teardown } = setup()
    const rcart = conn.lookup('cart')
    await until(() => rcart() !== undefined)
    link.disconnect()
    await until(() => rcart.stale)
    await expect(rcart.ask({ type: 'count' })).rejects.toBeInstanceOf(WireError)
    teardown()
  })

  it('reconnect is a re-lookup: full patch, and unchanged paths sleep through it', async () => {
    const { link, reg, conn, teardown } = setup()
    const rcart = conn.lookup('cart')
    await until(() => rcart() !== undefined)
    let itemRuns = 0
    let totalRuns = 0
    const stops = [
      effect(() => { itemRuns++; void rcart()?.items[0]?.done }),
      effect(() => { totalRuns++; void rcart()?.total }),
    ]

    link.disconnect()
    await until(() => rcart.stale)
    expect(rcart()?.total).toBe(0) // value survives the partition

    // the host state moves while we are partitioned
    const hostCart = reg.lookup('cart')
    hostCart.send({ type: 'total', n: 42 })
    await tick()

    const itemRunsBefore = itemRuns
    link.reconnect()
    await until(() => rcart()?.total === 42)
    expect(rcart.stale).toBe(false)
    expect(itemRuns).toBe(itemRunsBefore) // full snapshot diffed against the retained value: items untouched
    expect(totalRuns).toBeGreaterThan(1)
    for (const stop of stops) stop()
    teardown()
  })
})

describe('broadcast channel transport', () => {
  it.skipIf(typeof globalThis.BroadcastChannel === 'undefined')(
    'a late host announces and earlier clients re-look-up',
    async () => {
      const name = `nc-test-${Math.random().toString(36).slice(2)}`
      const clientT = broadcastChannelTransport(name)
      const conn = connect<Shop>(clientT)
      const rcart = conn.lookup('cart') // nobody is hosting yet
      await tick()
      expect(rcart()).toBeUndefined()

      const hostT = broadcastChannelTransport(name)
      const reg = registry({ cart: define(cart) })
      const stop = expose(reg, hostT)
      hostT.announce() // the fresh host tells the bus it is serving
      await until(() => rcart() !== undefined)
      expect(rcart()?.total).toBe(0)

      conn.close()
      stop()
      hostT.close()
      clientT.close()
      reg.evict('cart')
    },
  )

  it.skipIf(typeof globalThis.BroadcastChannel === 'undefined')(
    'host and client sync over a bus',
    async () => {
      const name = `nc-test-${Math.random().toString(36).slice(2)}`
      const hostT = broadcastChannelTransport(name)
      const clientT = broadcastChannelTransport(name)
      const reg = registry({ cart: define(cart) })
      const stop = expose(reg, hostT)
      const conn = connect<Shop>(clientT)
      const rcart = conn.lookup('cart')
      await until(() => rcart() !== undefined)
      rcart.send({ type: 'total', n: 7 })
      await until(() => rcart().total === 7)
      conn.close()
      stop()
      hostT.close()
      clientT.close()
      reg.evict('cart')
    },
  )
})
