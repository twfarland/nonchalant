// The edges of a wire session: what a hostile or merely buggy client can do to
// a shared process (screening, callId namespacing, lookup rate), and what a
// client sees at the ends of a process's life (done, raise, dispose,
// disconnect).

import { describe, it, expect, vi } from 'vitest'
import { define, registry } from '@nonchalant/core'
import type { Call, Cast, Definition, Json, Proc } from '@nonchalant/core'
import { connect, WireError } from '../src/client.ts'
import { expose, type Exposable, type ExposeOpts } from '../src/host.ts'
import { decodeClient, decodeHost, type HostMsg } from '../src/protocol.ts'
import { memoryPair, type Transport } from '../src/transport.ts'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !cond(); i++) await tick()
  if (!cond()) throw new Error('condition never became true')
}

// ---------- a room that trusts its messages, as most reducers do ----------

type Line = { from: string; text: string }
type RoomMsg =
  | Cast<{ type: 'post'; from: string; text: string }>
  | Cast<{ type: 'close' }>
  | Call<{ type: 'count' }, number>
  | Call<{ type: 'receipt'; callId: string }, string>
  | Call<{ type: 'nothing' }, undefined>

const room: Proc<{ lines: Line[] }, RoomMsg, void> = async function* (self) {
  let lines: Line[] = []
  yield { lines }
  for await (const msg of self) {
    switch (msg.type) {
      case 'post':
        lines = [...lines, { from: msg.from, text: msg.text.trim() }] // throws on a non-string text
        break
      case 'close':
        return
      case 'count':
        msg.reply(lines.length)
        continue
      case 'receipt':
        msg.reply(msg.callId)
        continue
      case 'nothing':
        msg.reply(undefined)
        continue
    }
    yield { lines }
  }
}

type Rooms = { room: Definition<{ lines: Line[] }, RoomMsg, void> }

const setup = (gate?: (reg: Exposable) => Exposable, opts?: ExposeOpts) => {
  const link = memoryPair()
  const reg = registry({ room: define(room) })
  const stop = expose(gate === undefined ? reg : gate(reg), link.host, opts)
  const conn = connect<Rooms>(link.client)
  const teardown = (): void => {
    conn.close()
    stop()
    reg.evict('room')
  }
  return { link, reg, conn, teardown }
}

/** A raw client end: sends encoded frames and records every host message. */
const rawClient = (t: Transport) => {
  const received: HostMsg[] = []
  const unsubscribe = t.subscribe({
    message: (data) => {
      const m = decodeHost(data)
      if (m !== null) received.push(m)
    },
  })
  return { received, send: (frame: unknown) => t.send(JSON.stringify(frame)), unsubscribe }
}

// ---------- the host screens what it delivers ----------

