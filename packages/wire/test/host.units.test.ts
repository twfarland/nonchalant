// The host half's pure pieces as plain functions: error encoding, message
// screening, callId namespacing, and one watch's patch stream. expose() over
// a transport is covered end to end in wire.test.ts and wire.edges.test.ts.

import { describe, it, expect } from 'vitest'
import type { HostMsg } from '../src/protocol.ts'
import { errorJson, namespaceCallId, screen } from '../src/screen.ts'
import { openWatch, type HostProcess, type Watch } from '../src/watch.ts'

// ---------- errorJson ----------

describe('errorJson', () => {
  it('carries an Error by its message and anything else by String()', () => {
    expect(errorJson(new Error('boom'))).toStrictEqual({ message: 'boom' })
    expect(errorJson('plain')).toStrictEqual({ message: 'plain' })
    expect(errorJson(42)).toStrictEqual({ message: '42' })
    expect(errorJson(undefined)).toStrictEqual({ message: 'undefined' })
  })

  it('adds the call id only when there is one, including id 0', () => {
    expect(errorJson(new Error('no'), 7)).toStrictEqual({ message: 'no', id: 7 })
    expect(errorJson(new Error('no'), 0)).toStrictEqual({ message: 'no', id: 0 })
    expect('id' in (errorJson(new Error('no')) as object)).toBe(false)
  })
})

// ---------- namespaceCallId ----------

describe('namespaceCallId', () => {
  it('wraps a string callId with the principal as a JSON pair, keeping every other field', () => {
    expect(namespaceCallId({ type: 'pay', callId: 'c1', amount: 3 }, 'alice'))
      .toStrictEqual({ type: 'pay', callId: '["alice","c1"]', amount: 3 })
  })

  it('returns the message itself when there is no principal, no callId, or a non-string one', () => {
    const cases = [
      [{ type: 't', callId: 'c1' }, undefined],
      [{ type: 't' }, 'alice'],
      [{ type: 't', callId: 5 }, 'alice'],
      ['not a record', 'alice'],
      [['callId'], 'alice'],
    ] as const
    for (const [msg, principal] of cases) expect(namespaceCallId(msg as never, principal)).toBe(msg)
  })

  it('is injective across principal and id boundaries', () => {
    const a = namespaceCallId({ type: 't', callId: 'b:c' }, 'a') as { callId: string }
    const b = namespaceCallId({ type: 't', callId: 'c' }, 'a:b') as { callId: string }
    expect(a.callId).not.toBe(b.callId)
  })
})

// ---------- screen ----------

describe('screen', () => {
  const shape = 'invalid message: expected an object with a string type'
  const shapeCases: [string, unknown][] = [
    ['null', null],
    ['a string', 'add'],
    ['an array', [{ type: 'add' }]],
    ['a missing type', { by: 1 }],
    ['a numeric type', { type: 1 }],
  ]
  for (const [name, msg] of shapeCases)
    it(`refuses ${name} before admit ever sees it`, () => {
      let admitted = 0
      const r = screen(msg, 'cart', { admit: () => { admitted++; return null } })
      expect(r).toBeInstanceOf(Error)
      expect((r as Error).message).toBe(shape)
      expect(admitted).toBe(0)
    })

  it('with no admit and no principal delivers the message itself', () => {
    const msg = { type: 'add', callId: 'c' }
    expect(screen(msg, 'cart', {})).toBe(msg)
  })

  it('passes the name and message to admit, called on the gateway', () => {
    const seen: unknown[] = []
    const gate = {
      tag: 'gw',
      admit(this: { tag: string }, name: string, msg: { type: string }) {
        seen.push(this.tag, name, msg.type)
        return msg
      },
    }
    screen({ type: 'add' }, 'cart', gate)
    expect(seen).toStrictEqual(['gw', 'cart', 'add'])
  })

  it('delivers what admit returns, then namespaces its callId', () => {
    const r = screen({ type: 'pay', callId: 'x' }, 'cart', {
      admit: (_name, msg) => ({ ...msg, sender: 'server' }),
      principal: 'bob',
    })
    expect(r).toStrictEqual({ type: 'pay', callId: '["bob","x"]', sender: 'server' })
  })

  it('an admit that returns undefined or throws refuses the message', () => {
    const refused = screen({ type: 'add' }, 'cart', { admit: () => undefined })
    const threw = screen({ type: 'add' }, 'cart', { admit: () => { throw new Error('bad') } })
    expect((refused as Error).message).toBe('message refused')
    expect((threw as Error).message).toBe('message refused')
  })

  it('an admit may replace the message with any JSON, even null', () => {
    expect(screen({ type: 'add' }, 'cart', { admit: () => null })).toBe(null)
  })
})

