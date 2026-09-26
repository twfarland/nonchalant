// Core's instrument events made plain data: every live value summarized to
// JSON, so a recorded event can be cloned, sent, and shown.

import type { Json, Patch, ProcessEvent } from '@nonchalant/core'
import type { Draft } from './recording.ts'

const tag = (v: object): string => {
  const ctor = (v as { constructor?: { name?: unknown } }).constructor
  return typeof ctor?.name === 'string' && ctor.name !== '' ? ctor.name : 'Object'
}

/**
 * A structuredClone- and JSON-safe stand-in for any value. Plain JSON comes
 * back by reference (so recorded states share structure with the app's);
 * everything else becomes a bracketed label.
 */
export function summarize(value: unknown, depth = 0, seen: Set<object> = new Set()): Json {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'undefined':
      return '[undefined]'
    case 'bigint':
      return `${value}n`
    case 'symbol':
      return `[${String(value)}]`
    case 'function':
      return `[function ${value.name || 'anonymous'}]`
    case 'object':
      break
  }
  if (value === null) return null
  const obj = value as object
  if (value instanceof Error) return `[${value.name}: ${value.message}]`
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '[Invalid Date]' : value.toISOString()
  if (seen.has(obj)) return '[cycle]'
  if (depth >= 12) return '[…]'
  seen.add(obj)
  try {
    if (Array.isArray(obj)) {
      let same = true
      const out = obj.map((v: unknown) => {
        const s = summarize(v, depth + 1, seen)
        if (s !== v) same = false
        return s
      })
      return same ? (obj as Json[]) : out
    }
    const proto = Object.getPrototypeOf(obj)
    if (proto !== Object.prototype && proto !== null) return `[${tag(obj)}]`
    let same = true
    const out: { [k: string]: Json } = {}
    for (const [k, v] of Object.entries(obj)) {
      const s = summarize(v, depth + 1, seen)
      if (s !== v) same = false
      out[k] = s
    }
    return same ? (obj as { [k: string]: Json }) : out
  } finally {
    seen.delete(obj)
  }
}

/** A patch with the values it writes summarized; paths and deletes pass through. */
export const summarizeOps = (ops: Patch): Patch =>
  ops.map((op): Patch[number] => {
    switch (op[0]) {
      case 'set': return ['set', op[1], summarize(op[2])]
      case 'del': return op
      case 'splice': return ['splice', op[1], op[2], op[3], op[4].map((v) => summarize(v))]
    }
  })

/** A raw core event as plain data. Runs inside the sink, so live values are captured as they were. */
export function draft(e: ProcessEvent): Draft {
  switch (e.type) {
    case 'spawn':
      return {
        type: 'spawn', id: e.id, parent: e.parent, name: e.name, key: e.key ?? null,
        args: summarize(e.args), state: e.state === undefined ? null : summarize(e.state),
      }
    case 'cast': return { type: 'cast', id: e.id, msg: summarize(e.msg) }
    case 'call': return { type: 'call', id: e.id, msg: summarize(e.msg), call: e.call }
    case 'reply': return { type: 'reply', id: e.id, call: e.call, value: summarize(e.value) }
    case 'yield': return { type: 'yield', id: e.id, ops: summarizeOps(e.ops) }
    case 'status': return { type: 'status', id: e.id, pending: e.pending, stale: e.stale, errored: e.errored }
    case 'crash': return { type: 'crash', id: e.id, error: String(summarize(e.error)) }
    case 'restart': return { type: 'restart', id: e.id, attempt: e.attempt }
    case 'exit': return { type: 'exit', id: e.id, reason: e.reason }
  }
}
