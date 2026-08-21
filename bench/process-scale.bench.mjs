// How many suspended async generators can one Node process carry?
// Measured 2026-08 on Node v22.12: spawn+first-yield 100k ≈ 220ms (~2.2µs each),
// one tick across all ≈ 91ms (~0.9µs each), RSS ≈ 137MB (~1.4KB each).
const N = 100_000
async function* proc() { let n = 0; while (true) { n++; yield n } }
const t0 = performance.now()
const procs = Array.from({ length: N }, () => proc())
await Promise.all(procs.map((p) => p.next()))
const t1 = performance.now()
await Promise.all(procs.map((p) => p.next()))
const t2 = performance.now()
console.log(`spawn+first yield of ${N}: ${(t1 - t0).toFixed(0)}ms | one tick across all: ${(t2 - t1).toFixed(0)}ms`)
console.log('rss MB:', (process.memoryUsage().rss / 1048576).toFixed(0))
