// Compile-only: the adapter inherits core's typing. The @ts-expect-error lines
// are load-bearing — if one stops erroring, the type surface broke.

import { define, registry } from '@nonchalant/core'
import type { Cast, Proc } from '@nonchalant/core'
import { useDerive, useLookup, useProcess, useProcessMeta, useSpawn } from '@nonchalant/react'

type Msg = Cast<{ type: 'add'; by: number }>
declare const counter: Proc<number, Msg, void>
declare const byId: Proc<string, never, { id: string }>

const reg = registry({
  bare: define(counter),
  seeded: define(counter, { initial: 0 }),
  user: define(byId),
})

export function Components(): void {
  // a definition without `initial` reads T | undefined before its first yield
  const bare: number | undefined = useProcess(useLookup(() => reg.lookup('bare')))
  // @ts-expect-error — not a plain number
  const bareNumber: number = useProcess(useLookup(() => reg.lookup('bare')))

  const seeded: number = useProcess(useLookup(() => reg.lookup('seeded')))
  const user: string | undefined = useProcess(useLookup(() => reg.lookup('user', { id: 'u1' })))
  // @ts-expect-error — args are required where the definition takes them
  useLookup(() => reg.lookup('user'))
  // @ts-expect-error — no such name
  useLookup(() => reg.lookup('missing'))
  // @ts-expect-error — a lookup returns a process, and so must the thunk
  useLookup(() => 'bare')

  const owned = useSpawn(counter, undefined, { initial: 0 })
  const n: number = useProcess(owned)
  owned.cast({ type: 'add', by: 1 })
  // @ts-expect-error — not a message this process takes
  owned.cast({ type: 'reset' })
  // @ts-expect-error — without `initial` the value may be undefined
  const early: number = useProcess(useSpawn(counter, undefined))

  const twice: number = useDerive(() => owned() * 2, [])
  const { pending, stale }: { pending: boolean; stale: boolean } = useProcessMeta(owned)

  void [bare, bareNumber, seeded, user, n, early, twice, pending, stale]
}
