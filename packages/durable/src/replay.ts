// The rules a durable activation replays by, as plain functions: how a loaded
// snapshot is brought up to the current version, how a recorded step answers
// a re-run, what a crash inside a message leads to, and what of a call gets
// written down. Nothing here touches
// a store or a process.

import type { Json } from '@nonchalant/core'
import type { Loaded, StepRecord } from './store.ts'

/** The loaded snapshot, migrated to `version`; undefined when the key never committed. */
export function restore<T>(loaded: Loaded, version: number, migrate: ((old: Json, from: number) => T) | undefined, key: string): T | undefined {
  const { snapshot } = loaded
  if (snapshot === undefined || loaded.version === version) return snapshot as T | undefined
  if (migrate === undefined)
    throw new Error(`nonchalant/durable: no migrate for '${key}' from version ${loaded.version} to ${version}`)
  return migrate(snapshot, loaded.version)
}

/**
 * The step already recorded at `index` of message `seq`, if any. The order of
 * steps within one message must not depend on anything unrecorded, so a
 * record under another name is a drift, and throws.
 */
export function recall(recorded: readonly StepRecord[], index: number, name: string, key: string, seq: number): StepRecord | undefined {
  const done = recorded.find((s) => s.index === index)
  if (done !== undefined && done.name !== name)
    throw new Error(`nonchalant/durable: step order drifted in '${key}' #${seq}: step ${index} was '${done.name}', now '${name}'`)
  return done
}

/**
 * The failed attempt a crash inside a message records, or undefined when it
 * is the last one allowed and the message is dead-lettered instead. Attempts
 * are recorded as steps at negative indices (-1, -2, …), so they survive the
 * crash they record.
 */
export function nextAttempt(recorded: readonly StepRecord[], maxAttempts: number): number | undefined {
  const attempt = recorded.filter((s) => s.index < 0).length + 1
  return attempt < maxAttempts ? attempt : undefined
}

/** The request without its reply: what gets written down. */
export const plainly = (msg: object): Json => {
  const copy: Record<string, unknown> = { ...(msg as Record<string, unknown>) }
  delete copy['reply']
  return copy as Json
}
