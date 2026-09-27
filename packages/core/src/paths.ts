// Patch intersection: the matching half of "read tracked". A PathTree is what
// one reader run read (track.ts records it; the precision rules live there);
// affects() answers whether a patch lands anywhere that run looked. Pure: no
// proxies, no graph.

import { parsePath } from './pointer.ts'
import type { Op, Patch } from './reconcile.ts'

export interface PathTree {
  children: Map<string, PathTree> | null
  /** A primitive (or absence) was read at this exact path. */
  leaf: boolean
  /** Keys / length were observed here — shape ops at this node wake. */
  structural: boolean
  /** The container read here was an array: a direct-child `set` is never a shape op. */
  array: boolean
  /** A container was obtained here during the run. */
  traversed: boolean
  /** The container escaped the reader — any op at or below wakes. */
  subtree: boolean
}

/** Does any op in the patch intersect the recorded read-paths? `segsList` carries the pre-parsed path per op — parse once per publish, not once per reader. */
export function affects(tree: PathTree, patch: Patch, segsList?: string[][]): boolean {
  for (let i = 0; i < patch.length; i++) {
    const op = patch[i]!
    if (opAffects(tree, op, segsList !== undefined ? segsList[i]! : parsePath(op[1]))) return true
  }
  return false
}

/** One op, its path already parsed into `segs`. */
export function opAffects(tree: PathTree, op: Op, segs: string[]): boolean {
  let node = tree
  for (let i = 0; i < segs.length; i++) {
    if (node.subtree || node.leaf) return true
    const key = segs[i] as string
    const c = node.children !== null ? node.children.get(key) : undefined
    if (i === segs.length - 1 && op[0] !== 'splice') {
      // set/del of the binding `key` under `node`: wakes if anything was read
      // at/below that binding, or if this node's key set was observed. An
      // array `set` replaces an element in place; an array `del` is a
      // one-element splice, shifting every later index (the diff never emits
      // one, but applyPatch and the wire spec accept it)
      if (c !== undefined) return true
      if (!node.array) return node.structural
      return op[0] === 'del' && (node.structural || readsFrom(node, Number(key)))
    }
    if (c === undefined) return false
    node = c
  }
  // path consumed: op targets `node` itself — a root set, or any splice
  if (op[0] !== 'splice') return hasDep(node)
  return node.subtree || node.leaf || node.structural || readsFrom(node, op[2])
}

/** Was any index at or after `start` read beneath this node? Those shift or change under a splice there. */
export function readsFrom(node: PathTree, start: number): boolean {
  const kids = node.children
  if (kids !== null) {
    for (const k of kids.keys()) {
      const idx = Number(k)
      if (Number.isInteger(idx) && idx >= start) return true
    }
  }
  return false
}

/** Did the run read anything at or below this node? */
export const hasDep = (n: PathTree): boolean =>
  n.leaf || n.structural || n.subtree || n.traversed || (n.children !== null && n.children.size > 0)
