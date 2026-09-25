// @vitest-environment happy-dom
//
// The adapter's promises, counted: a component renders when what it read
// changed and not otherwise, subscriptions balance under StrictMode, and a
// component-owned process is disposed exactly once.

import { describe, it, expect, afterEach } from 'vitest'
import { StrictMode, act, memo, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { define, registry, spawn } from '@nonchalant/core'
import type { Call, Cast, Proc, Process } from '@nonchalant/core'
import { useDerive, useLookup, useProcess, useProcessMeta, useSpawn } from '@nonchalant/react'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const roots: Root[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
})

const render = async (node: ReactNode): Promise<{ el: HTMLElement; root: Root }> => {
  const el = document.createElement('div')
  const root = createRoot(el)
  roots.push(root)
  await act(async () => root.render(node))
  return { el, root }
}

/** Run fn, then let the process step, the graph flush, and React commit. */
const settle = async (fn: () => void = () => {}): Promise<void> => {
  await act(async () => {
    fn()
    await tick()
  })
}

// ---------- processes under test ----------

type CounterMsg = Cast<{ type: 'add'; by: number }>

const counter: Proc<number, CounterMsg, void> = async function* (self) {
  let n = 0
  yield n
  for await (const msg of self) {
    switch (msg.type) {
      case 'add':
        n += msg.by
        break
    }
    yield n
  }
}

type Row = { id: number; label: string }
type Rows = { rows: Row[] }
type RowsMsg = Cast<{ type: 'label'; at: number; label: string }>

const rowsProc: Proc<Rows, RowsMsg, number> = async function* (self, count) {
  let s: Rows = { rows: Array.from({ length: count }, (_, id) => ({ id, label: `row ${id}` })) }
  yield s
  for await (const msg of self) {
    switch (msg.type) {
      case 'label':
        s = { ...s, rows: s.rows.map((row, i) => (i === msg.at ? { ...row, label: msg.label } : row)) }
        break
    }
    yield s
  }
}

// ---------- useProcess ----------

describe('useProcess', () => {
  it('renders the current value and re-renders once per yield', async () => {
    const p = spawn(counter, undefined)
    let renders = 0
    function Count(): ReactNode {
      renders++
      return <b>{useProcess(p) ?? 'starting'}</b>
    }

    const { el } = await render(<Count />)
    await settle()
    expect(el.textContent).toBe('0')
    const before = renders

    await settle(() => p.cast({ type: 'add', by: 2 }))
    expect(el.textContent).toBe('2')
    expect(renders - before).toBe(1)
    p[Symbol.dispose]()
  })

  it('stops watching on unmount, so an evicting registry lets the entry go', async () => {
    const reg = registry({ count: define(counter, { initial: 0, evict: 0 }) })
    const p = reg.lookup('count')
    function Count(): ReactNode {
      return <b>{useProcess(p)}</b>
    }

    const { root } = await render(<StrictMode><Count /></StrictMode>)
    await settle()
    expect(reg.lookup('count')).toBe(p) // watched: the evict timer is held off

    await act(async () => root.unmount())
    await tick(5)
    expect(p.stale).toBe(true) // no watcher left behind by StrictMode's double subscribe
  })
})

// ---------- useDerive ----------

describe('useDerive', () => {
  it('re-renders exactly one row of a thousand when one label changes', async () => {
    const list = spawn(rowsProc, 1000)
    const rowRenders = new Map<number, number>()
    let listRenders = 0

    const RowView = memo(function RowView({ at }: { at: number }): ReactNode {
      rowRenders.set(at, (rowRenders.get(at) ?? 0) + 1)
      const label = useDerive(() => list()?.rows[at]?.label, [at])
      return <li>{label}</li>
    })

    function List(): ReactNode {
      listRenders++
      const length = useDerive(() => list()?.rows.length ?? 0, [])
      return <ul>{Array.from({ length }, (_, at) => <RowView key={at} at={at} />)}</ul>
    }

    const { el } = await render(<List />)
    await settle()
    expect(el.querySelectorAll('li')).toHaveLength(1000)
    rowRenders.clear()
    const listBefore = listRenders

    await settle(() => list.cast({ type: 'label', at: 3, label: 'changed' }))
    expect(el.querySelectorAll('li')[3]!.textContent).toBe('changed')
    expect([...rowRenders]).toStrictEqual([[3, 1]])
    expect(listRenders - listBefore).toBe(0)
    list[Symbol.dispose]()
  })

  it('re-renders only when the result changes, not when its inputs do', async () => {
    const p = spawn(counter, undefined, { initial: 0 })
    let renders = 0
    function Parity(): ReactNode {
      renders++
      return <b>{useDerive(() => (p() % 2 === 0 ? 'even' : 'odd'), [])}</b>
    }

    const { el } = await render(<Parity />)
    const before = renders
    await settle(() => p.cast({ type: 'add', by: 2 }))
    expect(renders - before).toBe(0)
    await settle(() => p.cast({ type: 'add', by: 1 }))
    expect(el.textContent).toBe('odd')
    expect(renders - before).toBe(1)
    p[Symbol.dispose]()
  })

  it('leaves no watcher behind after a StrictMode mount and unmount', async () => {
    const reg = registry({ count: define(counter, { initial: 0, evict: 0 }) })
    const p = reg.lookup('count')
    function Parity(): ReactNode {
      return <b>{useDerive(() => p() % 2, [])}</b>
    }

    const { root } = await render(<StrictMode><Parity /></StrictMode>)
    await tick(5)
    expect(p.stale).toBe(false)
    await act(async () => root.unmount())
    await tick(5)
    expect(p.stale).toBe(true)
  })

  it('reselects when a dependency changes', async () => {
    const list = spawn(rowsProc, 3)
    function Label({ at }: { at: number }): ReactNode {
      return <b>{useDerive(() => list()?.rows[at]?.label, [at])}</b>
    }

    const { el, root } = await render(<Label at={0} />)
    await settle()
    expect(el.textContent).toBe('row 0')
    await act(async () => root.render(<Label at={2} />))
    expect(el.textContent).toBe('row 2')
    list[Symbol.dispose]()
  })
})

