// The process table as the ownership tree the panel shows.

import type { ProcNode, Recording } from './recording.ts'

export interface TreeNode {
  node: ProcNode
  children: TreeNode[]
}

/** Recorded processes not yet disposed, nested by ownership (unknown parents become roots). */
export function tree(procs: Recording['procs']): TreeNode[] {
  const byId = new Map<number, TreeNode>()
  for (const node of Object.values(procs)) if (node.status !== 'disposed') byId.set(node.id, { node, children: [] })
  const roots: TreeNode[] = []
  for (const t of byId.values()) {
    const parent = t.node.parent === null ? undefined : byId.get(t.node.parent)
    if (parent === undefined) roots.push(t)
    else parent.children.push(t)
  }
  return roots
}