// ---------- openWatch ----------

/** A stand-in process: yields the given values, then ends (or throws) and exposes `error`. */
const fakeProc = (values: unknown[], end?: { throws?: unknown; error?: unknown }): HostProcess & { returned: number } => {
  const proc = {
    returned: 0,
    error: undefined as unknown,
    [Symbol.asyncIterator]: () => {
      let i = 0
      return {
        next: async () => {
          if (i < values.length) return { done: false, value: values[i++] }
          if (end?.throws !== undefined) throw end.throws
          proc.error = end?.error
          return { done: true, value: undefined }
        },
        return: async () => {
          proc.returned++
          return { done: true, value: undefined }
        },
      }
    },
  }
  return proc as unknown as HostProcess & { returned: number }
}

const drain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('openWatch', () => {
  it('sends a full snapshot first, then only non-empty patches between observed values', async () => {
    const sent: HostMsg[] = []
    const ends: HostMsg[] = []
    const s1 = { n: 1, list: [1] }
    openWatch('r1', 'counter', fakeProc([s1, s1, { ...s1, n: 2 }]), (m) => sent.push(m), (_w, last) => ends.push(last))
    await drain()
    expect(sent).toStrictEqual([
      { op: 'yield', ref: 'r1', patch: [['set', '', { n: 1, list: [1] }]] },
      { op: 'yield', ref: 'r1', patch: [['set', '/n', 2]] },
    ])
    expect(ends).toStrictEqual([{ op: 'done', ref: 'r1' }])
  })

  it('reports a process that ended with an error as a raise', async () => {
    const ends: HostMsg[] = []
    openWatch('r1', 'p', fakeProc([1], { error: new Error('crashed') }), () => {}, (_w, last) => ends.push(last))
    await drain()
    expect(ends).toStrictEqual([{ op: 'raise', ref: 'r1', error: { message: 'crashed' } }])
  })

  it('reports an iteration that throws as a raise', async () => {
    const ends: HostMsg[] = []
    openWatch('r1', 'p', fakeProc([], { throws: 'torn' }), () => {}, (_w, last) => ends.push(last))
    await drain()
    expect(ends).toStrictEqual([{ op: 'raise', ref: 'r1', error: { message: 'torn' } }])
  })

  it('hands finish the watch itself, carrying its name and process', async () => {
    const proc = fakeProc([])
    let seen: Watch | undefined
    const w = openWatch('r1', 'cart', proc, () => {}, (watch) => { seen = watch })
    await drain()
    expect(seen).toBe(w)
    expect(w.name).toBe('cart')
    expect(w.proc).toBe(proc)
  })

  it('once stopped, sends nothing more, returns the iterator, and never calls finish', async () => {
    const sent: HostMsg[] = []
    let finished = 0
    const proc = fakeProc([1, 2, 3])
    const w = openWatch('r1', 'p', proc, (m) => sent.push(m), () => finished++)
    w.stop()
    await drain()
    expect(sent).toHaveLength(1) // the value already requested when stop ran
    expect(proc.returned).toBe(1)
    expect(finished).toBe(0)
  })
})
