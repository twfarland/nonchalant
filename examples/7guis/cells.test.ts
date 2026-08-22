// The derivation stress test (why cells is last in the 7GUIs ladder):
// dependency tracking must be automatic, exact, glitch-free, and cycle-safe.

import { describe, it, expect } from 'vitest'
import { createSheet } from './cells.ts'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('cells: the derivation graph', () => {
  it('formula chains evaluate and update through dependencies', async () => {
    const sheet = createSheet()
    sheet.set('A1', '1')
    sheet.set('B1', '=A1+1')
    sheet.set('C1', '=B1*2 + A1')
    await tick()
    expect(sheet.value('A1')).toBe(1)
    expect(sheet.value('B1')).toBe(2)
    expect(sheet.value('C1')).toBe(5)
    sheet.set('A1', '10')
    await tick()
    expect(sheet.value('C1')).toBe(32)
    expect(sheet.value('B1')).toBe(11)
    sheet.dispose()
  })

  it('editing one cell re-evaluates only its dependents', async () => {
    const sheet = createSheet()
    sheet.set('A1', '1')
    sheet.set('B1', '=A1+1')
    sheet.set('D9', '42') // unrelated
    sheet.set('E9', '=D9*2') // unrelated dependent
    await tick()
    for (const k of ['A1', 'B1', 'D9', 'E9']) void sheet.value(k)
    const before = new Map(sheet.evals)

    sheet.set('A1', '7')
    await tick()
    for (const k of ['A1', 'B1', 'D9', 'E9']) void sheet.value(k)
    const delta = (k: string): number => (sheet.evals.get(k) ?? 0) - (before.get(k) ?? 0)
    expect(delta('A1')).toBe(1)
    expect(delta('B1')).toBe(1)
    expect(delta('D9')).toBe(0) // its formula path was untouched: never re-parsed
    expect(delta('E9')).toBe(0)
    sheet.dispose()
  })

  it('the equality cut stops propagation where values do not change', async () => {
    const sheet = createSheet()
    sheet.set('A1', '3')
    sheet.set('B1', '=A1*0') // always 0
    sheet.set('C1', '=B1+1') // depends on B1 only
    await tick()
    for (const k of ['A1', 'B1', 'C1']) void sheet.value(k)
    const before = new Map(sheet.evals)

    sheet.set('A1', '8')
    await tick()
    for (const k of ['A1', 'B1', 'C1']) void sheet.value(k)
    const delta = (k: string): number => (sheet.evals.get(k) ?? 0) - (before.get(k) ?? 0)
    expect(delta('B1')).toBe(1) // recomputed…
    expect(delta('C1')).toBe(0) // …but B1 is still 0, so C1 sleeps
    sheet.dispose()
  })

  it('cycles resolve to #CYCLE without hanging', async () => {
    const sheet = createSheet()
    sheet.set('A2', '=B2')
    sheet.set('B2', '=A2')
    await tick()
    expect(sheet.value('A2')).toBe('#CYCLE')
    expect(sheet.value('B2')).toBe('#CYCLE')
    sheet.set('B2', '5') // break the cycle
    await tick()
    expect(sheet.value('B2')).toBe(5)
    expect(sheet.value('A2')).toBe(5)
    sheet.dispose()
  })

  it('junk parses to #ERR; text and empties pass through', async () => {
    const sheet = createSheet()
    sheet.set('A1', '=1 + + 2 (')
    sheet.set('B1', 'hello')
    await tick()
    expect(sheet.value('A1')).toBe('#ERR')
    expect(sheet.value('B1')).toBe('hello')
    expect(sheet.value('Z99')).toBe('')
    sheet.dispose()
  })
})
