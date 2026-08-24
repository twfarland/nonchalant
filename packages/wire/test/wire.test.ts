import { describe, it, expect, vi } from 'vitest'
import fc from 'fast-check'
import { define, effect, registry } from '@nonchalant/core'
import type { Call, Cast, Definition, Json, Patch, Proc } from '@nonchalant/core'
import { connect, WireError } from '../src/client.ts'
import { expose } from '../src/host.ts'
import { decodeClient, decodeHost, encode, type ClientMsg, type HostMsg } from '../src/protocol.ts'
import { memoryPair } from '../src/transport.ts'
import { broadcastChannelTransport, portTransport, webSocketTransport, type MessageEndpoint } from '../src/transports.ts'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !cond(); i++) await tick()
  if (!cond()) throw new Error('condition never became true')
}

type CartState = { items: { done: boolean }[]; total: number }
type CartMsg =
  | Cast<{ type: 'toggle'; i: number }>
  | Cast<{ type: 'total'; n: number }>
  | Cast<{ type: 'boom' }>
  | Call<{ type: 'count' }, number>

const cart: Proc<CartState, CartMsg, void> = async function* (self) {
  let s: CartState = { items: [{ done: false }, { done: false }, { done: false }], total: 0 }
  yield s
  for await (const msg of self) {
    switch (msg.type) {
      case 'toggle':
        s = { ...s, items: s.items.map((it, i) => (i === msg.i ? { ...it, done: !it.done } : it)) }
        yield s
        break
      case 'total':
        s = { ...s, total: msg.n }
        yield s
        break
      case 'count':
        msg.reply(s.items.length)
        break
      case 'boom':
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

// ---------- arbitraries for the codec properties ----------

const { json } = fc.letrec<{ json: Json }>((tie) => ({
  json: fc.oneof(
    { maxDepth: 3, withCrossShrink: true },
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.string(),
    fc.array(tie('json'), { maxLength: 4 }),
    fc.dictionary(fc.string({ maxLength: 6 }), tie('json'), { maxKeys: 4 }).map((d) => ({ ...d })),
  ),
}))

const path = fc.oneof(fc.constant(''), fc.array(fc.string({ maxLength: 4 }), { minLength: 1, maxLength: 3 })
  .map((segs) => '/' + segs.map((s) => s.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')))

const patch: fc.Arbitrary<Patch> = fc.array(
  fc.oneof(
    fc.tuple(fc.constant('set' as const), path, json),
    fc.tuple(fc.constant('del' as const), path),
    fc.tuple(fc.constant('splice' as const), path, fc.nat(20), fc.nat(20), fc.array(json, { maxLength: 3 })),
  ),
  { maxLength: 4 },
)

const ref = fc.string({ maxLength: 8 })

// optional fields are absent, never explicitly undefined: JSON has no such value
const clientMsg: fc.Arbitrary<ClientMsg> = fc.oneof(
  fc.tuple(ref, fc.string({ maxLength: 8 }), fc.option(json, { nil: undefined })).map(([r, name, args]) =>
    args === undefined ? { op: 'lookup' as const, ref: r, name } : { op: 'lookup' as const, ref: r, name, args }),
  fc.tuple(ref, json).map(([r, msg]) => ({ op: 'cast' as const, ref: r, msg })),
  fc.tuple(ref, fc.integer(), json).map(([r, id, msg]) => ({ op: 'call' as const, ref: r, id, msg })),
  ref.map((r) => ({ op: 'exit' as const, ref: r })),
)

const hostMsg: fc.Arbitrary<HostMsg> = fc.oneof(
  fc.tuple(ref, patch).map(([r, p]) => ({ op: 'yield' as const, ref: r, patch: p })),
  fc.tuple(ref, fc.integer(), json).map(([r, id, value]) => ({ op: 'reply' as const, ref: r, id, value })),
  fc.tuple(ref, fc.option(json, { nil: undefined })).map(([r, value]) =>
    value === undefined ? { op: 'done' as const, ref: r } : { op: 'done' as const, ref: r, value }),
  fc.tuple(ref, json).map(([r, error]) => ({ op: 'raise' as const, ref: r, error })),
)

/** What the decoders promise their callers: null, or a message every consumer can trust. */
const wellFormed = (msg: ClientMsg | HostMsg | null): boolean => {
  if (msg === null) return true
  if (typeof msg.ref !== 'string') return false
  switch (msg.op) {
    case 'lookup': return typeof msg.name === 'string'
    case 'cast': return 'msg' in msg
    case 'call': return typeof msg.id === 'number' && 'msg' in msg
    case 'exit': return true
    case 'yield':
      return msg.patch.every((op) =>
        (op[1] === '' || op[1].startsWith('/')) &&
        (op[0] === 'set'
          ? op.length === 3
          : op[0] === 'del'
            ? op.length === 2
            : op.length === 5 && Number.isInteger(op[2]) && op[2] >= 0 && Number.isInteger(op[3]) && op[3] >= 0 &&
              Array.isArray(op[4])))
    case 'reply': return typeof msg.id === 'number' && 'value' in msg
    case 'done': return true
    case 'raise': return 'error' in msg
    default: return false
  }
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

  // Properties, because this file is the vocabulary other languages certify
  // against: a host that only satisfies the examples above is not conformant.
  it('round-trips every message shape, both directions', () => {
    fc.assert(
      fc.property(clientMsg, (msg) => {
        expect(decodeClient(encode(msg))).toStrictEqual(msg)
      }),
      { numRuns: 300 },
    )
    fc.assert(
      fc.property(hostMsg, (msg) => {
        expect(decodeHost(encode(msg))).toStrictEqual(msg)
      }),
      { numRuns: 300 },
    )
  })

  it('a message never decodes as the other direction', () => {
    fc.assert(
      fc.property(clientMsg, (msg) => {
        expect(decodeHost(encode(msg))).toBeNull()
      }),
      { numRuns: 200 },
    )
    fc.assert(
      fc.property(hostMsg, (msg) => {
        expect(decodeClient(encode(msg))).toBeNull()
      }),
      { numRuns: 200 },
    )
  })

  it('anything a decoder accepts is well formed, and nothing makes it throw', () => {
    // near-misses matter more than noise: valid messages with one field
    // dropped or replaced are exactly what a buggy host emits
    const damaged = fc
      .tuple(fc.oneof(clientMsg, hostMsg), fc.nat(9), json)
      .map(([msg, which, value]) => {
        const obj = JSON.parse(encode(msg)) as Record<string, Json>
        const keys = Object.keys(obj)
        const key = keys[which % keys.length] as string
        if (which % 2 === 0) delete obj[key]
        else obj[key] = value
        return JSON.stringify(obj)
      })

    // and patches that are *almost* patches: bad verbs, wrong arity, fractional
    // or negative splice numbers, paths without a leading slash
    const hostileOp = fc.oneof(
      fc.tuple(fc.constantFrom('set', 'del', 'splice', 'frobnicate'), fc.oneof(path, fc.string({ maxLength: 4 })), json),
      fc.tuple(
        fc.constant('splice'),
        path,
        fc.oneof(fc.integer({ min: -4, max: 20 }), fc.double({ min: -4, max: 20, noNaN: true })),
        fc.oneof(fc.integer({ min: -4, max: 20 }), fc.double({ min: -4, max: 20, noNaN: true })),
        fc.array(json, { maxLength: 2 }),
      ),
      fc.array(json, { maxLength: 5 }),
    )
    const hostileYield = fc
      .tuple(ref, fc.array(hostileOp, { maxLength: 3 }))
      .map(([r, ops]) => JSON.stringify({ op: 'yield', ref: r, patch: ops }))

    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json(), damaged, hostileYield), (data) => {
        expect(wellFormed(decodeClient(data))).toBe(true)
        expect(wellFormed(decodeHost(data))).toBe(true)
      }),
      { numRuns: 1000 },
    )
  })
})

describe('connect / expose end to end', () => {
  it('lookup arrives as a full snapshot; casts round-trip', async () => {
    const { conn, teardown } = setup()
    const rcart = conn.lookup('cart')
    await until(() => rcart() !== undefined)
    expect(rcart()).toStrictEqual({ items: [{ done: false }, { done: false }, { done: false }], total: 0 })
    rcart.cast({ type: 'total', n: 9 })
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
    rcart.cast({ type: 'total', n: 5 })
    await until(() => rcart().total === 5)
    expect([totalRuns, itemRuns]).toEqual([2, 1])
    rcart.cast({ type: 'toggle', i: 1 })
    await until(() => rcart().items[1]!.done)
    expect([totalRuns, itemRuns]).toEqual([2, 2])
    for (const stop of stops) stop()
    teardown()
  })

  it('a call round-trips as call/reply; a crash rejects pending calls and reads go stale', async () => {
    const { conn, teardown } = setup()
    const rcart = conn.lookup('cart')
    await until(() => rcart() !== undefined)
    await expect(rcart.call({ type: 'count' })).resolves.toBe(3)
    rcart.cast({ type: 'boom' })
    const pending = rcart.call({ type: 'count' })
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

  it('a call made while disconnected rejects immediately instead of hanging', async () => {
    const { link, conn, teardown } = setup()
    const rcart = conn.lookup('cart')
    await until(() => rcart() !== undefined)
    link.disconnect()
    await until(() => rcart.stale)
    await expect(rcart.call({ type: 'count' })).rejects.toBeInstanceOf(WireError)
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
    hostCart.cast({ type: 'total', n: 42 })
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

describe('watch limits', () => {
  it('a lookup past maxWatches raises; re-lookup and exit do not consume slots', async () => {
    const link = memoryPair()
    const reg = registry({ cart: define(cart) })
    const stop = expose(reg, link.host, { maxWatches: 1 })
    const received: HostMsg[] = []
    const unsubscribe = link.client.subscribe({
      message: (data) => {
        const m = decodeHost(data)
        if (m !== null) received.push(m)
      },
    })

    link.client.send(encode({ op: 'lookup', ref: 'r1', name: 'cart' }))
    await until(() => received.some((m) => m.op === 'yield' && m.ref === 'r1'))

    link.client.send(encode({ op: 'lookup', ref: 'r2', name: 'cart' }))
    await until(() => received.some((m) => m.op === 'raise' && m.ref === 'r2'))

    // re-lookup on an existing ref replaces its watch — allowed at the cap
    link.client.send(encode({ op: 'lookup', ref: 'r1', name: 'cart' }))
    await link.settle()
    expect(received.filter((m) => m.op === 'raise')).toHaveLength(1)

    // exit frees the slot for a new ref
    link.client.send(encode({ op: 'exit', ref: 'r1' }))
    await link.settle()
    link.client.send(encode({ op: 'lookup', ref: 'r3', name: 'cart' }))
    await until(() => received.some((m) => m.op === 'yield' && m.ref === 'r3'))
    expect(received.filter((m) => m.op === 'raise')).toHaveLength(1)

    unsubscribe()
    stop()
    reg.evict('cart')
  })
})

describe('websocket transport backoff', () => {
  it('redials with jittered exponential backoff and stops after close', () => {
    class FakeWS {
      static created: FakeWS[] = []
      readyState = 0
      listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>()
      constructor(public url: string) {
        FakeWS.created.push(this)
      }
      addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void {
        const fns = this.listeners.get(type) ?? []
        fns.push(fn)
        this.listeners.set(type, fns)
      }
      send(_data: string): void {}
      close(): void {}
      emit(type: string): void {
        for (const fn of this.listeners.get(type) ?? []) fn({})
      }
    }
    const g = globalThis as { WebSocket?: unknown }
    const prevWS = g.WebSocket
    g.WebSocket = FakeWS
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.5) // jitter factor 0.75
    vi.useFakeTimers()
    try {
      const t = webSocketTransport('ws://backoff.test', { retryDelay: 100 })
      expect(FakeWS.created).toHaveLength(1)

      FakeWS.created[0]!.emit('close') // attempt 0 → 100 · 1 · 0.75 = 75ms
      vi.advanceTimersByTime(74)
      expect(FakeWS.created).toHaveLength(1)
      vi.advanceTimersByTime(1)
      expect(FakeWS.created).toHaveLength(2)

      FakeWS.created[1]!.emit('close') // attempt 1 → 100 · 2 · 0.75 = 150ms
      vi.advanceTimersByTime(149)
      expect(FakeWS.created).toHaveLength(2)
      vi.advanceTimersByTime(1)
      expect(FakeWS.created).toHaveLength(3)

      t.close()
      FakeWS.created[2]!.emit('close') // closed for good: no redial
      vi.advanceTimersByTime(60_000)
      expect(FakeWS.created).toHaveLength(3)
    } finally {
      vi.useRealTimers()
      rand.mockRestore()
      if (prevWS === undefined) delete g.WebSocket
      else g.WebSocket = prevWS
    }
  })
})

describe('port transport', () => {
  it('carries a whole session between two ends of a port', async () => {
    const { port1, port2 } = new MessageChannel()
    const reg = registry({ cart: define(cart) })
    const stop = expose(reg, portTransport(port1 as unknown as MessageEndpoint))
    const conn = connect<Shop>(portTransport(port2 as unknown as MessageEndpoint))

    const rcart = conn.lookup('cart')
    await until(() => rcart() !== undefined)
    rcart.cast({ type: 'total', n: 7 })
    await until(() => rcart().total === 7)
    expect(await rcart.call({ type: 'count' })).toBe(3)

    conn.close()
    stop()
    port1.close()
    port2.close()
    reg.evict('cart')
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
      rcart.cast({ type: 'total', n: 7 })
      await until(() => rcart().total === 7)
      conn.close()
      stop()
      hostT.close()
      clientT.close()
      reg.evict('cart')
    },
  )
})

// The one property that exercises the whole stack at once: reconcile on the
// host, patch application on the client, yield conflation, and reconnect as a
// full snapshot. Whatever order messages and partitions arrive in, the client
// must end up holding exactly what the host holds — the claim the protocol
// makes and the reason reconnect is not a special case.
describe('convergence', () => {
  const command = fc.oneof(
    fc.record({ do: fc.constant('toggle' as const), i: fc.nat(2) }),
    fc.record({ do: fc.constant('total' as const), n: fc.integer({ min: 0, max: 50 }) }),
    fc.record({ do: fc.constant('partition' as const) }),
    fc.record({ do: fc.constant('heal' as const) }),
    fc.record({ do: fc.constant('settle' as const) }),
  )

  it('the client holds exactly the host state, whatever the schedule', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(command, { maxLength: 12 }), async (script) => {
        const link = memoryPair()
        const reg = registry({ cart: define(cart) })
        const stop = expose(reg, link.host)
        const conn = connect<Shop>(link.client)
        const remote = conn.lookup('cart')
        const host = reg.lookup('cart') // the very process being served
        let connected = true

        try {
          for (const cmd of script) {
            if (cmd.do === 'toggle') remote.cast({ type: 'toggle', i: cmd.i })
            else if (cmd.do === 'total') remote.cast({ type: 'total', n: cmd.n })
            else if (cmd.do === 'partition' && connected) { link.disconnect(); connected = false }
            else if (cmd.do === 'heal' && !connected) { link.reconnect(); connected = true }
            else await link.settle()
          }
          if (!connected) link.reconnect() // heal at the end: the client re-looks-up

          const same = (): boolean =>
            remote() !== undefined && JSON.stringify(remote()) === JSON.stringify(host())
          for (let i = 0; i < 20 && !same(); i++) {
            await tick()
            await link.settle()
          }
          expect(remote()).toStrictEqual(host())
        } finally {
          conn.close()
          stop()
          reg.evict('cart')
        }
      }),
      { numRuns: 50 },
    )
  })
})
