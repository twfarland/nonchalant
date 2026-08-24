// The page. Nothing here is agent-specific plumbing: the transcript is a keyed
// list bound to a process, the streaming answer is a binding on an array, the
// approval buttons are casts. It is the todo list, with a different process
// underneath.
//
// The agent is durable, so "kill the machine" is a real test rather than a
// gesture: evicting the entry disposes the process, the next lookup activates a
// new one, and it rehydrates from the journal — mid-question if that is where
// it was.

import { cell, define, derive, registry } from '@nonchalant/core'
import type { Process, VNode } from '@nonchalant/core'
import { durable, memoryStore } from '@nonchalant/durable'
import { mount } from '@nonchalant/dom'
import { button, div, h2, input, li, span, ul } from '@nonchalant/dom/tags'
import { agent, type AgentArgs, type AgentMsg, type AgentState, type Tools } from './agent.ts'
import { stubModel } from './llm.ts'
import { approvals, calc, search, type ApprovalMsg, type ApprovalState, type ToolState } from './tools.ts'

type Agent = Process<AgentState | undefined, AgentMsg>

// ---------- the parts ----------

// tools are looked up by name, which is the only reason they could just as
// easily live on a server
const kit = registry({ search: define(search), calc: define(calc), approvals: define(approvals) })
const tools: Tools = {
  search: kit.lookup('search'),
  calc: kit.lookup('calc'),
  approvals: kit.lookup('approvals'),
}

// in a browser the journal is a Map; on a server it is Postgres, and the
// process above it does not change
const store = memoryStore()
const run = durable(agent, { store, key: (args: AgentArgs) => args.id })

const brain = registry({
  agent: define<AgentState, AgentMsg, { id: string }>((self, args) =>
    run(self, { ...args, model: stubModel(), tools })),
})

const generation = cell(0)
const machine = derive<Agent>(() => {
  void generation() // a kill bumps this, and the lookup activates a fresh one
  return brain.lookup('agent', { id: 'demo' }) as Agent
})
const state = derive<AgentState | undefined>(() => machine()())

const busy = (): boolean => {
  const status = state()?.status
  return status !== undefined && status !== 'idle' && status !== 'done' && status !== 'failed'
}

// ---------- components ----------

function Ask(): VNode {
  const draft = cell('')
  const send = (): void => {
    if (draft().trim() === '') return
    machine().send({ type: 'ask', question: draft() })
    draft.send('')
  }

  return div({ class: 'row' },
    input({
      type: 'text',
      value: draft,
      placeholder: 'ask about a process, or "2 + 3 * 4", or "refund 20"',
      oninput: (e: Event) => draft.send((e.target as HTMLInputElement).value),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') send()
      },
    }),
    button({ onclick: send, disabled: busy }, 'ask'),
    span({ class: 'muted' }, () => state()?.status ?? 'starting…'))
}

// The transcript is the whole conversation, the streaming answer included: while
// it arrives it is the last line, and the finished step lands in the same slot.
function Transcript(): VNode {
  type Turn = { key: string; kind: string; who: string; said: string; pending: boolean }

  const turns = (): Turn[] => {
    const now = state()
    const rows: Turn[] = (now?.steps ?? []).map((step, i) => ({
      key: `t${i}`,
      kind: step.kind,
      who: step.kind === 'tool' ? step.name : step.kind === 'question' ? 'you' : 'agent',
      said: step.kind === 'tool' ? `${step.args} → ${step.result ?? 'working…'}` : step.text,
      pending: step.kind === 'tool' && step.result === null,
    }))
    if (now?.status === 'answering')
      rows.push({ key: `t${rows.length}`, kind: 'answer', who: 'agent', said: `${now.answer.join(' ')}▌`, pending: false })
    return rows
  }

  return ul({ class: 'turns' }, () =>
    turns().map((turn) =>
      li({ key: turn.key, class: `turn ${turn.kind}` },
        span({ class: 'who' }, turn.who),
        span({ class: `said${turn.kind === 'tool' ? ' mono' : ''}${turn.pending ? ' muted' : ''}` }, turn.said))))
}

// the panel exists only while somebody is being asked. `hidden` is not enough:
// any class that sets `display` beats the browser's [hidden] rule
function Approvals(queue: Process<ApprovalState | undefined, ApprovalMsg>): () => VNode | null {
  const decide = (ok: boolean) => (): void => queue.send({ type: 'decide', ok })

  return () => {
    const asking = queue()?.pending[0]
    if (asking === undefined) return null
    return div({ class: 'gate' },
      div({}, 'The agent is waiting on you: ', span({ class: 'tag' }, asking.tool), asking.args),
      div({ class: 'row' },
        button({ onclick: decide(true) }, 'approve'),
        button({ onclick: decide(false) }, 'refuse')))
  }
}

function ToolUse(name: string, tool: Process<ToolState | undefined, never>): VNode {
  return span({ class: 'muted' }, `${name}: `, () => String(tool()?.calls ?? 0), ' calls  ')
}

function Machine(): VNode {
  return div({ class: 'row' },
    button({ onclick: () => { brain.evict('agent', { id: 'demo' }); generation.send(generation() + 1) } },
      'kill the machine'),
    span({ class: 'muted' }, 'and watch it come back where it was'))
}

// ---------- the app ----------

function App(): VNode {
  return div({ class: 'card' },
    Ask(),
    Transcript(),
    Approvals(tools.approvals),
    div({ class: 'row' }, ToolUse('search', tools.search), ToolUse('calc', tools.calc)),
    h2({}, 'The machine'),
    Machine())
}

mount(document.getElementById('app')!, App())