// ---------- useProcessMeta ----------

describe('useProcessMeta', () => {
  it('shows pending while a call is worked on, and the failure after a crash', async () => {
    let finish = (): void => {}
    type Msg = Call<{ type: 'work' }, string> | Cast<{ type: 'crash' }>
    const worker: Proc<number, Msg, void> = async function* (self) {
      yield 0
      for await (const msg of self) {
        switch (msg.type) {
          case 'work':
            await new Promise<void>((resolve) => { finish = resolve })
            msg.reply('ok')
            break
          case 'crash':
            throw new Error('boom')
        }
        yield 1
      }
    }
    const p = spawn(worker, undefined, { quiet: true })
    const seen: string[] = []
    function Status(): ReactNode {
      const { pending, stale, error } = useProcessMeta(p)
      const label = `${pending ? 'pending' : 'idle'}${stale ? ' stale' : ''}${error instanceof Error ? ` ${error.message}` : ''}`
      if (seen.at(-1) !== label) seen.push(label)
      return <i>{label}</i>
    }

    await render(<Status />)
    await settle()
    let done: Promise<string> = Promise.resolve('')
    await settle(() => { done = p.call({ type: 'work' }) })
    await settle(() => finish())
    expect(await done).toBe('ok')
    await settle(() => p.cast({ type: 'crash' }))
    expect(seen).toStrictEqual(['idle', 'pending', 'idle', 'pending', 'idle stale boom'])
  })
})

// ---------- useSpawn ----------

type Life = { started: number; ended: number }

const tracked = (life: Life): Proc<number, CounterMsg, void> =>
  async function* (self) {
    life.started++
    try {
      yield* counter(self, undefined)
    } finally {
      life.ended++
    }
  }

describe('useSpawn', () => {
  it('keeps one process across StrictMode double mounting and disposes it on unmount', async () => {
    const life: Life = { started: 0, ended: 0 }
    const proc = tracked(life)
    let handle: Process<number, CounterMsg> | undefined
    function Owner(): ReactNode {
      const p = useSpawn(proc, undefined, { initial: 0 })
      handle = p
      return <button onClick={() => p.cast({ type: 'add', by: 1 })}>{useProcess(p)}</button>
    }

    const { el, root } = await render(<StrictMode><Owner /></StrictMode>)
    await settle(() => el.querySelector('button')!.click())
    expect(el.textContent).toBe('1')
    const kept = handle!

    // StrictMode rendered twice; the copy it discarded is disposed after the grace
    await act(async () => tick(1_100))
    expect(life).toStrictEqual({ started: 2, ended: 1 })
    expect(kept.stale).toBe(false)
    expect(handle).toBe(kept)

    await act(async () => root.unmount())
    await tick()
    expect(life).toStrictEqual({ started: 2, ended: 2 })
    expect(kept.stale).toBe(true)
  })

  it('outside StrictMode spawns once and disposes once', async () => {
    const life: Life = { started: 0, ended: 0 }
    const proc = tracked(life)
    function Owner(): ReactNode {
      return <b>{useProcess(useSpawn(proc, undefined, { initial: 0 }))}</b>
    }

    const { root } = await render(<Owner />)
    await settle()
    expect(life).toStrictEqual({ started: 1, ended: 0 })
    await act(async () => root.unmount())
    await tick()
    expect(life).toStrictEqual({ started: 1, ended: 1 })
  })
})

// ---------- useLookup ----------

describe('useLookup', () => {
  it('holds an entry alive while mounted, even when the component only casts to it', async () => {
    const reg = registry({ count: define(counter, { initial: 0, evict: 0 }) })
    let seen: Process<number, CounterMsg> | undefined
    function Adder(): ReactNode {
      const p = useLookup(() => reg.lookup('count'))
      seen = p
      return <button onClick={() => p.cast({ type: 'add', by: 1 })}>add</button>
    }

    const { root } = await render(<StrictMode><Adder /></StrictMode>)
    await settle()
    await tick(5)
    expect(seen!.stale).toBe(false)
    expect(reg.lookup('count')).toBe(seen)

    await act(async () => root.unmount())
    await tick(5)
    expect(seen!.stale).toBe(true)
  })

  it('looks the entry up again after it is evicted', async () => {
    const reg = registry({ count: define(counter, { initial: 0 }) })
    const seen: Process<number, CounterMsg>[] = []
    function Count(): ReactNode {
      const p = useLookup(() => reg.lookup('count'))
      if (seen.at(-1) !== p) seen.push(p)
      return <b>{useProcess(p)}</b>
    }

    await render(<Count />)
    await settle(() => seen[0]!.cast({ type: 'add', by: 5 }))
    await settle(() => reg.evict('count'))
    expect(seen).toHaveLength(2)
    expect(seen[1]!.stale).toBe(false)
  })
})
