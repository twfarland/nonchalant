# Migration guides

Coming from React, Solid, or LiveView: what maps to what, and — just as
important — what doesn't carry over.

## From React

| React | nonchalant |
|---|---|
| `useState` | a closed-over `cell` (or any process) — no hook rules, no ordering constraints |
| `useReducer` | the `for await (msg of self)` loop — your generator body is the reducer |
| `useEffect` | often scope ownership; for external side effects, `effect(fn)` with a cleanup return |
| `useMemo` / `useCallback` | `derive(fn)` / plain closures — nothing re-renders, so there's nothing to defend against |
| Context / prop drilling | `registry.lookup(name)` — works inside or outside the view tree |
| part of TanStack Query's cache lifecycle | `define(queryProc, { evict })` + `lookup(name, args)` — see the recipes |
| Suspense boundaries | not needed: a pending promise occupies only its own slot |
| the `key` prop | the same `key` attr, same job (and `key: 0` works) |

The big shift: **there is no render loop**. A component function runs once,
returns a tree with bindings in it, and is never called again. All the React
muscle memory about surviving re-renders — dependency arrays, memoization,
stable callback identities — has nothing to attach to, because the problem is
gone. What you give up: the "just re-run the function" mental model. Structure
that changes has to be expressed as keyed lists or swapped regions, not as a
different return value from a re-run.

## From Solid

You already think in fine-grained updates; most of this will feel familiar.

| Solid | nonchalant |
|---|---|
| `createSignal` | `cell`, or just `let` inside a process |
| `createMemo` | `derive` |
| `createEffect` | `effect` |
| `createResource` | a process that fetches and yields — `pending`/`stale`/`error` come built in |
| `<For>` | a keyed thunk: `() => rows().map(r => li({ key: r.id }, …))` |
| stores + `produce` | plain immutable updates; granularity comes from path tracking on reads |
| ownership / `onCleanup` | scope ownership: children die with their spawner; `finally` in the generator |

The big shift: state here has a **mailbox and a lifetime**, not just a value.
Where Solid composes signals, nonchalant composes processes — and the same
unit that holds widget state also holds a query, or lives on a server. There's
also a wire: `lookup` resolves the same name locally or remotely. What you
give up: Solid's JSX ergonomics. Views here are function calls (`div({}, …)`),
and reactive expressions need an explicit thunk: `() => cart().total`.

## From Phoenix LiveView

| LiveView | nonchalant |
|---|---|
| a LiveView process | the nearest counterpart: state, messages, and a mailbox, but without BEAM isolation |
| `handle_event` | a message arriving in `for await (msg of self)` |
| assigns diffing → HTML over the wire | state diffing → **data patches** over the wire, never HTML |
| `phx-click` | `onclick: () => proc.send(…)` — and the handler can also be purely local |
| reconnect and re-render | re-lookup + full state, diffed against what the client kept |
| PubSub | a shared named process that both sides look up |

Some Erlang vocabulary transfers: `send` resembles a cast, `ask` resembles a
call, `restart: 'on-crash'` restarts from the init args, and owned children
are disposed with their parent. This remains cooperative JavaScript, not an
OTP supervision system.

The key difference: the wire carries state, not rendered templates. The client
owns rendering (any sink — DOM or canvas), local-only interactions cost no
round-trip, and the server half can be written in any language
(`docs/PROTOCOL.md` plus the conformance vectors are the contract).

You give up BEAM preemption and hot-code reloading. A hot loop in JS still
blocks its thread; worker threads are the isolation strategy. Nonchalant does
not provide process isolation, escalation hierarchies, or OTP supervision trees.

## A migration path that works

1. Port state first: processes with typed message unions, running under your
   existing UI via plain reads and `send`.
2. Move views over piece by piece — `mount` can own a single island.
3. Route shared or cached things through a registry as you touch them.
4. Add the wire last. The registry substitution is small; authentication,
   authorization, JSON boundaries, and failure handling are the real work.
