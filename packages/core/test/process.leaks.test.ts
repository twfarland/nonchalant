// The acto lesson (docs/DESIGN.md origin flaw #1): subscriptions and process
// state must actually be released — "nothing retained after dispose".
// Runs under --expose-gc (vitest.config.ts); skipped if gc is unavailable.

import { describe, it, expect } from 'vitest'
import { spawn, derive } from '../src/index.ts'
import { effect } from '../src/graph.ts'
import type { Proc, Self } from '../src/index.ts'

// gc({execution:'async'}) collects from a clean stack — plain gc() leaves V8's
// conservative stack scanning treating stale stack slots as live references
const gcNow = (globalThis as { gc?: (o: { execution: 'async' }) => Promise<void> }).gc
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const collected = async (refs: WeakRef<object>[]): Promise<boolean> => {
  for (let i = 0; i < 50; i++) {
    await gcNow!({ execution: 'async' })
    await tick()
    if (refs.every((r) => r.deref() === undefined)) return true
  }
  return false
}

const counter: Proc<number, number, void> = async function* (self) {
  let n = 0
  for await (const d of self) {
    n += d
    yield n
  }
}

describe.skipIf(gcNow === undefined)('leak suite (nothing retained after dispose)', () => {
  it('a disposed subscriber is released while the process lives — the acto bug', async () => {
    const p = spawn(counter, undefined, { initial: 0 })
    // construct inside a helper so no test-frame local keeps the target alive
    const subscribeAndStop = (): WeakRef<object> => {
      const big = { blob: new Array(10_000).fill(0) }
      const stop = effect(() => {
        void p()
        void big.blob.length
      })
      stop()
      return new WeakRef(big)
    }
    const ref = subscribeAndStop()
    expect(await collected([ref])).toBe(true) // p is still alive and strongly held
    expect(p()).toBe(0)
    p[Symbol.dispose]()
  })

  it('a disposed derive is released while its source process lives', async () => {
    const p = spawn(counter, undefined, { initial: 0 })
    const deriveAndDispose = (): WeakRef<object> => {
      const d = derive(() => new Array(10_000).fill(p()))
      void d()
      d[Symbol.dispose]()
      return new WeakRef(d)
    }
    const ref = deriveAndDispose()
    expect(await collected([ref])).toBe(true)
    p[Symbol.dispose]()
  })

  it('generator locals are released when the process is disposed', async () => {
    const refs: WeakRef<object>[] = []
    const p = spawn(
      async function* (self: Self<number>) {
        const state = { big: new Array(10_000).fill(1) }
        refs.push(new WeakRef(state))
        yield 0
        for await (const msg of self) yield msg + state.big.length
      },
      undefined,
      { initial: -1 },
    )
    await tick()
    p.send(1)
    await tick()
    p[Symbol.dispose]()
    await tick()
    expect(await collected(refs)).toBe(true) // p itself is still strongly held
  })

  it('undelivered mailbox messages are released on dispose', async () => {
    const refs: WeakRef<object>[] = []
    const p = spawn(
      async function* (self: Self<{ blob: number[] }>) {
        yield 0
        for await (const msg of self) {
          await new Promise((resolve) => setTimeout(resolve, 30)) // slow consumer
          yield msg.blob.length
        }
      },
      undefined,
      { initial: 0 },
    )
    await tick()
    const enqueue = (): void => {
      p.send({ blob: new Array(10) }) // being processed (slowly) — not asserted
      const queued = { blob: new Array(10_000).fill(0) }
      refs.push(new WeakRef(queued))
      p.send(queued) // still queued when we dispose
    }
    enqueue()
    p[Symbol.dispose]()
    expect(await collected(refs)).toBe(true)
  })

  it('disposed children leave no trace in the parent', async () => {
    const refs: WeakRef<object>[] = []
    const child: Proc<number, never, { blob: number[] }> = async function* (self, args) {
      yield args.blob.length
      for await (const _ of self) void _
    }
    const parent = spawn(
      async function* (self: Self<never>) {
        const blob = { blob: new Array(10_000).fill(2) }
        refs.push(new WeakRef(blob))
        spawn(child, blob)
        yield 'up'
        for await (const _ of self) void _
      },
      undefined,
    )
    await tick()
    parent[Symbol.dispose]()
    await tick()
    expect(await collected(refs)).toBe(true) // parent still strongly held
  })
})
