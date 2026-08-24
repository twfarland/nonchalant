// @nonchalant/durable — the same process, written down. A wrapper over a Proc
// plus the port it needs from storage; no scheduler, no cluster, no new noun in
// the application code. This repo ships the in-memory adapter only.

export { durable } from './durable.ts'
export type { Durable, DurableProc, DurableOpts, DurableCall } from './durable.ts'
export { memoryStore } from './memory-store.ts'
export type { MemoryStore } from './memory-store.ts'
export type { Store, Loaded, Logged, StepRecord } from './store.ts'
