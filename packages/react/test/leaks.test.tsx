// @vitest-environment happy-dom
//
// Nothing retained after unmount: StrictMode's double render and double
// subscribe must not leave a process, a derive, or a subscription behind.
// Runs under --expose-gc (vitest.config.ts); skipped if gc is unavailable.

import { describe, it, expect } from 'vitest'
import { StrictMode, act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { spawn } from '@nonchalant/core'
import type { Proc, Self } from '@nonchalant/core'
import { useDerive, useProcess, useSpawn } from '@nonchalant/react'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// gc({execution:'async'}) collects from a clean stack — plain gc() leaves V8's
// conservative stack scanning treating stale stack slots as live references
const gcNow = (globalThis as { gc?: (o: { execution: 'async' }) => Promise<void> }).gc
const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const collected = async (refs: WeakRef<object>[]): Promise<boolean> => {
  for (let i = 0; i < 50; i++) {
    await gcNow!({ execution: 'async' })
    await tick()
    if (refs.every((r) => r.deref() === undefined)) return true
  }
  return false
}

describe.skipIf(gcNow === undefined)('react leak suite (nothing retained after unmount)', () => {
  it('releases every process useSpawn created under StrictMode, and every selection over a live process', async () => {
    const source = spawn<number, number, void>(async function* (self) {
      let n = 0
      yield n
      for await (const by of self) {
        n += by
        yield n
      }
    }, undefined, { initial: 0 })

    const refs: WeakRef<object>[] = []
    const selections: WeakRef<object>[] = []
    const owned: Proc<{ blob: number[] }, never, void> = async function* (self: Self<never>) {
      refs.push(new WeakRef(self))
      const state = { blob: new Array<number>(10_000).fill(0) }
      refs.push(new WeakRef(state))
      yield state
      for await (const _ of self) yield state
    }

    function Owner(): ReactNode {
      const mine = useProcess(useSpawn(owned, undefined))
      const doubled = useDerive(() => {
        const result = { twice: source() * 2 }
        selections.push(new WeakRef(result))
        return result
      }, [])
      return <b>{mine?.blob.length ?? 0}:{doubled.twice}</b>
    }

    // a helper frame, so no test-frame local keeps the tree alive
    const mountAndUnmount = async (): Promise<void> => {
      const root = createRoot(document.createElement('div'))
      await act(async () => root.render(<StrictMode><Owner /></StrictMode>))
      await act(async () => { source.cast(1); await tick() })
      await act(async () => root.unmount())
    }
    await mountAndUnmount()
    await tick(1_100) // the grace for the render StrictMode discarded

    expect(refs).toHaveLength(4) // two spawns, each with its state
    expect(await collected(refs)).toBe(true)
    expect(await collected(selections)).toBe(true)
    source[Symbol.dispose]()
  })
})
