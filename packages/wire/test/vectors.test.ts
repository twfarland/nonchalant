// Runs the language-agnostic conformance vectors (spec/vectors/*.json)
// against the reference implementation — the same files a BEAM host
// certifies with. See spec/README.md for the format.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { applyPatch, define, registry } from '@nonchalant/core'
import type { Call, Json, Patch, Proc } from '@nonchalant/core'
import { expose } from '../src/host.ts'
import { decodeHost, type ClientMsg, type HostMsg } from '../src/protocol.ts'
import { memoryPair } from '../src/transport.ts'
import sessionBasic from '../spec/vectors/session-basic.json'
import sessionRelookup from '../spec/vectors/session-relookup.json'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const patchVectors = JSON.parse(
  readFileSync(new URL('../spec/vectors/patches.json', import.meta.url), 'utf8'),
) as { cases: { name: string }[] }

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
type CounterMsg = { type: 'add'; n: number } | Call<{ type: 'get' }, { n: number }>
const counter: Proc<{ n: number }, CounterMsg, { start: number }> = async function* (self, { start }) {
  let n = start
  yield { n }
  for await (const msg of self) {
    if (msg.type === 'add') {
      n += msg.n
      yield { n }
    } else {
      msg.reply({ n })
    }
  }
}

type Step =
  | { recv: ClientMsg }
  | { expect: 'yield'; ref: string; state: Json; full?: boolean }
  | { expect: 'raise'; ref: string }
  | { expect: HostMsg }

const runSession = async (vector: { steps: unknown[] }): Promise<void> => {
  const link = memoryPair()
  const reg = registry({ counter: define(counter) })
  const stop = expose(reg, link.host)
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
    for (const raw of vector.steps) {
      const step = raw as Step
      if ('recv' in step) {
        link.client.send(JSON.stringify(step.recv))
        continue
      }
      const m = await nextMsg()
      if (step.expect === 'yield') {
        expect(m.op).toBe('yield')
        if (m.op !== 'yield') return
        expect(m.ref).toBe(step.ref)
        if (step.full === true) {
          // a full snapshot must reconstruct the state from nothing
          expect(applyPatch(null, m.patch)).toStrictEqual(step.state)
        }
        const next = applyPatch(states.get(step.ref) ?? null, m.patch)
        expect(next).toStrictEqual(step.state)
        states.set(step.ref, next)
      } else if (step.expect === 'raise') {
        expect(m.op).toBe('raise')
        expect(m.ref).toBe(step.ref)
      } else {
        expect(m).toStrictEqual(step.expect)
      }
    }
    await tick()
    expect(received.length).toBe(cursor) // no unexpected extra messages
  } finally {
    stop()
    reg.evict('counter')
  }
}

describe('session vectors', () => {
  it(sessionBasic.description, () => runSession(sessionBasic))
  it(sessionRelookup.description, () => runSession(sessionRelookup))
})
