import { describe, it, expect } from 'vitest'
import { reconcile, type Json } from '../src/reconcile.ts'

// CI perf budget: reconcile of 1 changed item in 10k ≤ 100µs.
// Measured 46µs on the design machine (Node v22.12) — the budget is ~2x headroom.
// The statistic is the best of several round medians: each round's median
// shrugs off a GC pause, and taking the quietest round shrugs off a noisy
// neighbour on a shared runner, while every figure is still a median of
// hundreds of real runs.
// RECONCILE_BUDGET_US can only tighten the budget; a larger or malformed value
// is ignored rather than allowed to loosen a CI assertion.

const MAX_BUDGET_US = 100
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const requested = Number(env?.['RECONCILE_BUDGET_US'])
const BUDGET_US = requested > 0 ? Math.min(requested, MAX_BUDGET_US) : MAX_BUDGET_US

const ROUNDS = 5
const SAMPLES = 200

const mk = (i: number): Json => ({
  id: i,
  title: `item ${i}`,
  done: false,
  tags: ['a', 'b'],
  meta: { v: 0, ts: 123 },
})

describe('reconcile perf budget', () => {
  it('the budget cannot be loosened from the environment', () => {
    expect(BUDGET_US).toBeLessThanOrEqual(MAX_BUDGET_US)
  })

  it(`1 changed of 10k immutable items reconciles in ≤ ${BUDGET_US}µs (best of ${ROUNDS} round medians)`, () => {
    const N = 10_000
    const base: Json[] = Array.from({ length: N }, (_, i) => mk(i))
    const next: Json[] = base.map((x, i) => (i === N / 2 ? { ...(x as object), done: true } as Json : x))

    const run = () => reconcile(base, next)
    for (let i = 0; i < 200; i++) run() // warmup: let the JIT settle

    const medians: number[] = []
    for (let r = 0; r < ROUNDS; r++) {
      const samples: number[] = []
      for (let i = 0; i < SAMPLES; i++) {
        const t0 = performance.now()
        run()
        samples.push((performance.now() - t0) * 1000)
      }
      samples.sort((a, b) => a - b)
      medians.push(samples[samples.length >> 1] as number)
    }

    expect(reconcile(base, next)).toStrictEqual([['set', '/5000/done', true]])
    expect(Math.min(...medians)).toBeLessThanOrEqual(BUDGET_US)
  })
})
