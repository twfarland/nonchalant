// Tools are processes, and a tool call is `call()`. That buys three things
// without any tool-calling machinery: a tool has state you can watch (these
// keep a usage count the page renders), a tool can live somewhere else (a
// registry lookup is a registry lookup), and a tool can decline to answer for
// as long as it likes — which is all "human in the loop" turns out to be.

import type { Call, Cast, Proc } from '@nonchalant/core'
import { delay } from './llm.ts'

// ---------- a plain tool ----------

export type ToolState = { calls: number; last: string }
export type SearchMsg = Call<{ type: 'search'; q: string }, string>

const CORPUS: [topic: string, fact: string][] = [
  ['process', 'a process is an async generator with a mailbox'],
  ['patch', 'yields are diffed structurally and sent as patches'],
  ['worker', 'the wire runs over a worker port as happily as a socket'],
  ['durable', 'durability is a wrapper: journal the message, journal the effects'],
]

export const search: Proc<ToolState, SearchMsg, void> = async function* (self) {
  let calls = 0
  let last = '—'
  yield { calls, last }
  for await (const msg of self) {
    await delay(180, self.signal)
    const hit = CORPUS.find(([topic]) => msg.q.toLowerCase().includes(topic))
    calls++
    last = msg.q
    msg.reply(hit === undefined ? `nothing found for "${msg.q}"` : `search says: ${hit[1]}`)
    yield { calls, last }
  }
}

// ---------- a pure tool ----------

export type CalcMsg = Call<{ type: 'calc'; expr: string }, string>

/** Deliberately tiny: numbers and + - * / ( ), left to right with precedence, no identifiers. */
export function evaluate(expr: string): number {
  const tokens = expr.match(/\d+(?:\.\d+)?|[+*/()-]/g) ?? []
  let at = 0
  const peek = (): string | undefined => tokens[at]
  const sum = (): number => {
    let value = product()
    for (let op = peek(); op === '+' || op === '-'; op = peek()) {
      at++
      value = op === '+' ? value + product() : value - product()
    }
    return value
  }
  const product = (): number => {
    let value = atom()
    for (let op = peek(); op === '*' || op === '/'; op = peek()) {
      at++
      value = op === '*' ? value * atom() : value / atom()
    }
    return value
  }
  const atom = (): number => {
    const token = tokens[at++]
    if (token === '(') {
      const value = sum()
      at++ // ')'
      return value
    }
    if (token === '-') return -atom()
    const n = Number(token)
    if (Number.isNaN(n)) throw new Error(`cannot read "${expr}"`)
    return n
  }
  const result = sum()
  if (at < tokens.length) throw new Error(`cannot read "${expr}"`)
  return result
}

export const calc: Proc<ToolState, CalcMsg, void> = async function* (self) {
  let calls = 0
  let last = '—'
  yield { calls, last }
  for await (const msg of self) {
    calls++
    last = msg.expr
    try {
      msg.reply(`calc says: ${msg.expr} = ${evaluate(msg.expr)}`)
    } catch (e) {
      msg.reply(`calc says: ${String(e)}`)
    }
    yield { calls, last }
  }
}

// ---------- a tool that waits for a person ----------

export type Pending = { tool: string; args: string }
export type ApprovalState = { pending: Pending[]; decided: number }
export type ApprovalMsg =
  | Call<{ type: 'request'; tool: string; args: string }, boolean>
  | Cast<{ type: 'decide'; ok: boolean }>

/**
 * The reply is simply not sent until someone decides. The caller is an ordinary
 * `await`; the queue is ordinary state a view can render. No callback registry,
 * no interrupt protocol — the call is parked in a closure inside the process.
 */
export const approvals: Proc<ApprovalState, ApprovalMsg, void> = async function* (self) {
  let waiting: (Pending & { reply: (ok: boolean) => void })[] = []
  let decided = 0
  const state = (): ApprovalState => ({
    pending: waiting.map(({ tool, args }) => ({ tool, args })), // the replies stay out of state
    decided,
  })

  yield state()
  for await (const msg of self) {
    switch (msg.type) {
      case 'request':
        waiting = [...waiting, { tool: msg.tool, args: msg.args, reply: msg.reply }]
        break
      case 'decide': {
        const [head, ...rest] = waiting
        if (head === undefined) continue // nothing to decide, no state change
        head.reply(msg.ok)
        waiting = rest
        decided++
        break
      }
    }
    yield state()
  }
}
