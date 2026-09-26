// Watched readers. A reader is *watched* when it is an effect, or a computed
// with an effect somewhere downstream. A derive read once outside any effect
// keeps its links (alien-signals only drops a computed's deps when its last
// subscriber leaves), but it does not keep a source watched: gates count in
// only when their reader gains a watched path, and count out when it loses
// the last one, even while some other unwatched computed still links it.
//
// The watched bit is not stored; it is re-judged at the transitions graph.ts
// raises. Walk epochs keep both walks O(nodes + links): a computed DAG has
// exponentially many paths but linearly many nodes, and each walk stamps the
// nodes it reaches.

import type { ReactiveNode } from './system.ts'

/** What counting needs of a gate: whether it is counted, and the source whose watcher total it feeds. */
export interface Counted {
  counted: boolean
  source: { watched: number; onWatchers: ((count: number) => void) | undefined }
}

/** A computed node's walk stamps: the last isWatched query / rewatch walk that reached it. */
export interface Stamped extends ReactiveNode {
  seen: number
  swept: number
}

let seenEpoch = 0
let sweptEpoch = 0

/** Does an effect sit at or downstream of this node? Disposed effects have flags 0. */
export const isWatched = (node: ReactiveNode): boolean => watchedFrom(node, ++seenEpoch)

function watchedFrom(node: ReactiveNode, epoch: number): boolean {
  if ('fn' in node) return node.flags !== 0
  // a node already reached this walk answered false (a true ends the walk)
  if ((node as Stamped).seen === epoch) return false
  ;(node as Stamped).seen = epoch
  for (let l = node.subs; l; l = l.nextSub) if (watchedFrom(l.sub, epoch)) return true
  return false
}

/** Move a gate in (`on`) or out of its source's watcher count, reporting the new total on a change. */
export function count(gate: Counted, on: boolean): void {
  if (gate.counted === on) return
  gate.counted = on
  const s = gate.source
  // the total exists only to be reported: with no listener it is never kept
  s.onWatchers?.((s.watched += on ? 1 : -1))
}

/** A computed just gained (`on`) or lost its watched path: re-judge the gates beneath it. */
export const rewatch = (node: ReactiveNode, on: boolean): void => sweep(node, on, ++sweptEpoch)

function sweep(node: ReactiveNode, on: boolean, epoch: number): void {
  for (let l = node.deps; l; l = l.nextDep) {
    // a gate's signal node carries `gate`; a computed carries `getter` and its stamps
    const dep = l.dep as ReactiveNode & { gate?: Counted; swept?: number }
    const gate = dep.gate
    if (gate) count(gate, on)
    else if ('getter' in dep && dep.swept !== epoch) {
      dep.swept = epoch
      if (on || !isWatched(dep)) sweep(dep, on, epoch)
    }
  }
}
