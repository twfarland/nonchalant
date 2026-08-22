// @vitest-environment happy-dom
//
// The sprezzatura bug list is the regression suite (docs/DESIGN.md origin
// flaw #4): XSS strings, attribute breakout, tables, SVG, key: 0, adjacent
// text nodes, empty-string children. Plus the M4 mechanisms: keyed
// reconciliation, per-slot pending/error, event binding, exit transitions,
// and DOM-write counting for granularity.

import { describe, it, expect } from 'vitest'
import { cell, spawn, flush } from '@nonchalant/core'
import type { Proc, Self, VNode } from '@nonchalant/core'
import { h, mount } from '@nonchalant/dom'
import { button, div, li, span, table, tbody, td, tr, ul } from '@nonchalant/dom/tags'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const container = (): HTMLElement => {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

// happy-dom's MutationObserver misses characterData writes, so granularity is
// asserted by intercepting the sink's own write instrument: Text#data.
const spyTextWrites = (): { writes: Text[]; restore: () => void } => {
  const proto = CharacterData.prototype
  const desc = Object.getOwnPropertyDescriptor(proto, 'data')!
  const writes: Text[] = []
  Object.defineProperty(proto, 'data', {
    configurable: true,
    get: desc.get!,
    set(this: Text, v: string) {
      writes.push(this)
      desc.set!.call(this, v)
    },
  })
  return { writes, restore: () => Object.defineProperty(proto, 'data', desc) }
}

describe('rendering basics', () => {
  it('builds elements, attributes, and nested children', () => {
    const root = container()
    mount(root, div({ class: 'box', id: 'a' }, span({}, 'hi'), 'raw', 42))
    const box = root.querySelector('.box')!
    expect(box.id).toBe('a')
    expect(box.querySelector('span')!.textContent).toBe('hi')
    expect(box.textContent).toBe('hiraw42')
  })

  it('adjacent text nodes stay separate and unjoined (no stray space)', () => {
    const root = container()
    mount(root, div({}, 'a', 'b', 'c'))
    expect(root.querySelector('div')!.textContent).toBe('abc')
  })

  it('empty-string children render without breaking siblings', () => {
    const root = container()
    mount(root, div({}, '', 'x', ''))
    expect(root.querySelector('div')!.textContent).toBe('x')
  })

  it('null/undefined/boolean children render nothing', () => {
    const root = container()
    mount(root, div({}, null, undefined, true, false, 'ok'))
    expect(root.querySelector('div')!.textContent).toBe('ok')
  })
})

describe('XSS regressions (sprezzatura built DOM from strings; we never do)', () => {
  it('a script-bearing string child is inert text', () => {
    const root = container()
    const hostile = '<img src=x onerror="window.__pwned = true">'
    mount(root, div({}, hostile))
    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('div')!.textContent).toBe(hostile)
    expect((window as unknown as Record<string, unknown>)['__pwned']).toBeUndefined()
  })

  it('attribute values cannot break out into new attributes', () => {
    const root = container()
    const hostile = '" onmouseover="window.__pwned = true'
    mount(root, div({ title: hostile }))
    const el = root.querySelector('div')!
    expect(el.getAttribute('title')).toBe(hostile)
    expect(el.getAttribute('onmouseover')).toBeNull()
  })
})

