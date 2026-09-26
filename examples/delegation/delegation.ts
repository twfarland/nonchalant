// Delegation as process composition. Every tool run is a process that yields
// its own trace node, and an agent is just a tool whose run spawns more runs:
// it folds each child's stream into its own node's `children` and re-yields.
// So the root's state is the whole live call tree, one plain value, and a
// grandchild's token reaches the page the same way a counter's tick does.
//
// Parallel tool calls are the model returning more than one call: they are
// spawned together and their streams merged. Cancellation is ownership: the
// runs belong to the agent that spawned them, so disposing the root aborts
// every model call and tool in the tree through `self.signal`.

import { spawn } from '@nonchalant/core'
import type { Proc, Process } from '@nonchalant/core'
import { evaluate } from '../agent/tools.ts'

// ---------- the trace ----------

export type Status = 'queued' | 'running' | 'thinking' | 'calling' | 'streaming' | 'done' | 'failed'

export type Node = {
  id: string
  kind: 'agent' | 'tool'
  name: string
  input: string
  status: Status
  /** Chunks, not a growing string: appending is one splice op on any wire. */
  output: string[]
  children: Node[]
}

/** `name` is what the caller called it by, so the node labels itself. */
export type Run = { id: string; name: string; input: string }

/** Anything the model can call. `kind` is known before the run starts, so a queued node draws right. */
export type Tool = { kind: 'agent' | 'tool'; run: Proc<Node, never, Run> }

export type Toolbox = { readonly [name: string]: Tool }

export const queued = (tool: Tool, { id, name, input }: Run): Node =>
  ({ id, kind: tool.kind, name, input, status: 'queued', output: [], children: [] })

export const text = (n: Node): string => n.output.join(' ')

// ---------- the model (stubbed; the shape is what matters) ----------

export type ToolCall = { tool: string; input: string }

/** More than one call is a parallel tool call. */
export type Plan = { calls: ToolCall[] } | { answer: string }

export interface Model {
  plan(agent: string, transcript: readonly string[], tools: readonly string[], opts: { signal: AbortSignal }): Promise<Plan>
  stream(text: string, opts: { signal: AbortSignal }): AsyncIterable<string>
}

export const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('cancelled'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })

/**
 * First turn: a lead with a `researcher` fans out one call per topic (plus
 * `calc` if the question has arithmetic in it); anyone else searches twice at
 * once. Second turn: answer from what came back.
 */
export function stubModel(opts: { latency?: number } = {}): Model {
  const latency = opts.latency ?? 300
  return {
    async plan(_agent, transcript, tools, { signal }) {
      await delay(latency, signal)
      const [question = '', ...results] = transcript
      if (results.length > 0) return { answer: results.map((r) => r.split(' → ')[1] ?? r).join('; ') }

      if (tools.includes('researcher')) {
        const sum = question.match(/[\d.]+(?:\s*[-+*/]\s*[\d.]+)+/)?.[0]
        const topics = question.replace(sum ?? '', '').split(/\s+(?:and|vs)\s+|,\s*/).map((t) => t.trim()).filter((t) => t !== '')
        return {
          calls: [
            ...topics.map((topic) => ({ tool: 'researcher', input: topic })),
            ...(sum === undefined ? [] : [{ tool: 'calc', input: sum }]),
          ],
        }
      }
      return { calls: [{ tool: 'search', input: question }, { tool: 'search', input: `${question} pitfalls` }] }
    },

    async *stream(answer, { signal }) {
      for (const word of answer.split(' ')) {
        await delay(latency / 8, signal)
        yield word
      }
    },
  }
}

// ---------- merging child streams ----------

/**
 * Interleave several streams, tagging each value with its source's index; ends
 * when all have. It takes the caller's signal because a disposed process only
 * unwinds once its pending await settles, and its children are disposed after
 * that, so a merge waiting on them has to give up on abort or nothing moves.
 */
