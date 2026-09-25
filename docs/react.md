# Using nonchalant from React

`@nonchalant/react` lets a React app keep React as its renderer and use
processes for the state underneath: shared stores, remote processes over the
wire, durable agents. Nothing about the processes changes. The
[agent console](../examples/react-agent/) renders the unmodified
`examples/agent` process tree with it.

Use it when the React tree is staying and you want the parts React has no
answer for: a store addressable by name, state that lives on a server or in a
worker and arrives as patches, an agent loop that survives a restart. If you
are starting fresh and do not need React's ecosystem, `@nonchalant/dom`
renders the same processes with no adapter at all.

Five hooks, each a `useSyncExternalStore` over one core `effect`:

| hook | returns | for |
|---|---|---|
| `useProcess(p)` | `T` | the whole value; re-renders on every yield |
| `useDerive(fn, deps)` | `fn`'s result | part of one process, or a combination of several; re-renders when the result changes |
| `useProcessMeta(p)` | `{ pending, stale, error }` | spinners, stale badges, error banners |
| `useSpawn(proc, args, opts?)` | `Process<T, In>` | a process the component owns: spawned on mount, disposed on unmount |
| `useLookup(() => reg.lookup(name, args))` | the looked-up process | a registry entry kept alive while mounted |

## Reading a process

`useProcess` is the whole value. Its type is the process's type, so a lookup
of a definition without `initial` reads `T | undefined` until the first yield.

<!-- ts-prelude
import type { ReactNode } from 'react'
import type { Process } from '@nonchalant/core'
import { useProcess } from '@nonchalant/react'
declare const cart: Process<{ items: { name: string; qty: number }[] } | undefined>
-->
```tsx
function CartSize(): ReactNode {
  const items = useProcess(cart)?.items ?? []
  return <span>{items.length} items</span>
}
```

Reads are tearing-free: every component in one render sees the same yield,
because each hook reads the process synchronously and React re-checks after
subscribing.

## Reading part of one: `useDerive`