describe('message screening', () => {
  it('a message that is not an object with a string type never reaches the process', async () => {
    const link = memoryPair()
    const reg = registry({ room: define(room) })
    const stop = expose(reg, link.host)
    const client = rawClient(link.client)
    const host = reg.lookup('room')

    client.send({ op: 'lookup', ref: 'r1', name: 'room', v: 3 })
    await until(() => client.received.length === 1)
    for (const msg of [null, 5, 'post', [{ type: 'close' }], { kind: 'close' }, { type: 7 }])
      client.send({ op: 'cast', ref: 'r1', msg })
    client.send({ op: 'cast', ref: 'r1' })
    client.send({ op: 'call', ref: 'r1', id: 1, msg: null })
    client.send({ op: 'call', ref: 'r1', id: 2 })
    await link.settle()
    await tick()

    expect(client.received.slice(1)).toStrictEqual([
      { op: 'raise', ref: 'r1', error: { message: 'invalid message: expected an object with a string type', id: 1 } },
      { op: 'raise', ref: 'r1', error: { message: 'invalid message: expected an object with a string type', id: 2 } },
    ])
    expect(host.error).toBeUndefined()
    client.unsubscribe()
    stop()
    reg.evict('room')
  })

  it('admit refuses a malformed message so one client cannot crash a room everyone watches', async () => {
    const admit = (_name: string, msg: { type: string } & { [key: string]: Json }): Json | undefined =>
      msg.type !== 'post' || (typeof msg['text'] === 'string' && typeof msg['from'] === 'string') ? msg : undefined
    const reg = registry({ room: define(room) })
    const aliceLink = memoryPair()
    const malloryLink = memoryPair()
    const stops = [
      expose({ ...reg, admit }, aliceLink.host),
      expose({ ...reg, admit }, malloryLink.host),
    ]
    const alice = connect<Rooms>(aliceLink.client).lookup('room')
    await until(() => alice() !== undefined)

    const mallory = rawClient(malloryLink.client)
    mallory.send({ op: 'lookup', ref: 'm1', name: 'room', v: 3 })
    await until(() => mallory.received.length === 1)
    mallory.send({ op: 'cast', ref: 'm1', msg: { type: 'post', from: 'm', text: 5 } })
    mallory.send({ op: 'call', ref: 'm1', id: 1, msg: { type: 'post', from: 'm' } })
    await until(() => mallory.received.length === 2)
    expect(mallory.received[1]).toStrictEqual({ op: 'raise', ref: 'm1', error: { message: 'message refused', id: 1 } })

    alice.cast({ type: 'post', from: 'alice', text: 'hi' })
    await until(() => alice()?.lines.length === 1)
    expect(alice.stale).toBe(false)
    expect(reg.lookup('room').error).toBeUndefined()
    mallory.unsubscribe()
    for (const stop of stops) stop()
    reg.evict('room')
  })

  it('admit can replace a message: the server stamps the sender, whatever the client claims', async () => {
    const { conn, teardown } = setup((reg) => ({
      ...reg,
      admit: (_name, msg) => (msg.type === 'post' ? { ...msg, from: 'alice' } : msg),
    }))
    const r = conn.lookup('room')
    await until(() => r() !== undefined)
    r.cast({ type: 'post', from: 'the-ceo', text: 'wire the money' })
    await until(() => r()?.lines.length === 1)
    expect(r()?.lines).toStrictEqual([{ from: 'alice', text: 'wire the money' }])
    teardown()
  })

  it('a refused or throwing admit rejects that call only', async () => {
    const { conn, teardown } = setup((reg) => ({
      ...reg,
      admit: (_name, msg) => {
        if (msg.type === 'nothing') throw new Error('not for you')
        return msg.type === 'receipt' ? undefined : msg
      },
    }))
    const r = conn.lookup('room')
    await until(() => r() !== undefined)
    await expect(r.call({ type: 'receipt', callId: 'x' })).rejects.toThrow('message refused')
    await expect(r.call({ type: 'nothing' })).rejects.toThrow('message refused')
    await expect(r.call({ type: 'count' })).resolves.toBe(0)
    expect(r.stale).toBe(false)
    teardown()
  })

  it('a gateway process without call answers a call with a raise for that id', async () => {
    const link = memoryPair()
    const reg = registry({ room: define(room) })
    const stop = expose({
      lookup: () => {
        const p = reg.lookup('room')
        return { [Symbol.asyncIterator]: () => p[Symbol.asyncIterator](), get error() { return p.error } }
      },
    }, link.host)
    const client = rawClient(link.client)
    client.send({ op: 'lookup', ref: 'r1', name: 'room', v: 3 })
    await until(() => client.received.length === 1)
    client.send({ op: 'call', ref: 'r1', id: 9, msg: { type: 'count' } })
    await until(() => client.received.length === 2)
    expect(client.received[1]).toStrictEqual({ op: 'raise', ref: 'r1', error: { message: 'not callable', id: 9 } })
    client.unsubscribe()
    stop()
    reg.evict('room')
  })
})

// ---------- callIds are namespaced by principal ----------

