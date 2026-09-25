// The agent console, rendered by React. The processes are examples/agent's,
// untouched; React only draws them. Each component reads the slice it shows
// through useDerive, so a streamed word re-renders the streaming line and
// nothing else, and a tool result re-renders its own row.

import { memo, useState, type ReactNode } from 'react'
import { useDerive, useLookup, useProcessMeta } from '@nonchalant/react'
import type { Process } from '@nonchalant/core'
import type { Step } from '../agent/agent.ts'
import type { ApprovalMsg, ApprovalState, ToolState } from '../agent/tools.ts'
import type { Agent, Parts } from './parts.ts'

const settled = new Set(['idle', 'done', 'failed'])

// ---------- components ----------

function Ask({ agent }: { agent: Agent }): ReactNode {
  const [draft, setDraft] = useState('')
  const status = useDerive(() => agent()?.status, [agent])
  const busy = status !== undefined && !settled.has(status)
  const ask = (): void => {
    if (draft.trim() === '') return
    agent.cast({ type: 'ask', question: draft })
    setDraft('')
  }

  return (
    <div className="row">
      <input
        type="text"
        value={draft}
        placeholder='ask about a process, or "2 + 3 * 4", or "refund 20"'
        onChange={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') ask() }}
      />
      <button onClick={ask} disabled={busy}>ask</button>
      <span className="muted">{status ?? 'starting…'}</span>
    </div>
  )
}

const who = (step: Step): string => (step.kind === 'tool' ? step.name : step.kind === 'question' ? 'you' : 'agent')
const said = (step: Step): string => (step.kind === 'tool' ? `${step.args} → ${step.result ?? 'working…'}` : step.text)

// one row per step; memo plus a path-precise read means a new step renders one row
const Turn = memo(function Turn({ agent, at }: { agent: Agent; at: number }): ReactNode {
  const step = useDerive(() => agent()?.steps[at], [agent, at])
  if (step === undefined) return null
  const pending = step.kind === 'tool' && step.result === null
  return (
    <li className={`turn ${step.kind}`}>
      <span className="who">{who(step)}</span>
      <span className={`said${step.kind === 'tool' ? ' mono' : ''}${pending ? ' muted' : ''}`}>{said(step)}</span>
    </li>
  )
})

// the answer as it arrives: the last line while streaming, replaced by the finished step
function Streaming({ agent }: { agent: Agent }): ReactNode {
  const words = useDerive(() => (agent()?.status === 'answering' ? agent()?.answer.join(' ') : null), [agent])
  if (words == null) return null
  return (
    <li className="turn answer">
      <span className="who">agent</span>
      <span className="said">{words}▌</span>
    </li>
  )
}

function Transcript({ agent }: { agent: Agent }): ReactNode {
  const count = useDerive(() => agent()?.steps.length ?? 0, [agent])
  return (
    <ul className="turns">
      {Array.from({ length: count }, (_, at) => <Turn key={at} agent={agent} at={at} />)}
      <Streaming agent={agent} />
    </ul>
  )
}

// the gate: the agent's tool call is parked inside this process until a button casts
function Approvals({ queue }: { queue: Process<ApprovalState | undefined, ApprovalMsg> }): ReactNode {
  const asking = useDerive(() => queue()?.pending[0], [queue])
  if (asking === undefined) return null
  const decide = (ok: boolean) => (): void => queue.cast({ type: 'decide', ok })
  return (
    <div className="gate">
      <div>The agent is waiting on you: <span className="tag">{asking.tool}</span>{asking.args}</div>
      <div className="row">
        <button onClick={decide(true)}>approve</button>
        <button onClick={decide(false)}>refuse</button>
      </div>
    </div>
  )
}

function ToolUse({ name, tool }: { name: string; tool: Process<ToolState | undefined, never> }): ReactNode {
  const calls = useDerive(() => tool()?.calls ?? 0, [tool])
  const { pending } = useProcessMeta(tool)
  return <span className="muted">{name}: {calls} calls{pending ? ' (working)' : ''}  </span>
}

function Machine({ kill }: { kill: () => void }): ReactNode {
  return (
    <div className="row">
      <button onClick={kill}>kill the machine</button>
      <span className="muted">and watch it come back where it was</span>
    </div>
  )
}

// ---------- the app ----------

export function App({ parts }: { parts: Parts }): ReactNode {
  // after a kill the lookup runs again, and the durable agent rehydrates
  const agent = useLookup(parts.agent)
  return (
    <div className="card">
      <Ask agent={agent} />
      <Transcript agent={agent} />
      <Approvals queue={parts.tools.approvals} />
      <div className="row">
        <ToolUse name="search" tool={parts.tools.search} />
        <ToolUse name="calc" tool={parts.tools.calc} />
      </div>
      <h2>The machine</h2>
      <Machine kill={parts.kill} />
    </div>
  )
}
