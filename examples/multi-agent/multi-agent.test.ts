// Four wiring patterns and the thing that makes them worth using: killing the
// supervisor in the middle of the pipeline does not make the agents it already
// delegated to do their work a second time.

import { describe, it, expect } from 'vitest'
import { define, registry, spawn } from '@nonchalant/core'
import type { Process } from '@nonchalant/core'
import { durable, memoryStore, type Store } from '@nonchalant/durable'
import { stubModel } from '../agent/llm.ts'
import { approvals, search } from '../agent/tools.ts'
import {
  budget, researcher, supervisor, writer,
  type Crew, type Pipeline, type PipelineMsg, type ResearchMsg, type Shared, type WorkerState, type WriteMsg,
} from './agents.ts'

const waitFor = async (ready: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 500 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 2))
  if (!ready()) throw new Error(`never reached: ${what}`)
}

/** One deployment: shared tools, two delegate agents, and a supervisor over them. */
const crew = (limit = 10_000) => {
  const stores = { researcher: memoryStore(), writer: memoryStore(), boss: memoryStore() }
  const tools = registry({
    search: define(search),
    approvals: define(approvals),
    budget: define(budget(limit)),
  })
  const shared: Shared = {
    model: stubModel({ latency: 4 }),
    search: tools.lookup('search'),
    budget: tools.lookup('budget'),
  }
  const key = (a: { id: string }): string => a.id

  const workers: Crew = {
    researcher: spawn(durable(researcher, { store: stores.researcher, key }), { ...shared, id: 'researcher' }),
    writer: spawn(durable(writer, { store: stores.writer, key }), { ...shared, id: 'writer' }),
    approvals: tools.lookup('approvals'),
  }

  const boss = (store: Store = stores.boss): Process<Pipeline | undefined, PipelineMsg> =>
    spawn(durable(supervisor, { store, key }), { ...workers, id: 'boss' })

  return {
    ...workers,
    shared,
    stores,
    boss,
    dispose: () => {
      workers.researcher[Symbol.dispose]()
      workers.writer[Symbol.dispose]()
    },
  }
}

const approve = (queue: Crew['approvals']) => (): void => queue.cast({ type: 'decide', ok: true })

describe('multi-agent wiring', () => {
  it('delegates, hands the output on, and stops for a person before publishing', async () => {
    const team = crew()
    const boss = team.boss()
    boss.cast({ type: 'brief', topic: 'what is a worker?' })

    await waitFor(() => boss()?.stage === 'approving', 'the approval gate')
    const state = boss()!
    expect(state.notes).toContain('worker port') // the researcher's answer, handed on
    expect(state.draft).toContain('On what is a worker?') // the writer's, built from it
    expect(team.researcher()?.runs).toBe(1)
    expect(team.writer()?.runs).toBe(1)

    approve(team.approvals)()
    await waitFor(() => boss()?.stage === 'published', 'publication')
    boss[Symbol.dispose]()
    team.dispose()
  })

  it('killing the supervisor mid-pipeline does not re-run the agents it delegated to', async () => {
    const team = crew()
    const first = team.boss()
    first.cast({ type: 'brief', topic: 'what is a patch?' })

    await waitFor(() => first()?.stage === 'writing', 'the hand-off to the writer')
    first[Symbol.dispose]() // gone, mid-pipeline, with the brief unacknowledged
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(team.researcher()?.runs).toBe(1)

    const second = team.boss() // same store: the brief is replayed
    await waitFor(() => second()?.stage === 'approving', 'the resumed approval gate')
    expect(team.researcher()?.runs).toBe(1) // the delegated call was answered from its record
    expect(second()?.notes).toContain('patches')

    approve(team.approvals)()
    await waitFor(() => second()?.stage === 'published', 'publication')
    expect(team.writer()?.runs).toBeLessThanOrEqual(2) // at most one retry of the call in flight
    second[Symbol.dispose]()
    team.dispose()
  })

  it('one budget governs every agent in the system', async () => {
    const team = crew(150) // enough for research (120), not for writing (200)
    const boss = team.boss()
    boss.cast({ type: 'brief', topic: 'what is a process?' })

    await waitFor(() => boss()?.stage === 'broke', 'the budget to bite')
    expect(boss()?.notes).toContain('mailbox') // research happened
    expect(team.writer()?.runs).toBe(1) // the writer ran and was refused
    expect(team.shared.budget()?.refused).toBe(1)
    expect(team.shared.budget()?.spent).toBe(120)

    boss[Symbol.dispose]()
    team.dispose()
  })

  it('briefs queue: the mailbox is the scheduler', async () => {
    const team = crew()
    const boss = team.boss()
    boss.cast({ type: 'brief', topic: 'what is a patch?' })
    boss.cast({ type: 'brief', topic: 'what is durable?' })

    await waitFor(() => boss()?.stage === 'approving', 'the first gate')
    expect(boss()?.topic).toBe('what is a patch?')
    approve(team.approvals)()

    await waitFor(() => boss()?.topic === 'what is durable?' && boss()?.stage === 'approving', 'the second brief')
    expect(team.researcher()?.runs).toBe(2)
    approve(team.approvals)()
    await waitFor(() => boss()?.stage === 'published', 'the second publication')

    boss[Symbol.dispose]()
    team.dispose()
  })
})
