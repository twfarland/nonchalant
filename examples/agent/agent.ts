// An agent, written as a process — which is to say, written the same way the
// counter three directories over is written. The loop is the agent loop: think,
// call a tool, look at what came back, answer. Every state change is a yield,
// so a view binds to it and a test reads it as a transcript.
//
// It is wrapped in `durable()` at the edge (see main.ts), which is why the
// model calls and tool calls go through `d.step`: those are the effects that
// must not happen twice when the process is killed and comes back.

import type { Process } from '@nonchalant/core'
import type { DurableProc } from '@nonchalant/durable'
import type { Model, ToolSpec } from './llm.ts'
import type { ApprovalMsg, ApprovalState, CalcMsg, SearchMsg, ToolState } from './tools.ts'

export type Step =
  | { kind: 'question'; text: string }
  | { kind: 'tool'; name: string; args: string; result: string | null }
  | { kind: 'answer'; text: string }

export type AgentState = {
  status: 'idle' | 'thinking' | 'calling' | 'waiting' | 'answering' | 'done' | 'failed'
  steps: Step[]
  /** The streaming answer as chunks: appending to an array is one splice op, re-sending a growing string is not. */
  answer: string[]
  error: string | null
}

export type AgentMsg = { type: 'ask'; question: string }

export interface Tools {
  search: Process<ToolState | undefined, SearchMsg>
  calc: Process<ToolState | undefined, CalcMsg>
  approvals: Process<ApprovalState | undefined, ApprovalMsg>
}

export interface AgentArgs {
  /** The durable identity of this conversation. */
  id: string
  model: Model
  tools: Tools
}

export const SPECS: ToolSpec[] = [
  { name: 'search', describe: 'look something up' },
  { name: 'calc', describe: 'do arithmetic' },
  { name: 'refund', describe: 'spend money — needs a human' },
]

const MAX_TURNS = 4

export const initialAgent: AgentState = { status: 'idle', steps: [], answer: [], error: null }

const answered = (steps: Step[], result: string): Step[] =>
  steps.map((step, i) => (i === steps.length - 1 && step.kind === 'tool' ? { ...step, result } : step))

async function callTool(tools: Tools, tool: string, args: string): Promise<string> {
  if (tool === 'search') return tools.search.ask({ type: 'search', q: args })
  if (tool === 'calc') return tools.calc.ask({ type: 'calc', expr: args })
  // the one that needs a person: the ask parks until somebody decides
  const ok = await tools.approvals.ask({ type: 'request', tool, args })
  return ok ? `refund of ${args} approved` : `refund of ${args} refused`
}

export const agent: DurableProc<AgentState, AgentMsg, AgentArgs> = async function* (self, { model, tools }, d) {
  let s: AgentState = d.restored ?? initialAgent
  yield s

  for await (const msg of self) {
    s = { status: 'thinking', steps: [...s.steps, { kind: 'question', text: msg.question }], answer: [], error: null }
    yield s

    const transcript: string[] = [msg.question]
    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        // journaled: after a restart this returns what the model said the first
        // time, and the model is not asked again
        const plan = await d.step(`plan-${turn}`, () => model.plan(transcript, SPECS, { signal: self.signal }))

        if ('answer' in plan) {
          s = { ...s, status: 'answering' }
          yield s
          for await (const word of model.say(plan.answer, { signal: self.signal })) {
            s = { ...s, answer: [...s.answer, word] } // one op per chunk on any wire
            yield s
          }
          s = { ...s, status: 'done', steps: [...s.steps, { kind: 'answer', text: plan.answer }] }
          yield s
          break
        }

        s = {
          ...s,
          status: plan.tool === 'refund' ? 'waiting' : 'calling',
          steps: [...s.steps, { kind: 'tool', name: plan.tool, args: plan.args, result: null }],
        }
        yield s

        const result = await d.step(`tool-${turn}`, () => callTool(tools, plan.tool, plan.args))
        transcript.push(`${plan.tool}(${plan.args}) → ${result}`)
        s = { ...s, status: 'thinking', steps: answered(s.steps, result) }
        yield s
      }
    } catch (e) {
      // a cancelled run is a disposed process, so this is a real failure
      s = { ...s, status: 'failed', error: e instanceof Error ? e.message : String(e) }
      yield s
    }
  }
}
