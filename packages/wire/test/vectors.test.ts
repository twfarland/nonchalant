// Runs the language-agnostic conformance vectors (spec/vectors/*.json)
// against the reference implementation — the same files a BEAM host
// certifies with. See spec/README.md for the format.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { isDeepStrictEqual as same } from 'node:util'
import { applyPatch, define, registry } from '@nonchalant/core'
import type { Call, Cast, Json, Patch, Proc } from '@nonchalant/core'
import { expose, type ExposeOpts } from '../src/host.ts'
import { decodeHost, isRecord, type HostMsg } from '../src/protocol.ts'
import { memoryPair } from '../src/transport.ts'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const dir = new URL('../spec/vectors/', import.meta.url)
const load = (file: string): unknown => JSON.parse(readFileSync(new URL(file, dir), 'utf8'))
const patchVectors = load('patches.json') as { cases: { name: string }[] }

describe('patch vectors', () => {
  for (const c of patchVectors.cases) {
    it(c.name, () => {
      const kase = c as unknown as { prev: Json; patch: Patch; next?: Json; error?: boolean }
      if (kase.error === true) {
        expect(() => applyPatch(kase.prev, kase.patch)).toThrow()
      } else {
        expect(applyPatch(kase.prev, kase.patch)).toStrictEqual(kase.next)
      }
    })
  }
})

// the canonical counter process from spec/README.md
type CounterMsg =
  | Cast<{ type: 'add'; n: number }>
  | Cast<{ type: 'stop' }>
  | Cast<{ type: 'crash' }>
  | Call<{ type: 'get' }, { n: number }>
  | Call<{ type: 'reset' }, { n: number }>
  | Call<{ type: 'echo'; value?: Json }, Json | undefined>

const counter: Proc<{ n: number }, CounterMsg, { start: number }> = async function* (self, { start }) {
  let n = start
  yield { n }
  for await (const msg of self) {
    switch (msg.type) {
      case 'add':
        n += msg.n
        break
      case 'stop':
        return
      case 'crash':
        throw new Error('crash')
      case 'get':
        msg.reply({ n })
        continue
      case 'reset':
        msg.reply({ n })
        n = 0
        break
      case 'echo':
        msg.reply(msg.value)
        continue
    }
    yield { n }
  }
}

type Expectation =
  | { expect: 'yield'; ref: string; state: Json; full?: boolean }
  | { expect: 'raise'; ref: string; id?: number }
  | { expect: HostMsg }

type Step = { recv: Json } | { unordered: Expectation[] } | Expectation

interface Vector {
  description: string
  host?: ExposeOpts
  steps: Step[]
}

/** Does `m` satisfy `e`? A matching yield advances its ref's running state. */
const matches = (e: Expectation, m: HostMsg, states: Map<string, Json>): boolean => {
  if (e.expect === 'yield') {
    if (m.op !== 'yield' || m.ref !== e.ref) return false
    // a full snapshot must reconstruct the state from nothing
    if (e.full === true && !same(applyPatch(null, m.patch), e.state)) return false
    const next = applyPatch(states.get(e.ref) ?? null, m.patch)
    if (!same(next, e.state)) return false
    states.set(e.ref, next)
    return true
  }
  if (e.expect === 'raise') {
    if (m.op !== 'raise' || m.ref !== e.ref) return false
    const id = isRecord(m.error) ? m.error['id'] : undefined
    return id === e.id // an expectation without an id is a process-level raise: the error carries none
  }
  return same(m, e.expect)
}

const runSession = async (vector: Vector): Promise<void> => {
  const link = memoryPair()
  const reg = registry({ counter: define(counter) })
  const stop = expose(reg, link.host, vector.host)
  const received: HostMsg[] = []
  link.client.subscribe({
    message: (data) => {
      const m = decodeHost(data)
      if (m !== null) received.push(m)
    },
  })
  let cursor = 0
  const nextMsg = async (): Promise<HostMsg> => {
    for (let i = 0; i < 50 && cursor >= received.length; i++) await tick()
    if (cursor >= received.length) throw new Error('expected a host message; none arrived')
    return received[cursor++] as HostMsg
  }
  const states = new Map<string, Json>()
  try {
    for (const step of vector.steps) {
      if ('recv' in step) {
        link.client.send(JSON.stringify(step.recv))
      } else if ('unordered' in step) {
        const left = [...step.unordered]
        for (let k = 0; k < step.unordered.length; k++) {
          const m = await nextMsg()
          const i = left.findIndex((e) => matches(e, m, states))
          expect(i, `unexpected ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(0)
          left.splice(i, 1)
        }
      } else {
        const m = await nextMsg()
        expect(matches(step, m, states), `expected ${JSON.stringify(step)}, got ${JSON.stringify(m)}`).toBe(true)
      }
    }
    await tick()
    expect(received.slice(cursor)).toStrictEqual([]) // no unexpected extra messages
  } finally {
    stop()
    reg.evict('counter')
  }
}

describe('session vectors', () => {
  const files = readdirSync(dir).filter((f) => f.startsWith('session-') && f.endsWith('.json')).sort()

  it('the vector set covers every session file the spec names', () => {
    expect(files).toStrictEqual([
      'session-basic.json',
      'session-call-errors.json',
      'session-crash.json',
      'session-done.json',
      'session-relookup.json',
      'session-reply-order.json',
      'session-two-refs.json',
      'session-values.json',
      'session-version.json',
      'session-watch-cap.json',
    ])
  })

  for (const file of files) {
    const vector = load(file) as Vector
    it(`${file}: ${vector.description}`, () => runSession(vector))
  }
})
