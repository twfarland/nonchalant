import { describe, it, expect } from 'vitest'
import { reconcile, type Json } from '../src/reconcile.ts'

// CI perf budget: reconcile of 1 changed item in 10k ≤ 100µs.
// Measured 53µs on the design machine (Node v22.12), about 2x headroom.
// The statistic is the median of every timed run, 1000 of them. A median
// shrugs off GC pauses and scheduler hiccups; pooling all runs means no quiet
// stretch can be picked out to pass on. Warmup runs are untimed and separate.
// vitest.config.ts runs this file in its own project after every other file
// has finished, so it never shares the machine with the rest of the suite.
// RECONCILE_BUDGET_US can only tighten the budget; a larger or malformed value
// is ignored rather than allowed to loosen a CI assertion.

const MAX_BUDGET_US = 100
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const requested = Number(env?.['RECONCILE_BUDGET_US'])
const BUDGET_US = requested > 0 ? Math.min(requested, MAX_BUDGET_US) : MAX_BUDGET_US

const WARMUP = 1_000
const SAMPLES = 1_000

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

  it(`1 changed of 10k immutable items reconciles in ≤ ${BUDGET_US}µs (median of ${SAMPLES} runs)`, () => {
    const N = 10_000
    const base: Json[] = Array.from({ length: N }, (_, i) => mk(i))
    const next: Json[] = base.map((x, i) => (i === N / 2 ? { ...(x as object), done: true } as Json : x))

    const run = () => reconcile(base, next)
    for (let i = 0; i < WARMUP; i++) run() // untimed: lets the JIT reach its optimized tier

    const samples: number[] = []
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = performance.now()
      run()
      samples.push((performance.now() - t0) * 1000)
    }
    samples.sort((a, b) => a - b)
    const median = samples[samples.length >> 1] as number
    console.log(`reconcile 1-of-10k: median ${median.toFixed(1)}µs over ${SAMPLES} runs`)

    expect(reconcile(base, next)).toStrictEqual([['set', '/5000/done', true]])
    expect(median).toBeLessThanOrEqual(BUDGET_US)
  })
})
