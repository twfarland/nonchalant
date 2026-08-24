// Headless, and deliberately without a Worker: what the demo claims lives in
// the state module and in the transport, so a MessageChannel proves both —
// the same expose/connect halves the WebSocket host uses, over a port.

import { describe, it, expect } from 'vitest'
import { define, registry, spawn } from '@nonchalant/core'
import type { Process } from '@nonchalant/core'
import { connect, expose, portTransport, type MessageEndpoint } from '@nonchalant/wire'
import { CHUNK, primes, type Lab, type PrimesMsg, type PrimesState } from './primes.ts'

type Grinder = Process<PrimesState | undefined, PrimesMsg>

const until = async (ready: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 5000
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

describe('primes: a process that grinds', () => {
  it('runs chunk by chunk and hears stop between chunks', async () => {
    const p = spawn(primes, undefined)
    p.cast({ type: 'start' })
    await until(() => (p()?.tested ?? 0) >= CHUNK, 'the first chunk')

    p.cast({ type: 'stop' })
    await settle()
    const stoppedAt = p()!.tested
    await settle()
    expect(p()!.running).toBe(false)
    expect(p()!.tested).toBe(stoppedAt)
    expect(p()!.count).toBeGreaterThan(0)
    p[Symbol.dispose]()
  })
})

describe('primes over a port', () => {
  it('carries state as patches and the full list only when asked', async () => {
    const { port1, port2 } = new MessageChannel()
    const stopHosting = expose(registry({ primes: define(primes) }), portTransport(port1 as unknown as MessageEndpoint))
    const there = connect<Lab>(portTransport(port2 as unknown as MessageEndpoint))
    const remote = there.lookup('primes') as Grinder

    await until(() => remote() !== undefined, 'the first snapshot')
    remote.cast({ type: 'start' })
    await until(() => (remote()?.count ?? 0) > 6, 'more primes than a yield carries')
    remote.cast({ type: 'stop' })
    await settle()

    const seen = remote()!
    expect(seen.recent).toHaveLength(6) // the working set stays in the process
    expect(seen.count).toBeGreaterThan(6)

    const all = await remote.call({ type: 'export' })
    expect(all).toHaveLength(seen.count)
    expect(all.slice(-6)).toEqual(seen.recent)

    remote[Symbol.dispose]()
    stopHosting()
    port1.close()
    port2.close()
  })
})
