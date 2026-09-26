// The pure edges of element creation and region reconciliation: which
// namespace an element is created in, and what a dynamic slot's value flattens
// to before it is matched.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { h } from '../src/h.ts'
import { elementNs } from '../src/element.ts'
import { flattenDynamic } from '../src/region.ts'
import { onRenderError } from '../src/report.ts'

const XHTML = 'http://www.w3.org/1999/xhtml'
const SVG = 'http://www.w3.org/2000/svg'
const MATHML = 'http://www.w3.org/1998/Math/MathML'

describe('elementNs', () => {
  const cases: [tag: string, explicit: string | undefined, parent: string, ns: string][] = [
    ['div', undefined, XHTML, XHTML],
    ['svg', undefined, XHTML, SVG],
    ['math', undefined, XHTML, MATHML],
    ['circle', undefined, SVG, SVG],
    ['mi', undefined, MATHML, MATHML],
    ['svg', XHTML, XHTML, XHTML],
    ['div', SVG, XHTML, SVG],
  ]
  for (const [tag, explicit, parent, ns] of cases) {
    it(`<${tag}> ${explicit === undefined ? 'inherits or infers' : 'takes the explicit ns'} → ${ns.split('/').at(-1)}`, () => {
      expect(elementNs(tag, explicit, parent)).toBe(ns)
    })
  }
})

describe('flattenDynamic', () => {
  let reports: string[] = []
  let restore = (): void => {}
  beforeEach(() => {
    reports = []
    restore = onRenderError((what) => reports.push(what))
  })
  afterEach(() => restore())

  it('renders strings and numbers as text', () => {
    expect(flattenDynamic('a')).toEqual(['a'])
    expect(flattenDynamic(0)).toEqual(['0'])
  })

  it('renders null, undefined, and booleans as nothing, silently', () => {
    for (const v of [null, undefined, true, false]) expect(flattenDynamic(v)).toEqual([])
    expect(reports).toEqual([])
  })

  it('flattens nested arrays in order and keeps vnodes by reference', () => {
    const b = h('b')
    const out = flattenDynamic(['x', [b, [1, [null, 'y']]]])
    expect(out).toEqual(['x', b, '1', 'y'])
    expect(out[1]).toBe(b)
  })

  it('skips anything else and reports each one', () => {
    expect(flattenDynamic(['a', {}, () => 1, 'b'])).toEqual(['a', 'b'])
    expect(reports).toEqual([
      'unsupported value in dynamic slot (object); skipping',
      'unsupported value in dynamic slot (function); skipping',
    ])
  })
})
