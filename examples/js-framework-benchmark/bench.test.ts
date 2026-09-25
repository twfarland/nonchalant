// @vitest-environment happy-dom
//
// Count budgets over the benchmark app at 1,000 rows, asserted in CI. Each
// operation is held to the DOM work its change actually requires: a swap is
// two moves, a select touches two rows, an append touches only the new row.

import { describe, it, expect, afterEach } from 'vitest'
import { cell, spawn } from '@nonchalant/core'
import type { Process } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { tbody, td, tr } from '@nonchalant/dom/tags'
import { App, rows, selection, type Msg, type Row, type SelectMsg, type Selection } from './bench.ts'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface Counts {
  moves: number
  inserts: number
  removes: number
  /** whole-container clears (replaceChildren / textContent) */
  bulk: number
  attrs: number
  texts: number
  listenerAdds: number
  listenerRemoves: number
}

// Instruments every DOM entry point the sink could use; restored after each
// test. Only the sink's own calls count (not happy-dom's internal recursion),
// and only writes the live document sees: building a detached row is not one.
const restores: (() => void)[] = []
afterEach(() => {
  while (restores.length > 0) restores.pop()!()
})

let depth = 0

function patch(proto: object, name: string, count: (self: Node, args: unknown[]) => void): void {
  const target = proto as Record<string, unknown>
  const orig = target[name]
  if (typeof orig !== 'function') return
  target[name] = function (this: Node, ...args: unknown[]) {
    if (depth === 0) count(this, args)
    depth++
    try {
      return (orig as (...a: unknown[]) => unknown).apply(this, args)
    } finally {
      depth--
    }
  }
  restores.push(() => {
    target[name] = orig
  })
}

function patchSetter(proto: object, name: string, count: (self: Node) => void): void {
  const desc = Object.getOwnPropertyDescriptor(proto, name)!
  Object.defineProperty(proto, name, {
    configurable: true,
    ...(desc.get === undefined ? {} : { get: desc.get }),
    set(this: Node, v: unknown) {
      if (depth === 0) count(this)
      depth++
      try {
        desc.set!.call(this, v)
      } finally {
        depth--
      }
    },
  })
  restores.push(() => Object.defineProperty(proto, name, desc))
}

function spyDom(): Counts {
  const c: Counts = { moves: 0, inserts: 0, removes: 0, bulk: 0, attrs: 0, texts: 0, listenerAdds: 0, listenerRemoves: 0 }
  const arrive = (parent: Node, [node]: unknown[]): void => {
    if ((node as Node).isConnected) c.moves++
    else if (parent.isConnected) c.inserts++
  }
  const live = (bump: () => void) => (self: Node): void => {
    if (self.isConnected) bump()
  }
  patch(Node.prototype, 'insertBefore', arrive)
  patch(Node.prototype, 'appendChild', arrive)
  patch(Element.prototype, 'moveBefore', () => c.moves++)
  patch(Node.prototype, 'removeChild', live(() => c.removes++))
  patch(Node.prototype, 'replaceChild', live(() => c.removes++))
  patch(Element.prototype, 'remove', live(() => c.removes++))
  patch(CharacterData.prototype, 'remove', live(() => c.removes++))
  patch(Element.prototype, 'replaceChildren', live(() => c.bulk++))
  patchSetter(Node.prototype, 'textContent', live(() => c.bulk++))
  patch(Element.prototype, 'setAttribute', live(() => c.attrs++))
  patch(Element.prototype, 'removeAttribute', live(() => c.attrs++))
  patchSetter(CharacterData.prototype, 'data', live(() => c.texts++))
  // the event methods live on whichever EventTarget class the window's nodes extend
  let et: object = Node.prototype
  while (!Object.hasOwn(et, 'addEventListener')) et = Object.getPrototypeOf(et) as object
  patch(et, 'addEventListener', () => c.listenerAdds++)
  patch(et, 'removeEventListener', () => c.listenerRemoves++)
  return c
}

interface Bench {
  root: HTMLElement
  store: Process<Row[], Msg>
  selected: Process<Selection, SelectMsg>
  /** selection reads by row class bindings — one per binding run */
  reads(): number
  trs(): HTMLTableRowElement[]
  dispose(): void
}

async function bench(n: number): Promise<Bench> {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const store = spawn(rows, undefined, { initial: [] as Row[] })
  const selected = spawn(selection, undefined, { initial: {} as Selection })
  let reads = 0
  const counted = new Proxy(selected, {
    apply: (target, self, args: []) => {
      reads++
      return Reflect.apply(target, self, args)
    },
  })
  const view = mount(root, App(store, counted))
  store.cast({ type: 'run', n })
  await tick()
  return {
    root,
    store,
    selected,
    reads: () => reads,
    trs: () => [...root.querySelectorAll('tbody > tr')] as HTMLTableRowElement[],
    dispose: () => {
      view[Symbol.dispose]()
      store[Symbol.dispose]()
      selected[Symbol.dispose]()
      root.remove()
    },
  }
}

