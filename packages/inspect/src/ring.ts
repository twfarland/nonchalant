// The bound on the recording. Entries leave oldest first; a yield that leaves
// folds its patch into its process's base first, so what is retained always
// reconstructs, and an ended process leaves with its exit.

import { applyPatch } from '@nonchalant/core'
import type { Entry, Recording } from './recording.ts'

/**
 * How many of the oldest entries to drop from a ring of `size` holding
 * `length`: none while it fits, otherwise at least a quarter of the ring, so
 * most appends reach the timeline's readers as a single splice.
 */
export const cut = (length: number, size: number): number =>
  length <= size ? 0 : Math.max(length - size, Math.ceil(size / 4))

/** The process table after `e` leaves the ring. */
export function fold(procs: Recording['procs'], e: Entry): Recording['procs'] {
  const node = procs[e.id]
  if (node === undefined) return procs
  if (e.type === 'yield') return { ...procs, [e.id]: { ...node, base: applyPatch(node.base, e.ops), baseSeq: e.seq } }
  if (e.type === 'exit' && node.status !== 'running') {
    const { [e.id]: _gone, ...rest } = procs
    return rest
  }
  return procs
}

/** Drop what no longer fits, folding each dropped entry into the process table. */
export function trim(rec: Recording): Recording {
  const n = cut(rec.events.length, rec.size)
  if (n === 0) return rec
  let procs = rec.procs
  for (const e of rec.events.slice(0, n)) procs = fold(procs, e)
  return { ...rec, events: rec.events.slice(n), procs }
}
