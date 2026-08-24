// The wire over a Web Worker. The same `lookup` interface, one thread away:
// the grinder's messages become postMessage, its yields come back as patches.
//
// The switch at the top moves the grinder between this thread and the worker
// at runtime — one definition, two registries, identical calling code. Only
// the frame meter can tell which one is running, and that is the whole point:
// a worker registry keeps a heavy process off the thread that draws.

import { cell, define, derive, registry, spawn } from '@nonchalant/core'
import type { Plain, Proc, Process, VNode } from '@nonchalant/core'
import { connect, portTransport } from '@nonchalant/wire'
import { mount } from '@nonchalant/dom'
import { button, div, li, span, ul } from '@nonchalant/dom/tags'
import { primes, FROM, type Lab, type PrimesMsg, type PrimesState } from './primes.ts'

type Grinder = Process<PrimesState | undefined, PrimesMsg>

// ---------- the two registries ----------

const here = registry({ primes: define(primes) })
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
const there = connect<Lab>(portTransport(worker))

const onWorker = cell(true)

const grinder = derive<Grinder>(() =>
  onWorker() ? (there.lookup('primes') as Grinder) : (here.lookup('primes') as Grinder))
const state = derive<PrimesState | undefined>(() => grinder()())

const send = (msg: Plain<PrimesMsg>): void => grinder().send(msg)

// each registry has its own process, so leaving one running would grind in the
// background: stop it on the way out, and it resumes where it left off
const moveTo = (remote: boolean): void => {
  send({ type: 'stop' })
  onWorker.send(remote)
}

// ---------- the frame meter (always on this thread) ----------

type Frames = { angle: number; worst: number }

const frames: Proc<Frames, { type: 'frame'; dt: number }, void> = async function* (self) {
  let angle = 0
  let recent: number[] = []
  yield { angle, worst: 0 }
  for await (const { dt } of self) {
    angle = (angle + dt * 0.24) % 360
    recent = [...recent.slice(-59), dt] // a second of frames
    yield { angle, worst: Math.round(Math.max(...recent)) }
  }
}

const meter = spawn(frames, undefined, { initial: { angle: 0, worst: 0 } })

let previous = performance.now()
const onFrame = (t: number): void => {
  meter.send({ type: 'frame', dt: t - previous })
  previous = t
  requestAnimationFrame(onFrame)
}
requestAnimationFrame(onFrame)

// ---------- components ----------

function ThreadSwitch(where: Process<boolean, boolean>): VNode {
  return div({},
    button({ disabled: () => where(), onclick: () => moveTo(true) }, 'Worker thread'),
    button({ disabled: () => !where(), onclick: () => moveTo(false) }, 'This thread'),
    div({ class: 'muted' }, () =>
      where()
        ? 'connect(portTransport(worker)) — messages out, patches back'
        : 'registry({ primes: define(primes) }) — sharing the thread that draws'))
}

function Controls(now: Process<PrimesState | undefined>): VNode {
  return div({},
    button({ disabled: () => now()?.running === true, onclick: () => send({ type: 'start' }) }, 'Start'),
    button({ disabled: () => now()?.running !== true, onclick: () => send({ type: 'stop' }) }, 'Stop'),
    button({ onclick: () => send({ type: 'reset' }) }, 'Reset'))
}

function Counters(now: Process<PrimesState | undefined>): VNode {
  return div({},
    div({}, 'Odd numbers tested above 10¹²: ', span({ class: 'value' }, () => String(now()?.tested ?? 0))),
    div({}, 'Primes found: ', span({ class: 'value' }, () => String(now()?.count ?? 0))))
}

function Recent(now: Process<PrimesState | undefined>): VNode {
  return ul({ class: 'list' }, () =>
    (now()?.recent ?? []).map((p) => li({ key: p }, String(p))))
}

// everything found stays where it was found; ask() is the one message that
// fetches the whole list, and the answer comes back over the same port
function Export(at: Process<Grinder>): VNode {
  const note = cell('')
  const grab = (): void => {
    void at().ask({ type: 'export' }).then(
      (all) => note.send(all.length === 0 ? 'nothing found yet' : `${all.length} primes, up to ${all.at(-1)}`),
      (e: unknown) => note.send(String(e)))
  }

  return div({},
    button({ onclick: grab }, 'ask() for the full list'),
    span({ class: 'muted' }, note))
}

function FrameMeter(frame: Process<Frames>): VNode {
  return div({ class: 'frames' },
    div({ class: 'sweep' }, div({ class: 'hand', style: () => `transform: rotate(${frame().angle}deg)` })),
    div({},
      div({}, 'Worst frame in the last second: ',
        span({ class: 'value' }, () => `${frame().worst} ms`)),
      div({ class: 'muted' }, '60 fps is one frame every 17 ms. The hand is drawn by this thread, one binding per frame.')))
}

// ---------- the app ----------

function App(): VNode {
  return div({ class: 'card' },
    ThreadSwitch(onWorker),
    div({ class: 'muted' }, `Grinding from ${FROM.toLocaleString('en-US')} upward by trial division.`),
    Controls(state),
    Counters(state),
    Recent(state),
    Export(grinder),
    FrameMeter(meter))
}

mount(document.getElementById('app')!, App())
