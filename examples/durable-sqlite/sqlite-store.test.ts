// The SQLite adapter against the Store contract, then against a file that is
// closed mid-message and opened again. Skipped where `node:sqlite` cannot be
// imported: Node before 22.5, or 22.5–22.12 without --experimental-sqlite
// (vitest.config.ts passes the flag where the running Node knows it).

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { define, registry, spawn } from '@nonchalant/core'
import type { Cast } from '@nonchalant/core'
import { durable, Fenced, scheduler, type DurableProc } from '@nonchalant/durable'
import { storeConformance } from '@nonchalant/durable/conformance'
import { sqliteStore } from './sqlite-store.ts'

const sqlite = await import('node:sqlite').catch(() => undefined)
const reason = sqlite === undefined ? ' (skipped: node:sqlite is not importable on this Node — needs 22.13+, or --experimental-sqlite)' : ''

const settle = async (turns = 40): Promise<void> => {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve))
}

// ---------- the contract ----------

describe.skipIf(sqlite === undefined)(`sqliteStore${reason}`, () => {
  storeConformance((now) => sqliteStore(new sqlite!.DatabaseSync(':memory:'), now), { describe, it, expect })
})

// ---------- a file that outlives its process ----------

type Order = { items: number; charged: number; shipped: boolean }
type OrderMsg = Cast<{ type: 'add' }> | Cast<{ type: 'checkout' }>

let clock = 0
let charges = 0

/** Checkout charges once, waits out a cool-off, then ships: a crash in the cool-off is mid-message. */
const order: DurableProc<Order, OrderMsg, { id: string }> = async function* (self, _args, d) {
  let s = d.restored ?? { items: 0, charged: 0, shipped: false }
  yield s
  for await (const msg of self) {
    switch (msg.type) {
      case 'add':
        s = { ...s, items: s.items + 1 }
        break
      case 'checkout': {
        const charged = await d.step('charge', () => (charges++, s.items * 10))
        await d.sleep('cool-off', 1000)
        s = { ...s, charged, shipped: true }
        break
      }
    }
    yield s
  }
}

describe.skipIf(sqlite === undefined)(`a durable process on a SQLite file${reason}`, () => {
  const dirs: string[] = []
  const open: { close(): void }[] = []
  const file = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'nonchalant-sqlite-'))
    dirs.push(dir)
    return join(dir, 'orders.db')
  }

  afterEach(() => {
    vi.useRealTimers()
    for (const db of open.splice(0)) {
      try {
        db.close()
      } catch {
        // closed by the test already
      }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const opened = (path: string) => {
    const db = new sqlite!.DatabaseSync(path)
    open.push(db)
    return { db, store: sqliteStore(db, () => clock) }
  }

  it('crashes mid-message, is reopened, and resumes where it was without charging again', async () => {
    clock = 0
    charges = 0
    const path = file()

    const first = opened(path)
    const p = spawn(durable(order, { store: first.store, key: (a: { id: string }) => a.id, now: () => clock }), { id: 'o1' })
    p.cast({ type: 'add' })
    p.cast({ type: 'add' })
    p.cast({ type: 'checkout' })
    await settle()
    expect(charges).toBe(1)
    expect(p()).toStrictEqual({ items: 2, charged: 0, shipped: false }) // cooling off
    p[Symbol.dispose]() // the process dies in the middle of the checkout
    first.db.close()

    clock = 5000
    const second = opened(path)
    const q = spawn(durable(order, { store: second.store, key: (a: { id: string }) => a.id, now: () => clock }), { id: 'o1' })
    await settle()
    expect(q()).toStrictEqual({ items: 2, charged: 20, shipped: true })
    expect(charges).toBe(1) // the charge was answered from the file
    q[Symbol.dispose]()
    second.db.close()
  })

  it('a sleep cut short by a crash is woken by a scheduler once the file is reopened', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    clock = 0
    charges = 0
    const path = file()

    const first = opened(path)
    const opts = { key: (a: { id: string }) => a.id, now: () => clock }
    const p = spawn(durable(order, { ...opts, store: first.store }), { id: 'o2' })
    p.cast({ type: 'add' })
    p.cast({ type: 'checkout' })
    await settle()
    p[Symbol.dispose]()
    first.db.close()

    const second = opened(path)
    const reg = registry({ order: define(durable(order, { ...opts, store: second.store })) })
    const sch = scheduler({ store: second.store, wake: (id) => reg.lookup('order', { id }), interval: 100, now: () => clock })
    await settle()
    expect({ ...second.db.prepare('SELECT snapshot FROM instances WHERE key = ?').get('o2') }).toStrictEqual({ snapshot: '{"items":1,"charged":0,"shipped":false}' }) // not due yet

    clock += 1000
    vi.advanceTimersByTime(1000)
    await settle()
    expect(reg.lookup('order', { id: 'o2' })()).toStrictEqual({ items: 1, charged: 10, shipped: true })
    expect(charges).toBe(1)
    sch[Symbol.dispose]()
    reg.evict('order')
    second.db.close()
  })

  it('two connections to one file: the later claim fences the earlier', async () => {
    const path = file()
    const a = opened(path)
    const b = opened(path)
    const mine = await a.store.load('k')
    await b.store.load('k')
    await expect(a.store.append('k', mine.epoch, 'stale')).rejects.toBeInstanceOf(Fenced)
    expect(await b.store.pending('k', 0)).toStrictEqual([])
    a.db.close()
    b.db.close()
  })
})
