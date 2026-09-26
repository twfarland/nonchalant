import { describe, it, expect, vi } from 'vitest'
import { spawn, channel, define, registry, instrument, reducer, type ProcessEvent } from '../src/index.ts'
import type { Call, Cast } from '../src/index.ts'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

type Count = { n: number; label: string }
type Msg =
  | Cast<{ type: 'add'; by: number }>
  | Cast<{ type: 'label'; label: string }>
  | Call<{ type: 'get' }, number>
  | Cast<{ type: 'boom' }>

export function count(s: Count, msg: Msg): Count {
  switch (msg.type) {
    case 'add':
      return msg.by === 0 ? s : { ...s, n: s.n + msg.by }
    case 'label':
      return msg.label === s.label ? s : { ...s, label: msg.label }
    case 'get':
      msg.reply(s.n)
      return s
    case 'boom':
      throw new Error('boom')
  }
}

const counter = reducer((start: number) => ({ n: start, label: 'count' }), count)

describe('reducer', () => {
  it('yields init(args), then one state per changing message', async () => {
    const self = channel<Msg>()
    const it = counter(self, 5)
    expect((await it.next()).value).toStrictEqual({ n: 5, label: 'count' })
    self.cast({ type: 'add', by: 2 })
    expect((await it.next()).value).toStrictEqual({ n: 7, label: 'count' })
    await it.return(undefined)
  })

  it('yields nothing for a message that returns the same state', async () => {
    const self = channel<Msg>()
    const it = counter(self, 0)
    await it.next()
    self.cast({ type: 'add', by: 0 })
    self.cast({ type: 'label', label: 'count' })
    self.cast({ type: 'add', by: 1 })
    expect((await it.next()).value).toStrictEqual({ n: 1, label: 'count' }) // the two no-ops were skipped
    await it.return(undefined)
  })

  it('answers calls through msg.reply', async () => {
    const p = spawn(counter, 3, { initial: { n: 3, label: 'count' } })
    p.cast({ type: 'add', by: 4 })
    expect(await p.call({ type: 'get' })).toBe(7)
    expect(p.pending).toBe(false) // the call changed nothing and yielded nothing, and the process is idle
    p[Symbol.dispose]()
  })

  it('is the plain function it wraps, testable without a mailbox', () => {
    const reply = vi.fn()
    const s = { n: 1, label: 'x' }
    expect(count(s, { type: 'add', by: 2 })).toStrictEqual({ n: 3, label: 'x' })
    expect(count(s, { type: 'get', reply })).toBe(s)
    expect(reply).toHaveBeenCalledWith(1)
  })

  it('a throw is a crash, and an on-crash restart runs init again', async () => {
    const init = vi.fn((start: number) => ({ n: start, label: 'count' }))
    const p = spawn(reducer(init, count), 10, { initial: { n: 10, label: 'count' }, restart: 'on-crash' })
    p.cast({ type: 'add', by: 1 })
    await tick()
    expect(p().n).toBe(11)
    p.cast({ type: 'boom' })
    await tick()
    await tick()
    expect(init).toHaveBeenCalledTimes(2)
    expect(init).toHaveBeenLastCalledWith(10)
    expect(p().n).toBe(10)
    p[Symbol.dispose]()
  })

  it('starts from a restored snapshot when one is passed, and skips init', async () => {
    const init = vi.fn(() => ({ n: 0, label: 'count' }))
    const proc = reducer(init, count) as unknown as (
      self: ReturnType<typeof channel<Msg>>, args: void, d: { restored: Count | undefined },
    ) => AsyncGenerator<Count>
    const it = proc(channel<Msg>(), undefined, { restored: { n: 42, label: 'saved' } })
    expect((await it.next()).value).toStrictEqual({ n: 42, label: 'saved' })
    expect(init).not.toHaveBeenCalled()
    await it.return(undefined)
  })

  it('is named after its reduce function', () => {
    const events: ProcessEvent[] = []
    const stop = instrument((e) => void events.push(e))
    const p = spawn(counter, 0)
    stop()
    expect(counter.name).toBe('count')
    expect(events.find((e) => e.type === 'spawn')).toMatchObject({ name: 'count' })
    p[Symbol.dispose]()
  })

  it('works as a registry definition, keyed by its args', async () => {
    const reg = registry({ counter: define(counter, { initial: { n: 0, label: 'count' } }) })
    const a = reg.lookup('counter', 1)
    const b = reg.lookup('counter', 2)
    a.cast({ type: 'add', by: 1 })
    await tick()
    expect(a().n).toBe(2)
    expect(b().n).toBe(2)
    expect(reg.lookup('counter', 1)).toBe(a)
    reg.evict('counter')
  })
})