describe('principal namespacing', () => {
  it('a client-chosen callId reaches the process inside its principal namespace', async () => {
    const alice = setup((reg) => ({ ...reg, principal: 'alice' }))
    const r = alice.conn.lookup('room')
    await until(() => r() !== undefined)
    await expect(r.call({ type: 'receipt', callId: 'order-7' })).resolves.toBe('["alice","order-7"]')
    alice.teardown()
  })

  it('two principals reusing one callId reach two different ids', async () => {
    const reg = registry({ room: define(room) })
    const ids: string[] = []
    for (const principal of ['alice', 'mallory']) {
      const link = memoryPair()
      const stop = expose({ ...reg, principal }, link.host)
      const conn = connect<Rooms>(link.client)
      const r = conn.lookup('room')
      await until(() => r() !== undefined)
      ids.push(await r.call({ type: 'receipt', callId: 'order-7' }))
      conn.close()
      stop()
    }
    expect(ids).toStrictEqual(['["alice","order-7"]', '["mallory","order-7"]'])
    reg.evict('room')
  })

  it('the namespace is injective: principal and id cannot be recombined into a collision', async () => {
    const reg = registry({ room: define(room) })
    const ids: string[] = []
    for (const [principal, callId] of [['a:b', 'c'], ['a', 'b:c']] as const) {
      const link = memoryPair()
      const stop = expose({ ...reg, principal }, link.host)
      const conn = connect<Rooms>(link.client)
      const r = conn.lookup('room')
      await until(() => r() !== undefined)
      ids.push(await r.call({ type: 'receipt', callId }))
      conn.close()
      stop()
    }
    expect(ids[0]).not.toBe(ids[1])
    reg.evict('room')
  })

  it('without a principal, callIds pass through untouched', async () => {
    const { conn, teardown } = setup()
    const r = conn.lookup('room')
    await until(() => r() !== undefined)
    await expect(r.call({ type: 'receipt', callId: 'order-7' })).resolves.toBe('order-7')
    teardown()
  })
})

// ---------- lookup rate ----------

describe('lookup rate', () => {
  it('a lookup past the window cap raises; the next window admits again', async () => {
    let now = 1_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const link = memoryPair()
      const reg = registry({ room: define(room) })
      const stop = expose(reg, link.host, { lookupRate: { max: 2, perMs: 1_000 } })
      const client = rawClient(link.client)
      for (const ref of ['r1', 'r2', 'r3']) client.send({ op: 'lookup', ref, name: 'room', v: 3 })
      await until(() => client.received.length === 3)
      expect(client.received.map((m) => `${m.op} ${m.ref}`).sort()).toStrictEqual(['raise r3', 'yield r1', 'yield r2'])
      expect(client.received.find((m) => m.op === 'raise')).toStrictEqual({
        op: 'raise', ref: 'r3', error: { message: 'lookup rate exceeded' },
      })

      now += 1_000
      client.send({ op: 'lookup', ref: 'r4', name: 'room', v: 3 })
      await until(() => client.received.length === 4)
      expect(client.received[3]?.op).toBe('yield')
      client.unsubscribe()
      stop()
      reg.evict('room')
    } finally {
      clock.mockRestore()
    }
  })
})

// ---------- the client at the ends of a process's life ----------

