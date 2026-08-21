// v2: identity-guard before recursion; paths built only on the changed spine.
function reconcile(prev, next, path, ops) {
  const tp = typeof next
  if (prev === null || next === null || tp !== 'object' || typeof prev !== 'object'
      || Array.isArray(prev) !== Array.isArray(next)) {
    ops.push(['set', path, next]); return
  }
  if (Array.isArray(next)) {
    const n = Math.min(prev.length, next.length)
    for (let i = 0; i < n; i++)
      if (prev[i] !== next[i]) reconcile(prev[i], next[i], path + '/' + i, ops)
    if (next.length > prev.length)
      ops.push(['splice', path, prev.length, 0, next.slice(prev.length)])
    else if (next.length < prev.length)
      ops.push(['splice', path, next.length, prev.length - next.length, []])
    return
  }
  for (const k in prev) if (!(k in next)) ops.push(['del', path + '/' + k])
  for (const k in next)
    if (prev[k] !== next[k]) reconcile(prev[k], next[k], path + '/' + k, ops)
}

const N = 10_000
const mk = (i, v=0) => ({ id: i, title: 'item ' + i, done: false, tags: ['a','b'], meta: { v, ts: 123 } })
const base = Array.from({ length: N }, (_, i) => mk(i))
const bench = (name, fn, iters=1000) => {
  fn()
  const t0 = performance.now()
  for (let i = 0; i < iters; i++) fn()
  console.log(name.padEnd(46), (((performance.now()-t0)/iters)*1000).toFixed(1).padStart(8), 'µs/op')
}
let next1 = base.map((x, i) => i === 5000 ? { ...x, done: true } : x)
bench(`immutable: 1 of ${N} changed`, () => { const ops=[]; reconcile(base, next1, '', ops) })
let next2 = [...base, mk(N)]
bench(`immutable: append 1 to ${N}`, () => { const ops=[]; reconcile(base, next2, '', ops) })
let big = Array.from({ length: 100_000 }, (_, i) => mk(i))
let bigNext = big.map((x,i) => i === 99999 ? {...x, done:true} : x)
bench(`immutable: 1 of 100k changed`, () => { const ops=[]; reconcile(big, bigNext, '', ops) })
let next3 = JSON.parse(JSON.stringify(base)); next3[5000].done = true
bench(`no sharing: full deep walk of ${N}`, () => { const ops=[]; reconcile(base, next3, '', ops) }, 50)
