// The Store contract as tests an adapter runs against itself. What
// `durable()` and `scheduler()` rely on is here and nowhere else: pass these
// and the crash-consistency properties proved against `memoryStore` hold for
// your storage too. It takes the test runner's `describe`/`it`/`expect` as
// arguments, so it imports no test framework:
//
//   storeConformance((now) => myStore(now), { describe, it, expect })
//
// The two extras a real adapter runs out of band — listing dead letters and
// the answer-retention sweep — are part of the harness because their data is
// written through the port.

import type { Json } from '@nonchalant/core'
import { Fenced } from './store.ts'
import type { DeadLetter, Store } from './store.ts'

export interface ConformanceStore extends Store {
  /** The messages a key gave up on, oldest first. */
  dead(key: string): DeadLetter[] | Promise<DeadLetter[]>
  /** Forget answers committed before `before`, by the clock the store was made with. */
  prune(before: number): void | Promise<void>
}

export interface ConformanceTest {
  describe(name: string, body: () => void): void
  it(name: string, body: () => Promise<void>): void
  expect(actual: unknown): { toBe(expected: unknown): void; toStrictEqual(expected: unknown): void }
}

/**
 * Register the Store conformance tests. `make` is called once per test with
 * the clock the store must stamp committed answers with; each call must
 * return an empty store.
 */
