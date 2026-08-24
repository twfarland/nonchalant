// Three agents and a budget, wired the way the four common patterns describe —
// and rendered by the same bindings as every other page in this gallery. The
// pipeline's stage is a field in its state, so the diagram below is not a
// diagram: it is a view of the process.

import { cell, define, derive, registry, spawn } from '@nonchalant/core'
import type { Process, VNode } from '@nonchalant/core'
import { durable, memoryStore } from '@nonchalant/durable'
import { mount } from '@nonchalant/dom'
import { button, div, h2, input, li, span, ul } from '@nonchalant/dom/tags'
import { stubModel } from '../agent/llm.ts'
import { approvals, search } from '../agent/tools.ts'
import {
  budget, researcher, supervisor, writer,
  type BudgetMsg, type BudgetState, type Crew, type Pipeline, type PipelineMsg, type Shared,
  type Stage, type WorkerState,
} from './agents.ts'

type Boss = Process<Pipeline | undefined, PipelineMsg>

// ---------- the deployment ----------

const tools = registry({ search: define(search), approvals: define(approvals), budget: define(budget(600)) })
const shared: Shared = {
  model: stubModel({ latency: 220 }),
  search: tools.lookup('search'),
  budget: tools.lookup('budget'),
}

const key = (args: { id: string }): string => args.id
const crew: Crew = {
  researcher: spawn(durable(researcher, { store: memoryStore(), key }), { ...shared, id: 'researcher' }),
  writer: spawn(durable(writer, { store: memoryStore(), key }), { ...shared, id: 'writer' }),
  approvals: tools.lookup('approvals'),
}

// the supervisor is looked up rather than held, so "kill it" is an eviction
const bossStore = memoryStore()
const desk = registry({
  boss: define<Pipeline, PipelineMsg, { id: string }>((self, args) =>
    durable(supervisor, { store: bossStore, key })(self, { ...crew, ...args })),
})

const generation = cell(0)
const boss = derive<Boss>(() => {
  void generation()
  return desk.lookup('boss', { id: 'boss' }) as Boss
})
const pipeline = derive<Pipeline | undefined>(() => boss()())

const STAGES: Stage[] = ['researching', 'writing', 'approving', 'published']

// ---------- components ----------

function Brief(): VNode {
  const topic = cell('what is a worker?')
  const send = (): void => {
    if (topic().trim() !== '') boss().send({ type: 'brief', topic: topic() })
  }

  return div({ class: 'row' },
    input({
      type: 'text', size: 30, value: topic,
      oninput: (e: Event) => topic.send((e.target as HTMLInputElement).value),
      onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') send() },
    }),
    button({ onclick: send }, 'brief the team'),
    button({
      onclick: () => {
        desk.evict('boss', { id: 'boss' })
        generation.send(generation() + 1)
      },
    }, 'kill the supervisor'))
}

function Graph(): VNode {
  const at = (stage: Stage) => (): string => {
    const now = pipeline()?.stage
    if (now === stage) return 'node here'
    return STAGES.indexOf(stage) < STAGES.indexOf(now ?? 'researching') ? 'node done' : 'node'
  }

  return div({ class: 'graph' },
    ...STAGES.flatMap((stage, i) => [
      ...(i === 0 ? [] : [span({ class: 'arrow' }, '→')]),
      span({ class: at(stage) }, stage),
    ]),
    span({ class: 'muted' }, () => (pipeline()?.stage === 'broke' ? ' — out of budget' : '')),
    span({ class: 'muted' }, () => (pipeline()?.stage === 'held' ? ' — held back' : '')))
}

function Work(): VNode {
  return ul({ class: 'list' },
    li({}, span({ class: 'tag' }, 'topic'), () => pipeline()?.topic ?? '—'),
    li({}, span({ class: 'tag' }, 'notes'), () => pipeline()?.notes ?? '—'),
    li({}, span({ class: 'tag' }, 'draft'), () => pipeline()?.draft ?? '—'))
}

function Team(worker: Process<WorkerState | undefined, never>, name: string): VNode {
  return span({ class: 'muted' }, `${name}: `, () => String(worker()?.runs ?? 0), ' runs  ')
}

function Meter(meter: Process<BudgetState | undefined, BudgetMsg>): VNode {
  return div({ class: 'row' },
    span({ class: 'muted' }, 'budget: '),
    span({ class: 'value' }, () => `${meter()?.spent ?? 0} / ${meter()?.limit ?? 0}`),
    button({ onclick: () => meter.send({ type: 'reset', limit: 600 }) }, 'refill'))
}

// only while a person is actually being asked — a row that is not needed
// should not be in the document at all
function Gate(): () => VNode | null {
  const queue = crew.approvals
  return () => {
    const asking = queue()?.pending[0]
    if (asking === undefined) return null
    return div({ class: 'row gate' },
      span({}, `publish "${asking.args}"?`),
      button({ onclick: () => queue.send({ type: 'decide', ok: true }) }, 'publish'),
      button({ onclick: () => queue.send({ type: 'decide', ok: false }) }, 'hold'))
  }
}

// ---------- the app ----------

function App(): VNode {
  return div({ class: 'card' },
    Brief(),
    Graph(),
    Work(),
    Gate(),
    h2({}, 'The team'),
    div({ class: 'row' }, Team(crew.researcher, 'researcher'), Team(crew.writer, 'writer')),
    Meter(shared.budget))
}

mount(document.getElementById('app')!, App())
