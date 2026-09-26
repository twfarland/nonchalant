// The keyed diff as plain data, no DOM: which old item each new one reuses,
// and which of the reused ones can stay where they are.

import type { VNode } from '@nonchalant/core'

/** What matching needs to know about a rendered item. */
export type Matchable = { kind: 'text' } | { kind: 'el'; item: { vnode: VNode } }

/**
 * For each entry of `flat`, the index of the old item it reuses, or -1 for a
 * new one. Keyed vnodes match by key (`key: 0` is a key — presence, not
 * truthiness); unkeyed vnodes and text match positionally, against the first
 * old item not yet matched, and the cursor advances only past a match. An
 * element match also needs the same tag and the same keyedness. Each old item
 * matches at most once; `used` is filled with the matched old indices.
 */
export function match(olds: readonly Matchable[], flat: readonly (string | VNode)[], used: boolean[]): number[] {
  const byKey = new Map<unknown, number>()
  for (let i = 0; i < olds.length; i++) {
    const it = olds[i] as Matchable
    if (it.kind === 'el' && 'key' in it.item.vnode.attrs) byKey.set(it.item.vnode.attrs['key'], i)
  }
  let cursor = 0
  const from: number[] = []
  for (const r of flat) {
    let i = -1
    if (typeof r === 'string') {
      while (used[cursor]) cursor++
      if (olds[cursor]?.kind === 'text') i = cursor++
    } else {
      const keyed = 'key' in r.attrs
      let c: number | undefined
      if (keyed) c = byKey.get(r.attrs['key'])
      else {
        while (used[cursor]) cursor++
        c = cursor
      }
      const cand = c === undefined || used[c] ? undefined : olds[c]
      if (cand?.kind === 'el' && keyed === ('key' in cand.item.vnode.attrs) && cand.item.vnode.tag === r.tag) {
        if (!keyed) cursor++
        i = c as number
      }
    }
    if (i >= 0) used[i] = true
    from.push(i)
  }
  return from
}

/**
 * Marks one longest strictly increasing subsequence of `from` (old positions;
 * -1 = new, never kept). Kept nodes are already in relative order and stay;
 * every other node moves, so moves = survivors − LIS, the minimum possible.
 */
export function keepers(from: readonly number[]): boolean[] {
  const tails: number[] = [] // tails[k]: index ending the best run of length k + 1
  const prev: number[] = []
  for (let i = 0; i < from.length; i++) {
    const v = from[i] as number
    if (v < 0) continue
    let lo = 0
    let hi = tails.length
    // in-order runs (appends, in-place updates) extend the tail without a search
    if (hi > 0 && (from[tails[hi - 1] as number] as number) < v) lo = hi
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((from[tails[mid] as number] as number) < v) lo = mid + 1
      else hi = mid
    }
    prev[i] = lo > 0 ? (tails[lo - 1] as number) : -1
    tails[lo] = i
  }
  const keep: boolean[] = []
  for (let i = tails.at(-1) ?? -1; i >= 0; i = prev[i] as number) keep[i] = true
  return keep
}