describe('client lifecycle edges', () => {
  it('a call that replies with no value settles with undefined', async () => {
    const { conn, teardown } = setup()
    const r = conn.lookup('room')
    await until(() => r() !== undefined)
    await expect(r.call({ type: 'nothing' })).resolves.toBeUndefined()
    teardown()
  })

  it('done ends the facade: calls reject, casts drop, and the next lookup starts afresh', async () => {
    const { conn, teardown } = setup()
    const r = conn.lookup('room')
    await until(() => r() !== undefined)
    r.cast({ type: 'post', from: 'a', text: 'last words' })
    r.cast({ type: 'close' })
    await expect(r.call({ type: 'count' })).rejects.toThrow('process ended')
    await expect(r.call({ type: 'count' })).rejects.toThrow('process ended')
    expect(r()?.lines).toHaveLength(1) // the last value is kept
    r.cast({ type: 'post', from: 'a', text: 'into the void' })

    const again = conn.lookup('room')
    expect(again).not.toBe(r)
    await until(() => again() !== undefined)
    expect(again()?.lines).toStrictEqual([])
    await expect(again.call({ type: 'count' })).resolves.toBe(0)
    ;(r as unknown as Disposable)[Symbol.dispose]() // disposing the ended facade leaves the new one alone
    expect(conn.lookup('room')).toBe(again)
    teardown()
  })

  it('a call on a disposed facade rejects without touching the wire', async () => {
    const { link, conn, teardown } = setup()
    const r = conn.lookup('room')
    await until(() => r() !== undefined)
    ;(r as unknown as Disposable)[Symbol.dispose]()
    const sent = vi.spyOn(link.client, 'send')
    await expect(r.call({ type: 'count' })).rejects.toBeInstanceOf(WireError)
    expect(sent).toHaveBeenCalledTimes(0)
    teardown()
  })

  it('asyncDispose sends exit, rejects pending calls, and resolves once the facade has settled', async () => {
    const link = memoryPair()
    const reg = registry({ room: define(room) })
    const stop = expose(reg, link.host)
    const frames: string[] = []
    const t: Transport = {
      send: (data) => {
        frames.push(data)
        link.client.send(data)
      },
      subscribe: (h) => link.client.subscribe(h),
    }
    const conn = connect<Rooms>(t)
    const r = conn.lookup('room')
    await until(() => r() !== undefined)
    await (r as unknown as AsyncDisposable)[Symbol.asyncDispose]()
    expect(frames.map((f) => decodeClient(f)?.op)).toStrictEqual(['lookup', 'exit'])
    await expect(r.call({ type: 'count' })).rejects.toThrow('process ended')
    conn.close()
    stop()
    reg.evict('room')
  })

  it('casts made while disconnected are sent after the re-lookup, in order', async () => {
    const { link, reg, conn, teardown } = setup()
    const r = conn.lookup('room')
    await until(() => r() !== undefined)
    link.disconnect()
    await until(() => r.stale)
    r.cast({ type: 'post', from: 'a', text: 'one' })
    r.cast({ type: 'post', from: 'a', text: 'two' })
    link.reconnect()
    await until(() => r()?.lines.length === 2)
    expect(r()?.lines.map((l) => l.text)).toStrictEqual(['one', 'two'])
    expect(reg.lookup('room')()?.lines).toHaveLength(2) // delivered exactly once
    teardown()
  })

  it('the disconnected cast queue keeps the newest 64', async () => {
    const { link, conn, teardown } = setup()
    const r = conn.lookup('room')
    await until(() => r() !== undefined)
    link.disconnect()
    for (let i = 0; i < 70; i++) r.cast({ type: 'post', from: 'a', text: String(i) })
    link.reconnect()
    await until(() => r()?.lines.length === 64)
    await link.settle()
    expect(r()?.lines.map((l) => l.text)).toStrictEqual(Array.from({ length: 64 }, (_, i) => String(i + 6)))
    teardown()
  })

  it('a cast made before the transport first opens is delivered after the lookup', async () => {
    const { conn, teardown } = setup()
    const r = conn.lookup('room') // the memory transport opens a microtask later
    r.cast({ type: 'post', from: 'a', text: 'early' })
    await until(() => r()?.lines.length === 1)
    teardown()
  })

  it('without crypto.randomUUID refs still get a per-session prefix', async () => {
    vi.stubGlobal('crypto', undefined)
    try {
      const link = memoryPair()
      const frames: string[] = []
      link.host.subscribe({ message: (d) => frames.push(d) })
      const a = connect<Rooms>(link.client)
      a.lookup('room')
      await until(() => frames.length === 1)
      const ref = (decodeClient(frames[0] ?? '') as { ref: string }).ref
      expect(ref).toMatch(/^[0-9a-z]+:1$/)
      a.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
