// The delegation tree without a DOM: the root run is a process, so a test
// iterates it like any other and reads the trace as a sequence of snapshots.

import { describe, it, expect } from 'vitest'
import { spawn } from '@nonchalant/core'
import { agent, crew, queued, stubModel, text, tool, type Node, type Run, type Tool } from './delegation.ts'

const start = (lead: Tool, input: string) => {
  const run: Run = { id: 'root', name: 'lead', input }
  return spawn(lead.run, run, { initial: queued(lead, run) })
}

const all = (n: Node): Node[] => [n, ...n.children.flatMap(all)]

const busy = (n: Node): boolean => n.status !== 'queued' && n.status !== 'done' && n.status !== 'failed'

describe('delegation', () => {
  it('builds the whole call tree in the root state, and answers from it', async () => {
    const root = start(crew(stubModel({ latency: 4 }), { searchLatency: 4 }), 'process vs actor, 6 * 7')
    const snaps: Node[] = []
    for await (const s of root) snaps.push(s)

    const tree = root()
    expect(tree.status).toBe('done')
    expect(tree.children.map((c) => `${c.kind}:${c.name}(${c.input})`)).toEqual([
      'agent:researcher(process)',
      'agent:researcher(actor)',
      'tool:calc(6 * 7)',
    ])
    expect(tree.children.map((c) => c.children.length)).toEqual([2, 2, 0])
    expect(all(tree).every((n) => n.status === 'done')).toBe(true)
    expect(text(tree)).toContain('42')
    expect(text(tree)).toContain('an async generator with a mailbox')
  })

  it('runs sibling calls at the same time, at both levels', async () => {
    const root = start(crew(stubModel({ latency: 4 }), { searchLatency: 20 }), 'process and signal')
    let researchers = 0
    let searches = 0
    for await (const s of root) {
      researchers = Math.max(researchers, s.children.filter(busy).length)
      searches = Math.max(searches, all(s).filter((n) => n.name === 'search' && busy(n)).length)
    }
    expect(researchers).toBe(2)
    expect(searches).toBe(4)
  })

  it('shares every untouched subtree between consecutive snapshots', async () => {
    const root = start(crew(stubModel({ latency: 4 }), { searchLatency: 4 }), 'process vs actor')
    let prev: Node | undefined
    let shared = 0
    for await (const s of root) {
      if (prev !== undefined && s.children.length === prev.children.length)
        shared += s.children.filter((c, i) => c === prev!.children[i]).length
      prev = s
    }
    expect(shared).toBeGreaterThan(0)
  })

  it('aborts every run in the tree when the root is disposed', async () => {
    let started = 0
    let aborted = 0
    const hang = tool((_q, signal) => {
      started++
      return new Promise((_, reject) => signal.addEventListener('abort', () => {
        aborted++
        reject(new Error('cancelled'))
      }))
    })
    const model = stubModel({ latency: 4 })
    const researcher = agent('researcher', { model, tools: { search: hang } })
    const root = start(agent('lead', { model, tools: { researcher } }), 'process and actor')

    for await (const s of root) if (all(s).filter((n) => n.name === 'search' && n.status === 'running').length === 4) break
    await root[Symbol.asyncDispose]()

    expect(started).toBe(4)
    expect(aborted).toBe(4)
  })

  it('records a call to a tool that does not exist as a failed node', async () => {
    const model = stubModel({ latency: 4 })
    const root = start(agent('lead', { model, tools: {} }), 'anything')
    for await (const _ of root) void _
    expect(root().children.map((c) => c.status)).toEqual(['failed', 'failed'])
    expect(root().status).toBe('done')
  })
})