`useDerive` runs its function inside a [`derive`](concepts.md#derive). The
function records exactly the paths it read, it recomputes only when a patch
touches one of them, and the component re-renders only when the result
changes. `deps` are the render-scope values the function closes over, as for
`useMemo`.

<!-- ts-prelude
import { memo, type ReactNode } from 'react'
import type { Process } from '@nonchalant/core'
import { useDerive } from '@nonchalant/react'
declare const list: Process<{ rows: { id: number; label: string }[] }>
-->
```tsx
const Row = memo(function Row({ at }: { at: number }): ReactNode {
  const label = useDerive(() => list().rows[at]?.label, [at])
  return <li>{label}</li>
})

function List(): ReactNode {
  const length = useDerive(() => list().rows.length, [])
  return <ul>{Array.from({ length }, (_, at) => <Row key={at} at={at} />)}</ul>
}
```

Change one label in a thousand rows and one `Row` re-renders; `List` does not.
That is asserted with render counts in
`packages/react/test/hooks.test.tsx` ("re-renders exactly one row of a
thousand when one label changes"). The mechanism is the same path tracking the
DOM sink uses ([tracking](internals/tracking.md)); `memo` stops React's own
parent-to-child cascade, and the derive stops everything else.

A selector that builds a fresh object (`filter`, a spread) is fine: the derive
memoises it, so it only changes identity when its inputs did. The one extra
render such a selector costs is at mount, when the first subscription replaces
the snapshot the first render used.

## Status: `useProcessMeta`

<!-- ts-prelude
import type { ReactNode } from 'react'
import type { Process } from '@nonchalant/core'
import { useProcessMeta } from '@nonchalant/react'
declare const search: Process<string[] | undefined>
-->
```tsx
function SearchStatus(): ReactNode {
  const { pending, stale, error } = useProcessMeta(search)
  if (error !== undefined) return <em>search failed</em>
  return <em>{pending ? 'searching…' : stale ? 'offline' : ''}</em>
}
```

The object keeps its identity until one of the three fields changes. See
[error handling](errors.md#processes) for what each flag means.

## Owning a process: `useSpawn`

`useSpawn` is `spawn` with the component's lifetime. `args` and `opts` are read
once; to start over with new ones, give the component a new `key`. Pass
`initial` to read `T` instead of `T | undefined`.

<!-- ts-prelude
import type { ReactNode } from 'react'
import type { Cast, Proc } from '@nonchalant/core'
import { useProcess, useSpawn } from '@nonchalant/react'
-->
```tsx
type Msg = Cast<{ type: 'add'; by: number }>

const counter: Proc<number, Msg, void> = async function* (self) {
  let n = 0
  yield n
  for await (const msg of self) {
    switch (msg.type) {
      case 'add':
        n += msg.by
        break
    }
    yield n
  }
}

function Counter(): ReactNode {
  const count = useSpawn(counter, undefined, { initial: 0 })
  return <button onClick={() => count.cast({ type: 'add', by: 1 })}>{useProcess(count)}</button>
}
```

Widget state that only this component reads belongs in `useState`; `useSpawn`
is for state with a mailbox: a timer, a fetch loop, an agent run that should
stop when its panel closes.

### StrictMode and ownership

- **Double render.** React may call a component's initializer twice and keep
  one result (StrictMode does so on purpose; concurrent rendering can discard a
  render too). `useSpawn` spawns during render so the first render has a
  value, and marks the process claimed when its component commits. A process
  no commit claims within one second is disposed. A commit later than that
  finds its process disposed and spawns a fresh one, so the rule costs at most
  a restart, never a leak. `useSpawn` tests in `hooks.test.tsx` count exact
  starts and `finally` runs under StrictMode, and
  `packages/react/test/leaks.test.tsx` checks with `gc` that nothing is
  retained after unmount.
- **Double effects.** StrictMode's simulated unmount and remount happen in
  one task. `useSpawn` defers disposal by a microtask, so the remount reclaims
  the same process instead of restarting it. `useProcess`, `useDerive` and
  `useProcessMeta` subscribe and unsubscribe twice, and each subscription owns
  its own effect (and derive), so nothing outlives an unsubscribe.
- **Ownership.** A render is not a process step, so a process spawned by
  `useSpawn` has no parent process: the component is its owner. Processes it
  spawns during its own steps belong to it as usual
  ([spawn](concepts.md#spawn)).

## Looking up by name: `useLookup`

`useLookup` takes the lookup as a thunk, so the registry's own typing (names,
args, `T | undefined`) passes through unchanged, and so the hook can run it
again.

<!-- ts-prelude
import type { ReactNode } from 'react'
import { define, registry } from '@nonchalant/core'
import type { Cast, Proc } from '@nonchalant/core'
import { useDerive, useLookup } from '@nonchalant/react'
declare const cartProc: Proc<{ items: string[] }, Cast<{ type: 'add'; item: string }>, { id: string }>
-->
```tsx
const shop = registry({ cart: define(cartProc, { evict: 30_000 }) })

function AddButton({ id, item }: { id: string; item: string }): ReactNode {
  const cart = useLookup(() => shop.lookup('cart', { id }))
  const count = useDerive(() => cart()?.items.length ?? 0, [cart])
  return <button onClick={() => cart.cast({ type: 'add', item })}>add ({count})</button>
}
```

While the component is mounted it counts as a watcher of the entry, so idle
eviction and the LRU cap skip it even when the component only sends messages.
If the entry is evicted anyway (`shop.evict('cart')`), the component re-renders
and the lookup runs again: a durable process comes back from its journal, which
is how the agent console's "kill the machine" works. A registry from
`connect(url)` works the same way.

There is no provider or context. A registry is a module value; import it
where you need it, as with any other store.

## What it costs

`@nonchalant/react` with the parts of core it reaches is under 7 KB min+gzip,
React excluded (`test/size.test.ts`).
