// The wire between threads. A deliberately dumb prime grinder — trial division
// above a trillion — runs in a Worker; this file never touches it, only reads
// its state. The lookup, the casts, and the patches are the same ones the
// in-tab and server versions use: all that changed is the transport.

import { cell, define, registry, spawn } from '@nonchalant/core'
import type { Process, Self } from '@nonchalant/core'
import { connect, expose, portTransport, type MessageEndpoint, type Transport } from '@nonchalant/wire'
import { mount } from '@nonchalant/dom'
import { button, div, span } from '@nonchalant/dom/tags'
import { primes, type Lab, type PrimesMsg, type PrimesState } from '../../examples/worker/primes.ts'

const worker = typeof Worker === 'undefined'
  ? null
  : new Worker(new URL('./grind.worker.ts', import.meta.url), { type: 'module' })

// One host, reached two ways. In a browser it is that Worker; where there is
// no Worker (this page's tests run in a DOM shim) the very same host runs in
// this thread over a MessageChannel. Nothing below this line can tell.
const link = (): Transport => {
  if (worker !== null) return portTransport(worker)
  const { port1, port2 } = new MessageChannel()
  expose(registry({ primes: define(primes) }), portTransport(port1 as unknown as MessageEndpoint))
  return portTransport(port2 as unknown as MessageEndpoint)
}

export function run(host: Element): Disposable {
  const grinder = connect<Lab>(link()).lookup('primes') as Process<PrimesState | undefined, PrimesMsg>

  // proof that this thread is idle: a hand drawn per frame, and the worst gap
  // between two frames while the grinder was running
  const meter = spawn(async function* (self: Self<number>) {
    let angle = 0
    let worst = 0
    yield { angle, worst }
    for await (const dt of self) {
      angle = (angle + dt * 0.3) % 360
      worst = Math.max(worst, Math.round(dt))
      yield { angle, worst }
    }
  }, undefined, { initial: { angle: 0, worst: 0 } })

  let frame = 0
  let last = 0
  const tick = (t: number): void => {
    if (last !== 0) meter.cast(t - last)
    last = t
    frame = requestAnimationFrame(tick)
  }

  const start = (): void => {
    grinder.cast({ type: 'start' })
    if (frame === 0) {
      last = 0
      frame = requestAnimationFrame(tick)
    }
  }
  const stop = (): void => {
    grinder.cast({ type: 'stop' })
    cancelAnimationFrame(frame)
    frame = 0
  }

  const view = mount(host, div({ class: 'stack' },
    div({ class: 'row' },
      button({ onclick: start, disabled: () => grinder()?.running === true }, 'grind primes'),
      button({ onclick: stop, disabled: () => grinder()?.running !== true }, 'stop'),
      div({ class: 'sweep' }, div({ class: 'hand', style: () => `transform: rotate(${meter().angle}deg)` }))),
    div({ class: 'readout' }, () =>
      `${grinder()?.tested ?? 0} tested · ${grinder()?.count ?? 0} primes · last ${grinder()?.recent.at(-1) ?? '—'}`),
    div({ class: 'muted' }, () =>
      `worst frame on this thread: ${meter().worst} ms${worker === null ? ' (host in this thread)' : ''}`)))

  return {
    [Symbol.dispose]: () => {
      stop()
      view[Symbol.dispose]()
      meter[Symbol.dispose]()
      grinder[Symbol.dispose]()
      worker?.terminate()
    },
  }
}
