import { describe, it, expect } from 'vitest'
import { reconcile, type Json } from '../src/reconcile.ts'

// CI perf budget: reconcile of 1 changed item in 10k ≤ 100µs.
// Measured 46µs on the design machine (Node v22.12) — the budget is ~2x headroom.
// Median over many iterations so a GC pause or scheduler hiccup can't flake CI.
// Override via RECONCILE_BUDGET_US for unusually slow runners.

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const BUDGET_US = Number(env?.['RECONCILE_BUDGET_US'] ?? 100)

const mk = (i: number): Json => ({
  id: i,
  title: `item ${i}`,
  done: false,
  tags: ['a', 'b'],
  meta: { v: 0, ts: 123 },
})

describe('reconcile perf budget', () => {
  it(`1 changed of 10k immutable items reconciles in ≤ ${BUDGET_US}µs (median)`, () => {
    const N = 10_000
    const base: Json[] = Array.from({ length: N }, (_, i) => mk(i))
    const next: Json[] = base.map((x, i) => (i === N / 2 ? { ...(x as object), done: true } as Json : x))

    const run = () => reconcile(base, next)
    for (let i = 0; i < 100; i++) run() // warmup: let the JIT settle

    const samples: number[] = []
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now()
      run()
      samples.push((performance.now() - t0) * 1000)
    }
    samples.sort((a, b) => a - b)
    const median = samples[samples.length >> 1] as number

    expect(reconcile(base, next)).toStrictEqual([['set', '/5000/done', true]])
    expect(median).toBeLessThanOrEqual(BUDGET_US)
  })
})
