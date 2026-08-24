// The agent tests without a DOM, without a network, and without a mock
// framework: the model is an argument, the tools are processes, and the run is
// a sequence of yields. This is the same way the todos store is tested.

import { describe, it, expect } from 'vitest'
import { spawn } from '@nonchalant/core'
import type { Process } from '@nonchalant/core'
import { durable, memoryStore } from '@nonchalant/durable'
import type { Store } from '@nonchalant/durable'
import { agent, type AgentMsg, type AgentState, type Tools } from './agent.ts'
import { stubModel, type Model, type Plan, type ToolSpec } from './llm.ts'
import { approvals, calc, evaluate, search } from './tools.ts'

const waitFor = async (ready: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 2))
  if (!ready()) throw new Error(`never reached: ${what}`)
}

const tools = (): Tools & { dispose(): void } => {
  const s = spawn(search, undefined)
  const c = spawn(calc, undefined)
  const a = spawn(approvals, undefined)
  return {
    search: s,
    calc: c,
    approvals: a,
    dispose: () => {
      s[Symbol.dispose]()
      c[Symbol.dispose]()
      a[Symbol.dispose]()
    },
  }
}

/** The stub model, plus a count of how often it was actually consulted. */
const counted = (): Model & { plans: number } => {
  const inner = stubModel({ latency: 4 })
  const model = {
    plans: 0,
    plan: (t: readonly string[], specs: readonly ToolSpec[], o: { signal: AbortSignal }): Promise<Plan> => {
      model.plans++
      return inner.plan(t, specs, o)
    },
    say: inner.say,
    compose: inner.compose,
  }
  return model
}

const run = (store: Store, id: string, model: Model, kit: Tools): Process<AgentState | undefined, AgentMsg> =>
  spawn(durable(agent, { store, key: (a: { id: string }) => a.id }), { id, model, tools: kit })

describe('the agent loop', () => {
  it('reaches for a tool, then answers from what came back', async () => {
    const kit = tools()
    const p = run(memoryStore(), 'a1', stubModel({ latency: 4 }), kit)
    p.cast({ type: 'ask', question: 'what is a process?' })

    await waitFor(() => p()?.status === 'done', 'an answer')
    const state = p()!
    expect(state.steps.map((s) => s.kind)).toStrictEqual(['question', 'tool', 'answer'])
    expect(state.steps[1]).toMatchObject({ name: 'search', result: expect.stringContaining('mailbox') })
    expect(state.answer.join(' ')).toContain('mailbox') // the stream, chunk by chunk
    expect(kit.search()?.calls).toBe(1) // the tool process saw exactly one call

    p[Symbol.dispose]()
    kit.dispose()
  })

  it('does arithmetic through the calculator process', async () => {
    const kit = tools()
    const p = run(memoryStore(), 'a2', stubModel({ latency: 4 }), kit)
    p.cast({ type: 'ask', question: '2 + 3 * 4' })

    await waitFor(() => p()?.status === 'done', 'an answer')
    expect(p()!.steps[1]).toMatchObject({ name: 'calc', result: 'calc says: 2 + 3 * 4 = 14' })

    p[Symbol.dispose]()
    kit.dispose()
  })

  it('parks on the approval tool until a person decides', async () => {
    const kit = tools()
    const p = run(memoryStore(), 'a3', stubModel({ latency: 4 }), kit)
    p.cast({ type: 'ask', question: 'please refund 20' })

    await waitFor(() => p()?.status === 'waiting', 'the approval request')
    expect(kit.approvals()?.pending).toStrictEqual([{ tool: 'refund', args: '20' }])

    // nothing moves while the person thinks: the call is parked inside the tool
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(p()?.status).toBe('waiting')

    kit.approvals.cast({ type: 'decide', ok: false })
    await waitFor(() => p()?.status === 'done', 'the run to finish')
    expect(p()!.steps[1]).toMatchObject({ name: 'refund', result: 'refund of 20 refused' })
    expect(kit.approvals()?.pending).toStrictEqual([])

    p[Symbol.dispose]()
    kit.dispose()
  })

  it('picks the one tool the question needs, not every tool it has', async () => {
    const kit = tools()
    const p = run(memoryStore(), 'a6', stubModel({ latency: 4 }), kit)
    p.cast({ type: 'ask', question: 'please refund 20' })

    await waitFor(() => p()?.status === 'waiting', 'the approval request')
    kit.approvals.cast({ type: 'decide', ok: true })
    await waitFor(() => p()?.status === 'done', 'the answer')

    expect(p()!.steps.map((s) => s.kind)).toStrictEqual(['question', 'tool', 'answer'])
    expect(kit.calc()?.calls).toBe(0) // a refund is not arithmetic
    expect(kit.search()?.calls).toBe(0) // and it is not a lookup either
    expect(p()!.answer.join(' ')).toBe('refund of 20 approved')

    p[Symbol.dispose]()
    kit.dispose()
  })

  it('killed mid-run, it comes back and does not ask the model again', async () => {
    const store = memoryStore()
    const kit = tools()
    const model = counted()

    const first = run(store, 'a4', model, kit)
    first.cast({ type: 'ask', question: 'what is a patch?' })
    await waitFor(() => first()?.status === 'calling', 'the tool call')
    first[Symbol.dispose]() // the machine goes away mid-question
    await new Promise((resolve) => setTimeout(resolve, 20))
    const plansBefore = model.plans
    expect(plansBefore).toBe(1)

    const second = run(store, 'a4', model, kit)
    await waitFor(() => second()?.status === 'done', 'the resumed answer')
    const state = second()!
    expect(state.steps.map((s) => s.kind)).toStrictEqual(['question', 'tool', 'answer'])
    expect(state.answer.join(' ')).toContain('patches')
    expect(model.plans).toBe(plansBefore + 1) // turn 0 came from the journal; only turn 1 was new
    expect(kit.search()?.calls).toBe(2) // the tool call was in flight, so it is at-least-once

    second[Symbol.dispose]()
    kit.dispose()
  })

  it('killed while answering, it resumes without calling anything again', async () => {
    const store = memoryStore()
    const kit = tools()
    const model = counted()

    const first = run(store, 'a5', model, kit)
    first.cast({ type: 'ask', question: 'what is a patch?' })
    await waitFor(() => first()?.status === 'answering', 'the answer to start')
    first[Symbol.dispose]() // every effect of this message has landed by now
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(model.plans).toBe(2)

    const second = run(store, 'a5', model, kit)
    await waitFor(() => second()?.status === 'done', 'the resumed answer')
    expect(second()!.answer.join(' ')).toContain('patches') // re-streamed from the journaled plan
    expect(model.plans).toBe(2) // nothing was asked again
    expect(kit.search()?.calls).toBe(1)

    second[Symbol.dispose]()
    kit.dispose()
  })
})

describe('the calculator', () => {
  it('reads precedence, parentheses, and negation', () => {
    expect(evaluate('2 + 3 * 4')).toBe(14)
    expect(evaluate('(2 + 3) * 4')).toBe(20)
    expect(evaluate('-3 + 10 / 2')).toBe(2)
    expect(() => evaluate('2 +')).toThrow()
  })
})
