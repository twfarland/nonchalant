// @nonchalant/core — public surface. Types are final (draft 3, verified);
// runtime lands per docs/ROADMAP.md. Stubs throw so nothing silently no-ops.

export type {
  Call, Plain, Requests, Res,
  Process, ProcessBase, Self, Proc,
  Definition, Schema, Registry, ProcessOf, ArgsOf,
  VNode, Slot,
} from './types.ts'
export { reconcile, applyPatch } from './reconcile.ts'
export type { Json, Op, Patch } from './reconcile.ts'

import type { Proc, Process, Self } from './types.ts'

const TODO = (m: string) => new Error(`@nonchalant/core: ${m} not implemented yet — see docs/ROADMAP.md`)

/** Run an async generator as a supervised local process. `initial` decides T | undefined vs T. */
export function spawn<T, In, A>(proc: Proc<T, In, A>, args: A): Process<T | undefined, In>
export function spawn<T, In, A>(proc: Proc<T, In, A>, args: A, opts: { initial: T }): Process<T, In>
export function spawn(..._args: unknown[]): never {
  throw TODO('spawn (M3)')
}

/** A pure memoised computation over other processes. No mailbox. */
export function derive<T>(_fn: () => T): Process<T> {
  throw TODO('derive (M2)')
}

/** Attach a view process to a sink. Disposal unbinds everything beneath, in order. */
export function mount(_sink: unknown, _view: Process<unknown>): Disposable {
  throw TODO('mount (M4)')
}

/**
 * Not a primitive — acknowledged sugar for transient widget state (the useState case).
 * A cell is a leaf process whose messages are its next values.
 */
export function cell<T>(initial: T): Process<T, T> {
  return spawn<T, T, void>(
    async function* (self: Self<T>) {
      for await (const next of self) yield next
    },
    undefined,
    { initial },
  )
}
