// Several agents, and the four ways they are usually wired together. All four
// are ordinary process code here, because an agent is a process and a
// delegation is a message:
//
//   delegation        — an agent's tool is another agent: `d.call` into it
//   hand-off          — the supervisor passes one agent's output to the next
//   graph control     — `stage` is the node, the code between yields is the edge
//   usage limits      — one budget process every agent has to ask
//
// Everything a caller must not repeat after a crash goes through `d.step` or
// `d.call`. That is why killing the supervisor mid-pipeline does not re-run the
// research: the delegated call is journaled on both sides.

import type { Call, Cast, Proc, Process } from '@nonchalant/core'
import type { DurableProc } from '@nonchalant/durable'
import type { Model } from '../agent/llm.ts'
import type { ApprovalMsg, ApprovalState, SearchMsg, ToolState } from '../agent/tools.ts'

// ---------- usage limits: shared, and not durable ----------

export type BudgetState = { spent: number; limit: number; refused: number }
export type BudgetMsg =
  | Cast<{ type: 'reset'; limit: number }>
  | Call<{ type: 'spend'; tokens: number }, { ok: boolean; left: number }>

/**
 * A live meter, deliberately not durable: it is a resource limit for this
 * deployment, not a record of what happened. Callers wrap their `call` in
 * `d.step`, so a replay does not spend twice.
 */
export const budget = (limit: number): Proc<BudgetState, BudgetMsg, void> =>
  async function* (self) {
    let spent = 0
    let cap = limit
    let refused = 0
    yield { spent, limit: cap, refused }
    for await (const msg of self) {
      switch (msg.type) {
        case 'reset':
          spent = 0
          refused = 0
          cap = msg.limit
          break
        case 'spend':
          if (spent + msg.tokens > cap) {
            refused++
            msg.reply({ ok: false, left: cap - spent })
          } else {
            spent += msg.tokens
            msg.reply({ ok: true, left: cap - spent })
          }
          break
      }
      yield { spent, limit: cap, refused }
    }
  }

export interface Shared {
  model: Model
  search: Process<ToolState | undefined, SearchMsg>
  budget: Process<BudgetState | undefined, BudgetMsg>
}

const OUT_OF_BUDGET = '(out of budget)'

// ---------- two delegate agents ----------

export type WorkerState = { runs: number; last: string }

export type ResearchMsg = Call<{ type: 'research'; topic: string; callId: string }, string>

export const researcher: DurableProc<WorkerState, ResearchMsg, Shared & { id: string }> =
  async function* (self, { search, budget: meter }, d) {
    let s: WorkerState = d.restored ?? { runs: 0, last: '' }
    yield s
    for await (const msg of self) {
      const allowance = await d.step('budget', () => meter.call({ type: 'spend', tokens: 120 }))
      const notes = allowance.ok
        ? await d.step('search', () => search.call({ type: 'search', q: msg.topic }))
        : OUT_OF_BUDGET
      s = { runs: s.runs + 1, last: notes }
      msg.reply(notes)
      yield s
    }
  }

export type WriteMsg = Call<{ type: 'write'; topic: string; notes: string; callId: string }, string>

export const writer: DurableProc<WorkerState, WriteMsg, Shared & { id: string }> =
  async function* (self, { model, budget: meter }, d) {
    let s: WorkerState = d.restored ?? { runs: 0, last: '' }
    yield s
    for await (const msg of self) {
      const allowance = await d.step('budget', () => meter.call({ type: 'spend', tokens: 200 }))
      const draft = allowance.ok
        ? await d.step('compose', () => model.compose(msg.topic, msg.notes, { signal: self.signal }))
        : OUT_OF_BUDGET
      s = { runs: s.runs + 1, last: draft }
      msg.reply(draft)
      yield s
    }
  }

// ---------- the supervisor: the graph is the state ----------

export type Stage = 'idle' | 'researching' | 'writing' | 'approving' | 'published' | 'held' | 'broke'

export type Pipeline = {
  stage: Stage
  topic: string
  notes: string
  draft: string
}

export type PipelineMsg = Cast<{ type: 'brief'; topic: string }>

export interface Crew {
  researcher: Process<WorkerState | undefined, ResearchMsg>
  writer: Process<WorkerState | undefined, WriteMsg>
  approvals: Process<ApprovalState | undefined, ApprovalMsg>
}

export const initialPipeline: Pipeline = { stage: 'idle', topic: '', notes: '', draft: '' }

export const supervisor: DurableProc<Pipeline, PipelineMsg, Crew & { id: string }> =
  async function* (self, crew, d) {
    let s: Pipeline = d.restored ?? initialPipeline
    yield s

    for await (const msg of self) {
      s = { stage: 'researching', topic: msg.topic, notes: '', draft: '' }
      yield s

      // delegation: the tool is another agent, and the call is journaled on
      // both sides — a replay calls with the same id and gets the same answer
      const notes = await d.call('research', (callId) =>
        crew.researcher.call({ type: 'research', topic: msg.topic, callId }))
      if (notes === OUT_OF_BUDGET) {
        s = { ...s, stage: 'broke', notes }
        yield s
        continue
      }

      // hand-off: what one agent produced is what the next one is given
      s = { ...s, stage: 'writing', notes }
      yield s
      const draft = await d.call('write', (callId) =>
        crew.writer.call({ type: 'write', topic: msg.topic, notes, callId }))
      if (draft === OUT_OF_BUDGET) {
        s = { ...s, stage: 'broke', draft }
        yield s
        continue
      }

      // a person is a step like any other: journaled, so a restart does not ask twice
      s = { ...s, stage: 'approving', draft }
      yield s
      const ok = await d.step('approve', () => crew.approvals.call({ type: 'request', tool: 'publish', args: msg.topic }))

      s = { ...s, stage: ok ? 'published' : 'held' }
      yield s
    }
  }