describe('structure regressions', () => {
  it('tables nest correctly (no string-parser fostering)', () => {
    const root = container()
    mount(root, table({}, tbody({}, tr({}, td({}, 'x'), td({}, 'y')))))
    const cells = root.querySelectorAll('table > tbody > tr > td')
    expect(cells.length).toBe(2)
    expect(cells[1]!.textContent).toBe('y')
  })

  it('SVG elements get the SVG namespace; foreignObject children return to XHTML', () => {
    const root = container()
    mount(
      root,
      h('svg', { viewBox: '0 0 10 10' },
        h('circle', { cx: 5, cy: 5, r: 4 }),
        h('foreignObject', {}, div({}, 'html'))),
    )
    const svgNs = 'http://www.w3.org/2000/svg'
    expect(root.querySelector('svg')!.namespaceURI).toBe(svgNs)
    expect(root.querySelector('circle')!.namespaceURI).toBe(svgNs)
    expect(root.querySelector('foreignObject > div')!.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
  })
})

describe('dynamic slots', () => {
  it('a cell placed directly in the tree is a live binding', async () => {
    const root = container()
    const count = cell(0)
    mount(root, div({}, span({}, count)))
    expect(root.querySelector('span')!.textContent).toBe('0')
    count.send(7)
    await tick()
    expect(root.querySelector('span')!.textContent).toBe('7')
    count[Symbol.dispose]()
  })

  it('a thunk attr is a live binding; on* functions are listeners', async () => {
    const root = container()
    const active = cell(false)
    let clicks = 0
    mount(
      root,
      button({ class: () => (active() ? 'on' : 'off'), onclick: () => clicks++ }, 'go'),
    )
    const btn = root.querySelector('button')!
    expect(btn.getAttribute('class')).toBe('off')
    btn.click()
    expect(clicks).toBe(1)
    active.send(true)
    await tick()
    expect(btn.getAttribute('class')).toBe('on')
    active[Symbol.dispose]()
  })

  it('a promise slot holds only its own region: empty, then content', async () => {
    const root = container()
    let resolve!: (v: VNode) => void
    const p = new Promise<VNode>((r) => (resolve = r))
    mount(root, div({}, 'before:', p, ':after'))
    expect(root.querySelector('div')!.textContent).toBe('before::after')
    resolve(span({}, 'late'))
    await tick()
    expect(root.querySelector('div')!.textContent).toBe('before:late:after')
  })

  it('a rejected promise slot stays empty and contains the failure', async () => {
    const root = container()
    mount(root, div({}, 'a', Promise.reject(new Error('nope')), 'b'))
    await tick()
    expect(root.querySelector('div')!.textContent).toBe('ab')
  })

  it('a thunk may resolve asynchronously — the lazy-route pattern; latest wins', async () => {
    const root = container()
    const route = cell<'home' | 'about'>('home')
    mount(root, div({}, () =>
      route() === 'about'
        ? Promise.resolve().then(() => span({ id: 'about' }, 'About')) // stands in for import()
        : span({ id: 'home' }, 'Home')))
    expect(root.querySelector('#home')).not.toBeNull()
    route.send('about')
    await tick()
    await tick()
    expect(root.querySelector('#home')).toBeNull()
    expect(root.querySelector('#about')!.textContent).toBe('About')
    route[Symbol.dispose]()
  })

  it('a throwing binding keeps its previous content', async () => {
    const root = container()
    const n = cell(1)
    mount(root, div({}, () => {
      const v = n()
      if (v < 0) throw new Error('neg')
      return String(v)
    }))
    expect(root.querySelector('div')!.textContent).toBe('1')
    n.send(-1)
    await tick()
    expect(root.querySelector('div')!.textContent).toBe('1') // kept
    n.send(5)
    await tick()
    expect(root.querySelector('div')!.textContent).toBe('5') // recovered
    n[Symbol.dispose]()
  })
})

type Row = { id: number; label: string }

describe('keyed reconciliation', () => {
  const rowsView = (rows: () => Row[]): VNode =>
    ul({}, () => rows().map((r) => li({ key: r.id }, r.label)))

  it('reorder moves DOM nodes instead of recreating them (key: 0 is a key)', async () => {
    const root = container()
    const rows = cell<Row[]>([
      { id: 0, label: 'zero' },
      { id: 1, label: 'one' },
      { id: 2, label: 'two' },
    ])
    mount(root, rowsView(() => rows() ?? []))
    const before = [...root.querySelectorAll('li')]
    expect(before.map((el) => el.textContent)).toEqual(['zero', 'one', 'two'])
    const cur = rows()!
    rows.send([cur[2]!, cur[0]!, cur[1]!])
    await tick()
    const after = [...root.querySelectorAll('li')]
    expect(after.map((el) => el.textContent)).toEqual(['two', 'zero', 'one'])
    // identity preserved — the key-0 node moved, nothing was rebuilt
    expect(after[1]).toBe(before[0])
    expect(after[0]).toBe(before[2])
    rows[Symbol.dispose]()
  })

  it('removal disposes exactly the absent key; insert constructs exactly the new one', async () => {
    const root = container()
    const rows = cell<Row[]>([
      { id: 1, label: 'a' },
      { id: 2, label: 'b' },
      { id: 3, label: 'c' },
    ])
    mount(root, rowsView(() => rows() ?? []))
    const before = [...root.querySelectorAll('li')]
    const cur = rows()!
    rows.send([cur[0]!, { id: 9, label: 'new' }, cur[2]!])
    await tick()
    const after = [...root.querySelectorAll('li')]
    expect(after.map((el) => el.textContent)).toEqual(['a', 'new', 'c'])
    expect(after[0]).toBe(before[0])
    expect(after[2]).toBe(before[2])
    expect(after[1]).not.toBe(before[1])
    rows[Symbol.dispose]()
  })

  it('one label change in 50 rows is exactly one DOM text write', async () => {
    const root = container()
    const rows = cell<Row[]>(Array.from({ length: 50 }, (_, i) => ({ id: i, label: `row ${i}` })))
    mount(root, rowsView(() => rows() ?? []))
    await tick()
    const target = root.querySelectorAll('li')[25]!.firstChild
    const spy = spyTextWrites()
    try {
      const cur = rows()!
      rows.send(cur.map((r, i) => (i === 25 ? { ...r, label: 'CHANGED' } : r)))
      await tick()
      flush()
      expect(root.querySelectorAll('li')[25]!.textContent).toBe('CHANGED')
      expect(spy.writes).toEqual([target]) // exactly the one text node, once
    } finally {
      spy.restore()
      rows[Symbol.dispose]()
    }
  })
})

describe('granularity across a state process', () => {
  it('a patch on /b never touches the /a binding or its DOM', async () => {
    type S = { a: number; b: number }
    const state: Proc<S, 'a' | 'b', void> = async function* (self) {
      let s: S = { a: 0, b: 0 }
      for await (const msg of self) {
        s = msg === 'a' ? { ...s, a: s.a + 1 } : { ...s, b: s.b + 1 }
        yield s
      }
    }
    const p = spawn(state, undefined, { initial: { a: 0, b: 0 } })
    const root = container()
    mount(root, div({},
      span({ id: 'a' }, () => String(p().a)),
      span({ id: 'b' }, () => String(p().b))))
    await tick()
    const bText = root.querySelector('#b')!.firstChild
    const spy = spyTextWrites()
    try {
      p.send('b')
      await tick()
      flush()
      expect(root.querySelector('#a')!.textContent).toBe('0')
      expect(root.querySelector('#b')!.textContent).toBe('1')
      expect(spy.writes).toEqual([bText]) // only b's text node was written, once
    } finally {
      spy.restore()
      p[Symbol.dispose]()
    }
  })
})

describe('exit transitions', () => {
  it('removal defers detach until the exit hook settles', async () => {
    const root = container()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const rows = cell<number[]>([1, 2, 3])
    mount(root, ul({}, () => (rows() ?? []).map((n) =>
      li({ key: n, exit: () => gate }, String(n)))))
    expect(root.querySelectorAll('li').length).toBe(3)
    rows.send([1, 3])
    await tick()
    expect(root.querySelectorAll('li').length).toBe(3) // still attached, mid-transition
    release()
    await tick()
    expect([...root.querySelectorAll('li')].map((el) => el.textContent)).toEqual(['1', '3'])
    rows[Symbol.dispose]()
  })
})

describe('view processes and unmount', () => {
  it('a view process re-yield is a structural swap; dispose unmounts', async () => {
    const root = container()
    const view: Proc<VNode, 'swap', void> = async function* (self) {
      yield div({ id: 'one' }, 'first')
      for await (const _ of self) {
        void _
        yield div({ id: 'two' }, 'second')
      }
    }
    const vp = spawn(view, undefined)
    const handle = mount(root, vp)
    await tick()
    expect(root.querySelector('#one')!.textContent).toBe('first')
    vp.send('swap')
    await tick()
    expect(root.querySelector('#one')).toBeNull()
    expect(root.querySelector('#two')!.textContent).toBe('second')
    handle[Symbol.dispose]()
    expect(root.querySelector('#two')).toBeNull()
    expect(root.childNodes.length).toBe(0)
    vp[Symbol.dispose]()
  })

  it('unmount stops bindings from reacting', async () => {
    const root = container()
    const n = cell(0)
    const handle = mount(root, div({}, () => String(n())))
    expect(root.textContent).toBe('0')
    handle[Symbol.dispose]()
    n.send(9)
    await tick()
    expect(root.textContent).toBe('')
    n[Symbol.dispose]()
  })
})
