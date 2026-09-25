// instrument(sink): the runtime's event stream, as an inspector sees it.

import { describe, it, expect, afterEach } from 'vitest'
import { spawn, define, registry, instrument } from '../src/index.ts'
import type { Call, Cast, Proc, ProcessEvent } from '../src/index.ts'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

type State = { count: number }
type Msg =
  | Cast<{ type: 'add'; n: number }>
  | Cast<{ type: 'boom' }>
  | Call<{ type: 'get' }, number>

const counter: Proc<State, Msg, void> = async function* counterProc(self) {
  let state: State = { count: 0 }
  for await (const msg of self) {
    switch (msg.type) {
      case 'add':
        state = { ...state, count: state.count + msg.n }
        break
      case 'boom':
        throw new Error('boom')
      case 'get':
        msg.reply(state.count)
        continue
    }
    yield state
  }
}

let remove: (() => void) | undefined
afterEach(() => remove?.())

const record = (): ProcessEvent[] => {
  const events: ProcessEvent[] = []
  remove = instrument((e) => events.push(e))
  return events
}

const withoutStatus = (events: ProcessEvent[]): ProcessEvent[] => events.filter((e) => e.type !== 'status')

describe('instrument', () => {
  it('reports spawn, cast, yield patch, call, reply, crash, restart and dispose in order', async () => {
    const events = record()
    const p = spawn(counter, undefined, { initial: { count: 0 }, restart: 'on-crash' })
    const id = (events[0] as { id: number }).id
    p.cast({ type: 'add', n: 2 })
    await tick()
    expect(await p.call({ type: 'get' })).toBe(2)
    p.cast({ type: 'boom' })
    await tick()
    p[Symbol.dispose]()
    await tick()

    const boom = events.find((e) => e.type === 'crash')
    expect(withoutStatus(events)).toEqual([
      { type: 'spawn', id, parent: null, name: 'counterProc', key: undefined, args: undefined, state: { count: 0 } },
      { type: 'cast', id, msg: { type: 'add', n: 2 } },
      { type: 'yield', id, ops: [['set', '/count', 2]] },
      { type: 'call', id, msg: { type: 'get' }, call: expect.any(Number) },
      { type: 'reply', id, call: (events.find((e) => e.type === 'call') as { call: number }).call, value: 2 },
      { type: 'cast', id, msg: { type: 'boom' } },
      { type: 'crash', id, error: (boom as { error: unknown }).error },
      { type: 'restart', id, attempt: 1 },
      { type: 'exit', id, reason: 'disposed' },
    ])
    expect((boom as { error: Error }).error.message).toBe('boom')
  })

  it('reports each lifecycle flag change as a status event', async () => {
    const events = record()
    const p = spawn(counter, undefined, { initial: { count: 0 } })
    await tick()
    p.cast({ type: 'add', n: 1 })
    await tick()
    p.cast({ type: 'boom' })
    await tick()
    expect(events.filter((e) => e.type === 'status' || e.type === 'exit').map((e) =>
      e.type === 'status' ? [e.pending, e.stale, e.errored] : e.reason)).toEqual([
      [false, false, false], // parked on the mailbox
      [true, false, false], // 'add' delivered
      [false, false, false], // yielded
      [true, false, false], // 'boom' delivered
      'crashed',
      [false, true, true],
    ])
    p[Symbol.dispose]()
  })

  it('gives each process a fresh, increasing id, and children their owner as parent', async () => {
    const events = record()
    const child: Proc<number, never, void> = async function* childProc() {
      yield 1
    }
    const parent = spawn(async function* parentProc() {
      spawn(child, undefined)
      yield 0
      await new Promise(() => {})
    }, undefined)
    const unowned = spawn(child, undefined)
    await tick()
    const spawns = events.filter((e) => e.type === 'spawn')
    expect(spawns.map((e) => [e.name, e.id - spawns[0]!.id, e.parent === null ? null : e.parent - spawns[0]!.id]))
      .toEqual([['parentProc', 0, null], ['childProc', 1, 0], ['childProc', 2, null]])
    parent[Symbol.dispose]()
    unowned[Symbol.dispose]()
  })

  it('labels registry processes with their name, and never parents them to the looker', async () => {
    const events = record()
    const reg = registry({ total: define(counter, { initial: { count: 0 } }) })
    const looker = spawn(async function* looker() {
      reg.lookup('total')
      yield 0
      await new Promise(() => {})
    }, undefined)
    await tick()
    const spawn2 = events.filter((e) => e.type === 'spawn')[1]
    expect(spawn2).toMatchObject({ name: 'counterProc', key: 'total', parent: null })
    looker[Symbol.dispose]()
    reg.evict('total')
  })

  it('reports a yield as the patch against the previous yield, the first against the initial value', async () => {
    const events = record()
    const p = spawn(async function* () {
      yield { a: 1, b: [1] }
      yield { a: 1, b: [1, 2] }
    }, undefined)
    await tick()
    expect(events.filter((e) => e.type === 'yield').map((e) => e.type === 'yield' && e.ops)).toEqual([
      [['set', '', { a: 1, b: [1] }]],
      [['splice', '/b', 1, 0, [2]]],
    ])
    expect(events.at(-1)).toMatchObject({ type: 'exit', reason: 'done' })
    p[Symbol.dispose]()
  })

  it('diffs a yield once with no sink installed, and once more for the sink when one is', async () => {
    // reconcile lists a record's keys once per diff: count them on the yielded value
    const keyReads = async (): Promise<number> => {
      let reads = 0
      const next = new Proxy({ a: 2 }, {
        ownKeys: (target) => {
          reads++
          return Reflect.ownKeys(target)
        },
      })
      const p = spawn(async function* () {
        yield next
      }, undefined, { initial: { a: 1 } })
      await tick()
      p[Symbol.dispose]()
      return reads
    }
    expect(await keyReads()).toBe(1)
    record()
    expect(await keyReads()).toBe(2)
  })

  it('reports nothing once removed, and a stale remover does not unhook a newer sink', async () => {
    const first: ProcessEvent[] = []
    const removeFirst = instrument((e) => first.push(e))
    removeFirst()
    spawn(counter, undefined)[Symbol.dispose]()
    expect(first).toEqual([])

    const second = record()
    removeFirst()
    spawn(counter, undefined)[Symbol.dispose]()
    expect(second.map((e) => e.type)).toEqual(['spawn', 'status', 'exit', 'status'])
  })
})
