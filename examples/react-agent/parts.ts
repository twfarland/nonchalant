// The process tree, exactly as examples/agent builds it: the agent, its tools,
// and the approval gate, imported from that example unchanged. Nothing here
// knows React is on the other side. The model is an argument, so the page runs
// the stub and the test runs a script.

import { define, registry } from '@nonchalant/core'
import type { Definition, Process, RegistryHandle } from '@nonchalant/core'
import { durable, memoryStore } from '@nonchalant/durable'
import type { Store } from '@nonchalant/durable'
import { agent, type AgentArgs, type AgentMsg, type AgentState, type Tools } from '../agent/agent.ts'
import type { Model } from '../agent/llm.ts'
import { approvals, calc, search } from '../agent/tools.ts'

export type Agent = Process<AgentState | undefined, AgentMsg>

export interface Parts {
  /** Get-or-spawn the conversation; after `kill` the next call rehydrates it from the journal. */
  agent(): Agent
  tools: Tools
  /** Evict the agent: its process is disposed, its journal is not. */
  kill(): void
  /** Everything, tools included. */
  dispose(): void
}

type Brain = RegistryHandle<{ agent: Definition<AgentState, AgentMsg, { id: string }> }>

export function parts(model: Model, store: Store = memoryStore()): Parts {
  const kit = registry({ search: define(search), calc: define(calc), approvals: define(approvals) })
  const tools: Tools = {
    search: kit.lookup('search'),
    calc: kit.lookup('calc'),
    approvals: kit.lookup('approvals'),
  }

  const run = durable(agent, { store, key: (args: AgentArgs) => args.id })
  const brain: Brain = registry({
    agent: define<AgentState, AgentMsg, { id: string }>((self, args) => run(self, { ...args, model, tools })),
  })

  return {
    agent: () => brain.lookup('agent', { id: 'demo' }),
    tools,
    kill: () => brain.evict('agent', { id: 'demo' }),
    dispose: () => {
      brain.evict('agent')
      kit.evict('search')
      kit.evict('calc')
      kit.evict('approvals')
    },
  }
}
