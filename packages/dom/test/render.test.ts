// @vitest-environment happy-dom
//
// The sink's update paths: rebinding fresh closures without churn, skipping
// writes the DOM already holds, property ordering, bulk clears, authoring
// lints, attribute-level injection, exit accessibility, and the in-place
// replacement and failure paths.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { cell, flush, mount as coreMount } from '@nonchalant/core'
import type { Process, VNode } from '@nonchalant/core'
import { h, mount, domSink, onRenderError } from '@nonchalant/dom'
import { a, button, div, form, img, input, li, option, select, span, ul } from '@nonchalant/dom/tags'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const container = (): HTMLElement => {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

const restores: (() => void)[] = []
afterEach(() => {
  while (restores.length > 0) restores.pop()!()
})

/** Record every call to proto[name] (this + args) until the test ends. */
function spyMethod(proto: object, name: string): unknown[][] {
  const target = proto as Record<string, unknown>
  const orig = target[name] as (...args: unknown[]) => unknown
  const calls: unknown[][] = []
  target[name] = function (this: unknown, ...args: unknown[]) {
    calls.push([this, ...args])
    return orig.apply(this, args)
  }
  restores.push(() => {
    target[name] = orig
  })
  return calls
}

/** Record every write through a property setter until the test ends. */
function spySetter(proto: object, name: string): unknown[] {
  const desc = Object.getOwnPropertyDescriptor(proto, name)!
  const writes: unknown[] = []
  Object.defineProperty(proto, name, {
    configurable: true,
    ...(desc.get === undefined ? {} : { get: desc.get }),
    set(this: unknown, v: unknown) {
      writes.push(v)
      desc.set!.call(this, v)
    },
  })
  restores.push(() => Object.defineProperty(proto, name, desc))
  return writes
}

const eventTargetProto = (): object => {
  let p: object = Node.prototype
  while (!Object.hasOwn(p, 'addEventListener')) p = Object.getPrototypeOf(p) as object
  return p
}

/** Capture console.warn; returns a reader of the messages so far. */
const lints = (): (() => string[]) => {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  restores.push(() => spy.mockRestore())
  return () => spy.mock.calls.map((c) => String(c[0]))
}

type Row = { id: number; text: string }

describe('fresh closures rebind in place', () => {
  it('a keyed row re-rendered with new closures never writes its input value or re-adds its listener', async () => {
    const root = container()
    const rows = cell<Row[]>([{ id: 1, text: 'hello world' }])
    let clicked = ''
    mount(root, ul({}, () =>
      rows().map((r) =>
        li({ key: r.id },
          input({ value: () => r.text }),
          button({ onclick: () => (clicked = `${r.id}:${rows().length}`) }, 'go')))))
    const field = root.querySelector('input')!
    expect(field.value).toBe('hello world')

    const values = spySetter(HTMLInputElement.prototype, 'value')
    const adds = spyMethod(eventTargetProto(), 'addEventListener')
    const removes = spyMethod(eventTargetProto(), 'removeEventListener')
    rows.cast([...rows(), { id: 2, text: 'two' }])
    await tick()

    expect(values).toEqual(['two']) // only the new row's input; row 1 saw no write at all
    expect(adds.filter(([el]) => el !== root.querySelectorAll('button')[1])).toEqual([])
    expect(removes).toEqual([])
    root.querySelector('button')!.click()
    expect(clicked).toBe('1:2') // the swapped-in handler is the one that runs
  })

  it('a child thunk re-created by a parent re-render keeps its DOM', async () => {
    const root = container()
    const rows = cell<Row[]>([{ id: 1, text: 'a' }])
    mount(root, ul({}, () => rows().map((r) => li({ key: r.id }, () => r.text))))
    const text = root.querySelector('li')!.firstChild
    const writes = spySetter(CharacterData.prototype, 'data')
    rows.cast([...rows(), { id: 2, text: 'b' }])
    await tick()
    expect(root.querySelector('li')!.firstChild).toBe(text)
    expect(writes).toEqual([])
    expect(root.textContent).toBe('ab')
  })

  it('a rebound attribute follows what the new closure reads, not the old one', async () => {
    const root = container()
    const which = cell<'a' | 'b'>('a')
    const a = cell('A1')
    const b = cell('B1')
    mount(root, ul({}, () => {
      const src = which() === 'a' ? a : b
      return [li({ key: 1, title: () => src() })]
    }))
    const el = root.querySelector('li')!
    which.cast('b')
    await tick()
    expect(root.querySelector('li')).toBe(el)
    expect(el.title).toBe('B1')
    const sets = spyMethod(Element.prototype, 'setAttribute')
    a.cast('A2')
    await tick()
    expect(sets).toEqual([])
    b.cast('B2')
    await tick()
    expect(el.title).toBe('B2')
  })

  it('a binding re-run that yields the value already present writes nothing', async () => {
    const root = container()
    const n = cell(1)
    mount(root, div({ class: () => (n() > 0 ? 'pos' : 'neg'), title: () => (n() > 5 ? 'big' : null) }))
    const sets = spyMethod(Element.prototype, 'setAttribute')
    const dels = spyMethod(Element.prototype, 'removeAttribute')
    n.cast(2)
    await tick()
    expect(sets.length + dels.length).toBe(0)
    n.cast(-1)
    await tick()
    expect(sets.map(([, name, v]) => `${String(name)}=${String(v)}`)).toEqual(['class=neg'])
    expect(dels.length).toBe(0)
  })
})

describe('interactive properties apply after children', () => {
  it('a static <select value> selects an option declared after it', () => {
    const root = container()
    mount(root, select({ value: 'b' }, option({ value: 'a' }, 'A'), option({ value: 'b' }, 'B')))
    expect(root.querySelector('select')!.value).toBe('b')
  })

  it('a bound <select value> selects its option and follows the binding', async () => {
    const root = container()
    const choice = cell('c')
    mount(root, select({ value: choice }, ...['a', 'b', 'c'].map((v) => option({ value: v }, v))))
    const el = root.querySelector('select')!
    expect(el.value).toBe('c')
    choice.cast('a')
    await tick()
    expect(el.value).toBe('a')
  })

  it('a patched <select> takes its value after its new options exist', async () => {
    const root = container()
    const opts = cell(['a'])
    mount(root, () => select({ value: opts().at(-1) }, ...opts().map((v) => option({ value: v }, v))))
    opts.cast(['a', 'z'])
    await tick()
    expect(root.querySelector('select')!.value).toBe('z')
  })
})

describe('bulk clear', () => {
  it('a region sharing its parent with static content removes only its own nodes', async () => {
    const root = container()
    const items = cell(['x', 'y'])
    mount(root, div({}, span({}, 'head'), () => items().map((t) => li({ key: t }, t))))
    items.cast([])
    await tick()
    expect(root.querySelector('div')!.textContent).toBe('head')
    items.cast(['z'])
    await tick()
    expect(root.querySelector('div')!.textContent).toBe('headz')
  })

  it('clearing a whole-parent region leaves its anchor, so it can refill', async () => {
    const root = container()
    const items = cell(['x', 'y'])
    mount(root, ul({}, () => items().map((t) => li({ key: t }, t))))
    items.cast([])
    await tick()
    expect(root.querySelectorAll('li').length).toBe(0)
    items.cast(['p', 'q'])
    await tick()
    expect([...root.querySelectorAll('li')].map((el) => el.textContent)).toEqual(['p', 'q'])
  })
})

describe('authoring lints (console.warn, once per message)', () => {
  it('camelCase onClick warns once across many elements', () => {
    const warns = lints()
    // @ts-expect-error the types refuse camelCase listeners too; this is the untyped-caller path
    mount(container(), div({}, button({ onClick: () => {} }), button({ onClick: () => {} })))
    expect(warns().filter((w) => w.includes('onClick'))).toHaveLength(1)
  })

  it('an object attribute value warns instead of silently rendering [object Object]', () => {
    const warns = lints()
    // @ts-expect-error the types refuse style objects too; this is the untyped-caller path
    mount(container(), div({ style: { color: 'red' } }))
    expect(warns().filter((w) => w.includes('style was given an object'))).toHaveLength(1)
  })

  it('a thunk may return a process or another thunk; the slot follows it', async () => {
    const root = container()
    const inner = cell('first')
    const which = cell(0)
    mount(root, div({}, () => (which() === 0 ? inner : () => `thunk:${inner()}`)))
    expect(root.textContent).toBe('first')
    inner.cast('second')
    await tick()
    expect(root.textContent).toBe('second')
    which.cast(1)
    await tick()
    expect(root.textContent).toBe('thunk:second')
  })
})

describe('attribute-level injection', () => {
  it('javascript: URLs are dropped from URL attributes, however they are disguised', async () => {
    const warns = lints()
    const root = container()
    const url = cell('https://example.com/')
    mount(root, div({},
      a({ id: 'plain', href: 'javascript:alert(1)' }),
      a({ id: 'disguised', href: ' \tJaVa\nScRiPt:alert(1)' }),
      img({ id: 'img', src: 'javascript:alert(1)' }),
      form({ id: 'form', action: 'javascript:alert(1)' }, button({ id: 'btn', formaction: 'javascript:alert(1)' })),
      a({ id: 'bound', href: url }),
      a({ id: 'relative', href: '/javascript:ok' })))
    for (const id of ['plain', 'disguised', 'img', 'form']) {
      const el = root.querySelector(`#${id}`)!
      expect([...el.attributes].map((x) => x.name)).toEqual(['id'])
    }
    expect(root.querySelector('#btn')!.hasAttribute('formaction')).toBe(false)
    expect(root.querySelector('#bound')!.getAttribute('href')).toBe('https://example.com/')
    expect(root.querySelector('#relative')!.getAttribute('href')).toBe('/javascript:ok')
    url.cast('javascript:void(0)')
    await tick()
    expect(root.querySelector('#bound')!.hasAttribute('href')).toBe(false)
    expect(warns().filter((w) => w.includes('javascript: URL'))).toHaveLength(4) // once per attribute name
  })

  it('a string on* handler is refused: no attribute, no listener', () => {
    const warns = lints()
    const root = container()
    const adds = spyMethod(eventTargetProto(), 'addEventListener')
    // @ts-expect-error the types refuse string handlers too; this is the untyped-caller path
    mount(root, button({ onclick: 'window.__pwned = true', onmouseover: 'x()' }))
    const btn = root.querySelector('button')!
    expect(btn.hasAttribute('onclick')).toBe(false)
    expect(btn.hasAttribute('onmouseover')).toBe(false)
    expect(adds).toEqual([])
    btn.click()
    expect((window as unknown as Record<string, unknown>)['__pwned']).toBeUndefined()
    expect(warns().filter((w) => w.includes('must be a function'))).toHaveLength(2)
  })
})

describe('exit transitions and accessibility', () => {
  it('an exiting element is inert until it detaches', async () => {
    const root = container()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const rows = cell([1, 2])
    mount(root, ul({}, () => rows().map((n) => li({ key: n, exit: () => gate }, String(n)))))
    rows.cast([1])
    await tick()
    const leaving = root.querySelectorAll('li')[1]!
    expect(leaving.hasAttribute('inert')).toBe(true)
    expect(root.querySelectorAll('li')[0]!.hasAttribute('inert')).toBe(false)
    release()
    await tick()
    expect(leaving.isConnected).toBe(false)
  })

  it('a throwing exit hook removes the element immediately and reports', async () => {
    const root = container()
    const reports: string[] = []
    restores.push(onRenderError((what) => reports.push(what)))
    const rows = cell([1, 2])
    mount(root, ul({}, () => rows().map((n) => li({ key: n, exit: () => { throw new Error('bad exit') } }, String(n)))))
    rows.cast([1])
    await tick()
    expect(root.querySelectorAll('li').length).toBe(1)
    expect(reports).toEqual(['exit hook threw; removing immediately'])
  })
})

describe('in-place replacement and failure paths', () => {
  it('patching an element through every child shape change keeps order and content', async () => {
    const root = container()
    const n = cell(0)
    const inner = cell('live')
    const shapes: VNode[] = [
      div({}, 'a', span({}, 'b'), null, 'd'),
      div({}, span({}, 'a'), inner, span({ id: 'c' }, 'c'), 'd'), // text→el, el→hole, empty→el
      div({}, 'x', 'y', null, inner), // el→text, hole→text, el→empty, text→hole
    ]
    mount(root, () => shapes[n()])
    expect(root.textContent).toBe('abd')
    n.cast(1)
    await tick()
    expect(root.textContent).toBe('alivecd')
    n.cast(2)
    await tick()
    expect(root.textContent).toBe('xylive')
    inner.cast('still')
    await tick()
    expect(root.textContent).toBe('xystill')
  })

  it('removing an attribute that had a live binding removes it and stops the binding', async () => {
    const root = container()
    const on = cell(true)
    const cls = cell('a')
    mount(root, () => (on() ? div({ class: cls }) : div({})))
    const el = root.querySelector('div')!
    expect(el.getAttribute('class')).toBe('a')
    on.cast(false)
    await tick()
    expect(root.querySelector('div')).toBe(el)
    expect(el.hasAttribute('class')).toBe(false)
    cls.cast('b')
    await tick()
    expect(el.hasAttribute('class')).toBe(false)
  })

  it('a throwing attribute binding keeps its previous value and reports', async () => {
    const root = container()
    const reports: string[] = []
    restores.push(onRenderError((what) => reports.push(what)))
    const n = cell(1)
    mount(root, div({ title: () => {
      if (n() < 0) throw new Error('neg')
      return String(n())
    } }))
    n.cast(-1)
    await tick()
    flush()
    expect(root.querySelector('div')!.getAttribute('title')).toBe('1')
    expect(reports).toEqual(['attribute "title" threw; keeping previous content'])
  })

  it('a promise superseded before it settles is ignored', async () => {
    const root = container()
    let resolve!: (v: string) => void
    const slow = new Promise<string>((r) => (resolve = r))
    const phase = cell(0)
    mount(root, div({}, () => (phase() === 0 ? slow : 'now')))
    phase.cast(1)
    await tick()
    expect(root.textContent).toBe('now')
    resolve('stale')
    await tick()
    expect(root.textContent).toBe('now')
  })

  it('a keyed element whose explicit namespace flips is rebuilt in the new namespace', async () => {
    const root = container()
    const svg = cell(false)
    mount(root, div({}, () => [h('a', svg() ? { key: 1, ns: 'http://www.w3.org/2000/svg' } : { key: 1 }, 'link')]))
    const before = root.querySelector('a')!
    expect(before.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
    svg.cast(true)
    await tick()
    const after = root.querySelector('div')!.firstElementChild!
    expect(after).not.toBe(before)
    expect(after.namespaceURI).toBe('http://www.w3.org/2000/svg')
    expect(root.querySelector('div')!.children.length).toBe(1)
  })

  it('a throwing view thunk renders nothing, reports, and recovers', async () => {
    const root = container()
    const reports: string[] = []
    restores.push(onRenderError((what) => reports.push(what)))
    const n = cell(-1)
    mount(root, () => {
      if (n() < 0) throw new Error('not yet')
      return span({}, String(n()))
    })
    expect(root.textContent).toBe('')
    expect(reports).toEqual(['view read threw; keeping previous content'])
    n.cast(3)
    await tick()
    expect(root.textContent).toBe('3')
  })

  it('domSink adapts a container to core mount; disposal empties it', async () => {
    const root = container()
    const n: Process<number, number> = cell(1)
    const handle = coreMount(domSink(root), div({}, () => String(n())))
    expect(root.textContent).toBe('1')
    n.cast(2)
    await tick()
    expect(root.textContent).toBe('2')
    handle[Symbol.dispose]()
    expect(root.childNodes.length).toBe(0)
  })
})
