import { describe, it, expect } from 'vitest'
import { drain, enqueue, schedule } from '../src/queue.ts'
import { WATCHING, type Link, type ReactiveNode } from '../src/system.ts'

type Fake = ReactiveNode & { name: string }

/** An effect node; `owner` makes it a child effect of that one (the ownership link enqueue walks). */
function fx(name: string, owner?: Fake): Fake {
  const node: Fake = { name, flags: WATCHING, deps: undefined, depsTail: undefined, subs: undefined, subsTail: undefined }
  if (owner !== undefined) {
    const l: Link = { version: 0, dep: node, sub: owner, prevSub: undefined, nextSub: undefined, prevDep: undefined, nextDep: undefined }
    node.subs = node.subsTail = l
  }
  return node
}

const runLog = (log: string[]) => (n: Fake): void => void log.push(n.name)

describe('enqueue', () => {
  it('queues a lone effect and clears its WATCHING bit', () => {
    const a = fx('a')
    const log: string[] = []
    enqueue(a)
    expect(a.flags & WATCHING).toBe(0)
    drain(runLog(log))
    expect(log).toEqual(['a'])
  })

  it('queues the watching owners above an effect too, outermost first', () => {
    const root = fx('root')
    const mid = fx('mid', root)
    const leaf = fx('leaf', mid)
    const log: string[] = []
    enqueue(leaf)
    drain(runLog(log))
    expect(log).toEqual(['root', 'mid', 'leaf'])
    expect([root.flags, mid.flags, leaf.flags]).toEqual([0, 0, 0])
  })

  it('stops climbing at an owner that is already queued (WATCHING cleared)', () => {
    const root = fx('root')
    const child = fx('child', root)
    const other = fx('other', root)
    const log: string[] = []
    enqueue(child)
    enqueue(other)
    drain(runLog(log))
    expect(log).toEqual(['root', 'child', 'other'])
  })

  it('keeps separate bursts in arrival order', () => {
    const log: string[] = []
    enqueue(fx('first'))
    enqueue(fx('second'))
    drain(runLog(log))
    expect(log).toEqual(['first', 'second'])
  })
})

describe('drain', () => {
  it('runs what the runs themselves queue, in the same drain', () => {
    const later = fx('later')
    const log: string[] = []
    enqueue(fx('first'))
    drain((n: Fake) => {
      log.push(n.name)
      if (n.name === 'first') enqueue(later)
    })
    expect(log).toEqual(['first', 'later'])
  })

  it('runs every queued effect when one throws, then rethrows the first error only', () => {
    const log: string[] = []
    enqueue(fx('a'))
    enqueue(fx('b'))
    enqueue(fx('c'))
    expect(() =>
      drain((n: Fake) => {
        log.push(n.name)
        if (n.name !== 'b') throw new Error(`boom ${n.name}`)
      }),
    ).toThrow('boom a')
    expect(log).toEqual(['a', 'b', 'c'])
  })

  it('leaves the queue empty after a throw', () => {
    enqueue(fx('bad'))
    expect(() => drain(() => {
      throw new Error('x')
    })).toThrow('x')
    const log: string[] = []
    drain(runLog(log))
    expect(log).toEqual([])
  })

  it('does nothing on an empty queue', () => {
    let runs = 0
    drain(() => void runs++)
    expect(runs).toBe(0)
  })
})

describe('schedule', () => {
  it('drains once on the next microtask however many times it is asked in a burst', async () => {
    const log: string[] = []
    const run = runLog(log)
    enqueue(fx('a'))
    schedule(run)
    schedule(run)
    enqueue(fx('b'))
    schedule(run)
    expect(log).toEqual([])
    await Promise.resolve()
    expect(log).toEqual(['a', 'b'])
  })

  it('asked during a drain, schedules nothing: the running loop picks the work up', async () => {
    const log: string[] = []
    const run = (n: Fake): void => {
      log.push(n.name)
      if (n.name === 'a') {
        enqueue(fx('b'))
        schedule(run)
      }
    }
    enqueue(fx('a'))
    drain(run)
    expect(log).toEqual(['a', 'b'])
    // a microtask drain, had one been scheduled, would run this too
    enqueue(fx('c'))
    await Promise.resolve()
    await Promise.resolve()
    expect(log).toEqual(['a', 'b'])
    drain(run)
    expect(log).toEqual(['a', 'b', 'c'])
  })
})
