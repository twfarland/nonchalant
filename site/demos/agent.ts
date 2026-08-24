// An agent loop, on the same page as the counter, built from the same three
// things: a `let`, a mailbox, and a yield. The model is stubbed so this is
// deterministic — ask about a process, a patch, a worker, or durable; give it
// arithmetic; or say "refund 20" and it will stop and ask you.
//
// It is wrapped in durable(), so killing it mid-question is not a reset: the
// journal has the model's last answer, and the new process carries on.

import { cell, define, derive, registry } from '@nonchalant/core'
import type { Process, VNode } from '@nonchalant/core'
import { durable, memoryStore } from '@nonchalant/durable'
import { mount } from '@nonchalant/dom'
import { button, div, input, li, span, ul } from '@nonchalant/dom/tags'
import { agent, type AgentArgs, type AgentMsg, type AgentState, type Tools } from '../../examples/agent/agent.ts'
import { stubModel } from '../../examples/agent/llm.ts'
import { approvals, calc, search } from '../../examples/agent/tools.ts'

type Agent = Process<AgentState | undefined, AgentMsg>

export function run(host: Element): Disposable {
  const kit = registry({ search: define(search), calc: define(calc), approvals: define(approvals) })
  const tools: Tools = { search: kit.lookup('search'), calc: kit.lookup('calc'), approvals: kit.lookup('approvals') }

  const loop = durable(agent, { store: memoryStore(), key: (args: AgentArgs) => args.id })
  const brain = registry({
    agent: define<AgentState, AgentMsg, { id: string }>((self, args) =>
      loop(self, { ...args, model: stubModel({ latency: 220 }), tools })),
  })

  const generation = cell(0)
  const machine = derive<Agent>(() => {
    void generation() // a kill bumps this; the next lookup activates a fresh process
    return brain.lookup('agent', { id: 'demo' }) as Agent
  })
  const state = derive<AgentState | undefined>(() => machine()())
  const queue = tools.approvals

  const draft = cell('what is a patch?')
  const ask = (): void => {
    if (draft().trim() !== '') machine().send({ type: 'ask', question: draft() })
  }
  const kill = (): void => {
    brain.evict('agent', { id: 'demo' })
    generation.send(generation() + 1)
  }
  const running = (): boolean => {
    const status = state()?.status
    return status !== undefined && status !== 'idle' && status !== 'done' && status !== 'failed'
  }

  const step = (s: AgentState['steps'][number]): string =>
    s.kind === 'tool' ? `${s.name}(${s.args}) → ${s.result ?? '…'}` : s.text

  return mount(host, div({ class: 'stack' },
    div({ class: 'row' },
      input({
        type: 'text', value: draft, size: 34,
        oninput: (e: Event) => draft.send((e.target as HTMLInputElement).value),
        onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') ask() },
      }),
      button({ onclick: ask, disabled: running }, 'ask'),
      button({ onclick: kill }, 'kill it'),
      span({ class: 'muted' }, () => state()?.status ?? '…')),

    ul({ class: 'list' }, () =>
      (state()?.steps ?? []).map((s, i) =>
        li({ key: i }, span({ class: 'demo-title' }, s.kind === 'tool' ? s.name : s.kind), step(s)))),

    div({ class: 'readout' }, () => {
      const chunks = state()?.answer ?? []
      return chunks.length === 0 ? 'no answer yet' : chunks.join(' ')
    }),

    div({ class: 'row', hidden: () => (queue()?.pending.length ?? 0) === 0 },
      span({}, () => `approve ${queue()?.pending[0]?.tool ?? ''} ${queue()?.pending[0]?.args ?? ''}?`),
      button({ onclick: () => queue.send({ type: 'decide', ok: true }) }, 'yes'),
      button({ onclick: () => queue.send({ type: 'decide', ok: false }) }, 'no'))))
}