describe('js-framework-benchmark count budgets (1,000 rows)', () => {
  it('create builds every row once: 1000 inserts, 2000 listeners, no moves', async () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const store = spawn(rows, undefined, { initial: [] as Row[] })
    const selected = spawn(selection, undefined, { initial: {} as Selection })
    const view = mount(root, App(store, selected))
    await tick()
    const c = spyDom()
    store.cast({ type: 'run', n: 1000 })
    await tick()
    expect(root.querySelectorAll('tbody > tr').length).toBe(1000)
    expect(c.inserts).toBe(1000)
    expect(c.moves).toBe(0)
    expect(c.removes).toBe(0)
    expect(c.listenerAdds).toBe(2000) // label click + remove click per row
    view[Symbol.dispose]()
    store[Symbol.dispose]()
    selected[Symbol.dispose]()
  })

  it('swap rows is exactly two moves; every row keeps its node', async () => {
    const b = await bench(1000)
    const before = b.trs()
    const c = spyDom()
    b.store.cast({ type: 'swap' })
    await tick()
    const after = b.trs()
    expect(c.moves).toBe(2)
    expect(c.inserts).toBe(0)
    expect(c.removes).toBe(0)
    expect(c.attrs).toBe(0)
    expect(c.texts).toBe(0)
    expect(after[1]).toBe(before[998])
    expect(after[998]).toBe(before[1])
    expect(after.filter((el, i) => i !== 1 && i !== 998 && el !== before[i])).toEqual([])
    b.dispose()
  })

  it('select wakes exactly two row bindings and writes exactly two class attributes', async () => {
    const b = await bench(1000)
    const labels = b.root.querySelectorAll<HTMLElement>('a.lbl')
    labels[5]!.click()
    await tick()
    const reads = b.reads()
    const c = spyDom()
    labels[9]!.click()
    await tick()
    expect(b.reads() - reads).toBe(2)
    expect(c.attrs).toBe(2)
    expect(b.trs()[5]!.className).toBe('')
    expect(b.trs()[9]!.className).toBe('danger')
    b.dispose()
  })

  it('append one row touches no existing row: one insert, two listeners, no writes', async () => {
    const b = await bench(1000)
    const c = spyDom()
    b.store.cast({ type: 'append', n: 1 })
    await tick()
    expect(b.trs().length).toBe(1001)
    expect(c.inserts).toBe(1)
    expect(c.moves).toBe(0)
    expect(c.attrs).toBe(0)
    expect(c.texts).toBe(0)
    expect(c.listenerAdds).toBe(2)
    expect(c.listenerRemoves).toBe(0)
    b.dispose()
  })

  it('update every 10th row is exactly 100 text writes and nothing else', async () => {
    const b = await bench(1000)
    const c = spyDom()
    b.store.cast({ type: 'update-every-10th' })
    await tick()
    expect(c.texts).toBe(100)
    expect(c.attrs).toBe(0)
    expect(c.moves + c.inserts + c.removes).toBe(0)
    expect(c.listenerAdds + c.listenerRemoves).toBe(0)
    b.dispose()
  })

  it('clear empties the table in bulk: no per-row removal or listener teardown', async () => {
    const b = await bench(1000)
    const c = spyDom()
    b.store.cast({ type: 'clear' })
    await tick()
    expect(b.trs().length).toBe(0)
    expect(c.bulk).toBe(1)
    expect(c.removes).toBe(0)
    expect(c.listenerRemoves).toBe(0)
    b.dispose()
  })

  it('moving the last of 1000 keyed rows to the front is exactly one move', async () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const list = cell<Row[]>(Array.from({ length: 1000 }, (_, i) => ({ id: i, label: `row ${i}` })))
    const view = mount(root, tbody({}, () => list().map((r) => tr({ key: r.id }, td({}, r.label)))))
    await tick()
    const before = [...root.querySelectorAll('tr')]
    const c = spyDom()
    const cur = list()
    list.cast([cur[999]!, ...cur.slice(0, 999)])
    await tick()
    const after = [...root.querySelectorAll('tr')]
    expect(c.moves).toBe(1)
    expect(c.inserts + c.removes).toBe(0)
    expect(after[0]).toBe(before[999])
    expect(after.slice(1)).toEqual(before.slice(0, 999))
    view[Symbol.dispose]()
    list[Symbol.dispose]()
  })
})