export async function* merge<T>(streams: readonly AsyncIterable<T>[], signal: AbortSignal): AsyncGenerator<[number, T]> {
  const its = streams.map((s) => s[Symbol.asyncIterator]())
  const pull = (i: number) => its[i]!.next().then((r) => ({ i, r }))
  const inflight = new Map(its.map((_, i) => [i, pull(i)]))
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  aborted.catch(() => {})
  try {
    while (inflight.size > 0) {
      const { i, r } = await Promise.race([aborted, ...inflight.values()])
      if (r.done) {
        inflight.delete(i)
        continue
      }
      inflight.set(i, pull(i))
      yield [i, r.value]
    }
  } finally {
    for (const it of its) void it.return?.()
  }
}

// ---------- tools ----------

/** A one-shot tool: running, then done or failed. Failure is data in the tree, not a crash. */
export const tool = (work: (input: string, signal: AbortSignal) => Promise<string>): Tool => ({
  kind: 'tool',
  run: async function* (self, { id, name, input }) {
    const n: Node = { id, kind: 'tool', name, input, status: 'running', output: [], children: [] }
    yield n
    try {
      yield { ...n, status: 'done', output: [await work(input, self.signal)] }
    } catch (e) {
      yield { ...n, status: 'failed', output: [e instanceof Error ? e.message : String(e)] }
    }
  },
})

const missing = tool(async (input) => {
  throw new Error(`no such tool (asked with "${input}")`)
})

// ---------- the agent ----------

const MAX_TURNS = 4

export interface Env {
  model: Model
  tools: Toolbox
}

export const agent = (name: string, { model, tools }: Env): Tool => ({
  kind: 'agent',
  run: async function* (self, { id, name: called, input }) {
    let n: Node = { id, kind: 'agent', name: called, input, status: 'thinking', output: [], children: [] }
    const transcript = [input]

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      n = { ...n, status: 'thinking' }
      yield n
      const plan = await model.plan(name, transcript, Object.keys(tools), { signal: self.signal })

      if ('answer' in plan) {
        n = { ...n, status: 'streaming' }
        yield n
        for await (const chunk of model.stream(plan.answer, { signal: self.signal })) {
          n = { ...n, output: [...n.output, chunk] }
          yield n
        }
        yield { ...n, status: 'done' }
        return // a run is over when it answers, and its stream ends with it
      }

      const at = n.children.length
      const calls = plan.calls.map((c, i) => {
        const use = tools[c.tool] ?? missing
        const run = { id: `${id}/${at + i}`, name: c.tool, input: c.input }
        return { use, run, node: queued(use, run) }
      })
      n = { ...n, status: 'calling', children: [...n.children, ...calls.map((c) => c.node)] }
      yield n

      // Spawned straight after a yield, before any await: that is this
      // process's own step, so the runs are owned by it and die with it.
      // (Spawned after the `await model.plan` above, they would run unowned.)
      const runs: Process<Node>[] = calls.map((c) => spawn(c.use.run, c.run, { initial: c.node }))
      for await (const [i, child] of merge(runs, self.signal)) {
        n = { ...n, children: n.children.with(at + i, child) }
        yield n
      }
      transcript.push(...n.children.slice(at).map((c) => `${c.name}(${c.input}) → ${text(c)}`))
    }
    yield { ...n, status: 'failed', output: [`no answer after ${MAX_TURNS} turns`] }
  },
})

// ---------- a crew ----------

const CORPUS: [topic: string, fact: string][] = [
  ['process', 'an async generator with a mailbox'],
  ['actor', 'a mailbox and a behaviour, addressed by reference'],
  ['signal', 'a value that tells its readers when it changes'],
  ['pitfalls', 'watch the ownership window'],
]

export const search = (latency: number): Tool =>
  tool(async (q, signal) => {
    await delay(latency, signal)
    const facts = CORPUS.filter(([topic]) => q.toLowerCase().includes(topic)).map(([, fact]) => fact)
    return facts.length === 0 ? `nothing on "${q}"` : facts.join(', ')
  })

export const calc: Tool = tool(async (expr) => String(evaluate(expr)))

/** A lead who delegates to researchers, who each fan out to search. */
export function crew(model: Model, opts: { searchLatency?: number } = {}): Tool {
  const researcher = agent('researcher', { model, tools: { search: search(opts.searchLatency ?? 400) } })
  return agent('lead', { model, tools: { researcher, calc } })
}