export function storeConformance(
  make: (now: () => number) => ConformanceStore | Promise<ConformanceStore>,
  { describe, it, expect }: ConformanceTest,
): void {
  let clock = 0
  const fresh = async (): Promise<ConformanceStore> => {
    clock = 0
    return make(() => clock)
  }
  const fenced = async (write: Promise<unknown>): Promise<boolean> => {
    try {
      await write
      return false
    } catch (e) {
      return e instanceof Fenced
    }
  }
  const commit = (store: Store, key: string, epoch: number, cursor: number, snapshot: Json | undefined): Promise<void> =>
    store.commit(key, epoch, { snapshot, version: 0, cursor, results: [] })

  describe('Store conformance', () => {
    describe('load', () => {
      it('an unknown key loads empty', async () => {
        const store = await fresh()
        const { epoch, ...rest } = await store.load('k')
        expect(rest).toStrictEqual({ snapshot: undefined, version: 0, cursor: 0 })
        expect(typeof epoch).toBe('number')
      })

      it('every load hands out an epoch above all before it, concurrent loads included', async () => {
        const store = await fresh()
        const first = (await store.load('k')).epoch
        const both = (await Promise.all([store.load('k'), store.load('k')])).map((l) => l.epoch)
        const last = (await store.load('k')).epoch
        expect(both[0] !== both[1] && Math.min(...both) > first && last > Math.max(...both)).toBe(true)
      })

      it('returns what was committed, and loading changes none of it', async () => {
        const store = await fresh()
        const { epoch } = await store.load('k')
        const seq = await store.append('k', epoch, 'm')
        await store.commit('k', epoch, { snapshot: { n: [1, 'two', null, true] }, version: 3, cursor: seq, results: [] })
        const once = await store.load('k')
        const twice = await store.load('k')
        expect({ ...once, epoch: 0 }).toStrictEqual({ snapshot: { n: [1, 'two', null, true] }, version: 3, cursor: seq, epoch: 0 })
        expect({ ...twice, epoch: 0 }).toStrictEqual({ ...once, epoch: 0 })
      })

      it('keeps a null snapshot apart from none', async () => {
        const store = await fresh()
        const a = await store.load('a')
        await commit(store, 'a', a.epoch, 0, null)
        const b = await store.load('b')
        await commit(store, 'b', b.epoch, 0, undefined)
        expect((await store.load('a')).snapshot).toBe(null)
        expect((await store.load('b')).snapshot).toBe(undefined)
      })
    })

    describe('append and pending', () => {
      it('hands out increasing sequence numbers above 0 and replays in that order', async () => {
        const store = await fresh()
        const { epoch } = await store.load('k')
        const one = await store.append('k', epoch, { type: 'a' })
        const two = await store.append('k', epoch, { type: 'b' }, 'call-1')
        const three = await store.append('k', epoch, 3)
        expect(one > 0 && two > one && three > two).toBe(true)
        expect(await store.pending('k', 0)).toStrictEqual([
          { seq: one, msg: { type: 'a' } },
          { seq: two, msg: { type: 'b' }, callId: 'call-1' },
          { seq: three, msg: 3 },
        ])
        expect((await store.pending('k', one)).map((l) => l.seq)).toStrictEqual([two, three])
      })

      it('keeps concurrent appends distinct and in sequence order', async () => {
        const store = await fresh()
        const { epoch } = await store.load('k')
        const seqs = await Promise.all(Array.from({ length: 10 }, (_, i) => store.append('k', epoch, i)))
        const logged = await store.pending('k', 0)
        expect(new Set(seqs).size).toBe(10)
        expect(logged.map((l) => l.seq)).toStrictEqual([...seqs].sort((a, b) => a - b))
      })

      it('never reuses a sequence number, across commits and activations', async () => {
        const store = await fresh()
        const first = await store.load('k')
        const one = await store.append('k', first.epoch, 'a')
        await commit(store, 'k', first.epoch, one, 1)
        const second = await store.load('k')
        const two = await store.append('k', second.epoch, 'b')
        expect(two > one).toBe(true)
        expect(await store.pending('k', one)).toStrictEqual([{ seq: two, msg: 'b' }])
      })

      it('keeps keys apart', async () => {
        const store = await fresh()
        const a = await store.load('a')
        const b = await store.load('b')
        await store.append('a', a.epoch, 'for a')
        await store.append('b', b.epoch, 'for b')
        expect((await store.pending('a', 0)).map((l) => l.msg)).toStrictEqual(['for a'])
        expect((await store.pending('b', 0)).map((l) => l.msg)).toStrictEqual(['for b'])
      })
    })

    describe('steps', () => {
      it('records effects and failed attempts per message, in the order written', async () => {
        const store = await fresh()
        const { epoch } = await store.load('k')
        const one = await store.append('k', epoch, 'a')
        const two = await store.append('k', epoch, 'b')
        await store.putStep('k', epoch, one, 0, 'charge', { id: 'r1' })
        await store.putStep('k', epoch, one, -1, 'attempt', 'Error: boom')
        await store.putStep('k', epoch, one, 1, 'ship', null)
        await store.putStep('k', epoch, two, 0, 'other', 2)
        expect(await store.steps('k', one)).toStrictEqual([
          { index: 0, name: 'charge', result: { id: 'r1' } },
          { index: -1, name: 'attempt', result: 'Error: boom' },
          { index: 1, name: 'ship', result: null },
        ])
        expect(await store.steps('k', two)).toStrictEqual([{ index: 0, name: 'other', result: 2 }])
        expect(await store.steps('k', two + 1)).toStrictEqual([])
      })
    })

    describe('commit', () => {
      it('acknowledges the message: the cursor moves and pending starts after it', async () => {
        const store = await fresh()
        const { epoch } = await store.load('k')
        const one = await store.append('k', epoch, 'a')
        const two = await store.append('k', epoch, 'b')
        await commit(store, 'k', epoch, one, { n: 1 })
        expect((await store.load('k')).cursor).toBe(one)
        expect(await store.pending('k', one)).toStrictEqual([{ seq: two, msg: 'b' }])
      })

      it('records the answers given, per key, and nothing for a call never answered', async () => {
        const store = await fresh()
        const { epoch } = await store.load('k')
        const seq = await store.append('k', epoch, 'a')
        const answers: [string, Json][] = [['c1', 'receipt'], ['c2', { ok: true }], ['c3', null], ['c4', 0], ['c5', false]]
        await store.commit('k', epoch, { snapshot: 1, version: 0, cursor: seq, results: answers })
        for (const [callId, answer] of answers) expect(await store.result('k', callId)).toStrictEqual(answer)
        expect(await store.result('k', 'c6')).toBe(undefined)
        expect(await store.result('other', 'c1')).toBe(undefined)
      })

      it('keeps answers after later commits', async () => {
        const store = await fresh()
        const { epoch } = await store.load('k')
        const one = await store.append('k', epoch, 'a')
        await store.commit('k', epoch, { snapshot: 1, version: 0, cursor: one, results: [['c1', 'first']] })
        const two = await store.append('k', epoch, 'b')
        await store.commit('k', epoch, { snapshot: 2, version: 0, cursor: two, results: [] })
        expect(await store.result('k', 'c1')).toBe('first')
      })

      it('writes a dead letter with the snapshot it was given, and lists dead letters in order', async () => {
        const store = await fresh()
        const { epoch } = await store.load('k')
        const one = await store.append('k', epoch, { type: 'bad' }, 'call-9')
        await store.commit('k', epoch, { snapshot: { before: true }, version: 0, cursor: one, results: [], dead: { seq: one, msg: { type: 'bad' }, callId: 'call-9', error: 'Error: one' } })
        const two = await store.append('k', epoch, 'worse')
        await store.commit('k', epoch, { snapshot: { before: true }, version: 0, cursor: two, results: [], dead: { seq: two, msg: 'worse', error: 'Error: two' } })
        expect(await store.dead('k')).toStrictEqual([
          { seq: one, msg: { type: 'bad' }, callId: 'call-9', error: 'Error: one' },
          { seq: two, msg: 'worse', error: 'Error: two' },
        ])
        expect(await store.dead('other')).toStrictEqual([])
        expect({ ...(await store.load('k')), epoch: 0 }).toStrictEqual({ snapshot: { before: true }, version: 0, cursor: two, epoch: 0 })
      })
    })

    describe('epoch fencing', () => {
      it('refuses every write under a superseded epoch with Fenced, and changes nothing', async () => {
        const store = await fresh()
        const old = await store.load('k')
        const seq = await store.append('k', old.epoch, 'kept')
        await store.putStep('k', old.epoch, seq, 0, 'kept', 1, 500)
        const current = await store.load('k')

        expect(await fenced(store.append('k', old.epoch, 'stale'))).toBe(true)
        expect(await fenced(store.putStep('k', old.epoch, seq, 1, 'stale', 2, 100))).toBe(true)
        expect(await fenced(store.commit('k', old.epoch, {
          snapshot: 'stale', version: 9, cursor: seq, results: [['c', 'stale']], dead: { seq, msg: 'kept', error: 'stale' },
        }))).toBe(true)

        expect(await store.pending('k', 0)).toStrictEqual([{ seq, msg: 'kept' }])
        expect(await store.steps('k', seq)).toStrictEqual([{ index: 0, name: 'kept', result: 1 }])
        expect(await store.result('k', 'c')).toBe(undefined)
        expect(await store.dead('k')).toStrictEqual([])
        expect(await store.due(499, 499, 10)).toStrictEqual([]) // the stale wake did not land either
        expect({ ...(await store.load('k')), epoch: 0 }).toStrictEqual({ snapshot: undefined, version: 0, cursor: 0, epoch: 0 })
        expect(current.epoch > old.epoch).toBe(true)
      })

      it('accepts writes under the newest epoch', async () => {
        const store = await fresh()
        await store.load('k')
        const { epoch } = await store.load('k')
        const seq = await store.append('k', epoch, 'm')
        await store.putStep('k', epoch, seq, 0, 's', 1)
        await commit(store, 'k', epoch, seq, 1)
        expect((await store.load('k')).cursor).toBe(seq)
      })

      it('refuses a write to a key that was never loaded', async () => {
        const store = await fresh()
        expect(await fenced(store.append('never', 1, 'm'))).toBe(true)
      })
    })

    describe('wake times and due', () => {
      it('a step with a wake time makes its key due at that time, not before', async () => {
        const store = await fresh()
        const { epoch } = await store.load('k')
        const seq = await store.append('k', epoch, 'm')
        await store.putStep('k', epoch, seq, 0, 'nap:deadline', 1000, 1000)
        expect(await store.due(999, 999, 10)).toStrictEqual([])
        expect(await store.due(1000, 1000, 10)).toStrictEqual(['k'])
      })

      it('leases what it hands out: hidden until `until`, then due again', async () => {
        const store = await fresh()
        const { epoch } = await store.load('k')
        const seq = await store.append('k', epoch, 'm')
        await store.putStep('k', epoch, seq, 0, 'nap:deadline', 100, 100)
        expect(await store.due(100, 600, 10)).toStrictEqual(['k'])
        expect(await store.due(599, 1000, 10)).toStrictEqual([])
        expect(await store.due(600, 1000, 10)).toStrictEqual(['k'])
      })

      it('hands a due key to only one of two concurrent callers', async () => {
        const store = await fresh()
        const { epoch } = await store.load('k')
        const seq = await store.append('k', epoch, 'm')
        await store.putStep('k', epoch, seq, 0, 'nap:deadline', 100, 100)
        const [a, b] = await Promise.all([store.due(100, 1000, 10), store.due(100, 1000, 10)])
        expect([...(a ?? []), ...(b ?? [])]).toStrictEqual(['k'])
      })

      it('lists earliest first, at most `limit`', async () => {
        const store = await fresh()
        for (const [key, at] of [['c', 300], ['a', 100], ['b', 200]] as const) {
          const { epoch } = await store.load(key)
          const seq = await store.append(key, epoch, 'm')
          await store.putStep(key, epoch, seq, 0, 'nap:deadline', at, at)
        }
        expect(await store.due(1000, 5000, 2)).toStrictEqual(['a', 'b'])
        expect(await store.due(1000, 5000, 2)).toStrictEqual(['c'])
      })

      it('a later wake time replaces an earlier one; a step without one leaves it alone', async () => {
        const store = await fresh()
        const { epoch } = await store.load('k')
        const seq = await store.append('k', epoch, 'm')
        await store.putStep('k', epoch, seq, 0, 'nap:deadline', 100, 100)
        await store.putStep('k', epoch, seq, 1, 'nap2:deadline', 800, 800)
        await store.putStep('k', epoch, seq, 2, 'plain', 1)
        expect(await store.due(799, 799, 10)).toStrictEqual([])
        expect(await store.due(800, 800, 10)).toStrictEqual(['k'])
      })

      it('commit clears the wake time, dead-lettering included', async () => {
        const store = await fresh()
        for (const key of ['ok', 'dead']) {
          const { epoch } = await store.load(key)
          const seq = await store.append(key, epoch, 'm')
          await store.putStep(key, epoch, seq, 0, 'nap:deadline', 100, 100)
          await store.commit(key, epoch, key === 'ok'
            ? { snapshot: 1, version: 0, cursor: seq, results: [] }
            : { snapshot: 1, version: 0, cursor: seq, results: [], dead: { seq, msg: 'm', error: 'x' } })
        }
        expect(await store.due(10_000, 10_000, 10)).toStrictEqual([])
      })

      it('a key with no wake time is never due', async () => {
        const store = await fresh()
        const { epoch } = await store.load('k')
        await store.append('k', epoch, 'm')
        expect(await store.due(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 10)).toStrictEqual([])
      })
    })

    describe('answer retention', () => {
      it('prune forgets answers committed before the cutoff and keeps the rest', async () => {
        const store = await fresh()
        const { epoch } = await store.load('k')
        await store.commit('k', epoch, { snapshot: null, version: 0, cursor: 0, results: [['old', 1]] })
        clock = 100
        await store.commit('k', epoch, { snapshot: null, version: 0, cursor: 0, results: [['new', 2]] })
        await store.prune(50)
        expect(await store.result('k', 'old')).toBe(undefined)
        expect(await store.result('k', 'new')).toBe(2)
      })
    })
  })
}
