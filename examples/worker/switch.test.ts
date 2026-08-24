// @vitest-environment happy-dom
//
// The demo's headline claim, asserted: the calling code does not change when
// the grinder moves. One derive picks the registry, the bindings beneath it
// follow, and each registry keeps its own process — so coming back finds the
// progress that was left there. memoryPair() stands in for the worker port;
// what is being tested is the substitution, not postMessage.

import { describe, it, expect } from 'vitest'
import { cell, define, derive, registry } from '@nonchalant/core'
import type { Process } from '@nonchalant/core'
import { connect, expose, memoryPair } from '@nonchalant/wire'
import { mount } from '@nonchalant/dom'
import { div, span } from '@nonchalant/dom/tags'
import { primes, type Lab, type PrimesMsg, type PrimesState } from './primes.ts'

type Grinder = Process<PrimesState | undefined, PrimesMsg>

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

describe('moving the grinder', () => {
  it('keeps the bindings and gives each registry its own process', async () => {
    const here = registry({ primes: define(primes) })
    const link = memoryPair()
    expose(registry({ primes: define(primes) }), link.host)
    const there = connect<Lab>(link.client)

    const onWorker = cell(true)
    const grinder = derive<Grinder>(() =>
      onWorker() ? (there.lookup('primes') as Grinder) : (here.lookup('primes') as Grinder))
    const state = derive<PrimesState | undefined>(() => grinder()())

    const el = document.createElement('div')
    mount(el, div({}, span({}, () => String(state()?.tested ?? -1))))
    await settle()
    expect(el.textContent).toBe('0') // the remote snapshot, applied as a patch

    grinder().cast({ type: 'start' })
    await settle()
    await settle()
    const remote = Number(el.textContent)
    expect(remote).toBeGreaterThan(0)
    grinder().cast({ type: 'stop' })

    onWorker.cast(false)
    await settle()
    expect(el.textContent).toBe('0') // the local registry: a fresh process

    onWorker.cast(true)
    await settle()
    expect(Number(el.textContent)).toBe(remote) // the remote one kept what it had
  })
})
