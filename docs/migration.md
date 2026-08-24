# Migration guides

This guide maps familiar React, Solid, and LiveView concepts to Nonchalant and
explains where the models differ.

## From React

| React | nonchalant |
|---|---|
| `useState` | a closed-over `cell` or another process; there are no hook ordering rules |
| `useReducer` | a `for await (msg of self)` loop, with the generator body handling updates |
| `useEffect` | often scope ownership; for external side effects, `effect(fn)` with a cleanup return |
| `useMemo` / `useCallback` | `derive(fn)` or plain closures; views do not rerender |
| Context / prop drilling | `registry.lookup(name)`, available inside or outside the view tree |
| part of TanStack Query's cache lifecycle | `define(queryProc, { evict })` with `lookup(name, args)`; see the recipes |
| Suspense boundaries | not needed: a pending promise occupies only its own slot |
| the `key` prop | the same `key` attr, same job (and `key: 0` works) |

The main difference is that **there is no render loop**. A view function runs
once and returns a tree containing live bindings. It does not run again after
state changes, so dependency arrays and stable callback identities are not
needed. In exchange, changing structure must be represented with keyed lists
or replaceable regions rather than by returning a different tree.

## From Solid

You already think in fine-grained updates; most of this will feel familiar.

| Solid | nonchalant |
|---|---|
| `createSignal` | `cell`, or a `let` variable inside a process |
| `createMemo` | `derive` |
| `createEffect` | `effect` |
| `createResource` | a process that fetches and yields, with `pending`, `stale`, and `error` state |
| `<For>` | a keyed thunk: `() => rows().map(r => li({ key: r.id }, …))` |
| stores + `produce` | plain immutable updates; granularity comes from path tracking on reads |
| ownership / `onCleanup` | scope ownership: children die with their spawner; `finally` in the generator |

In Nonchalant, state has a **mailbox and a lifetime** as well as a value. Solid
composes signals, while Nonchalant composes processes that can manage a widget,
a query, or server state. `lookup` can resolve the same name locally or
remotely. Nonchalant does not provide Solid's JSX ergonomics by default: views
use function calls such as `div({}, …)`, and reactive expressions require a
thunk such as `() => cart().total`.

## From Phoenix LiveView

| LiveView | nonchalant |
|---|---|
| a LiveView process | the nearest counterpart: state, messages, and a mailbox, but without BEAM isolation |
| `handle_event` | a message arriving in `for await (msg of self)` |
| assigns diffing → HTML over the wire | state diffing → **data patches** over the wire, never HTML |
| `phx-click` | `onclick: () => proc.send(…)`; the handler may also remain local |
| reconnect and re-render | re-lookup + full state, diffed against what the client kept |
| PubSub | a shared named process that both sides look up |

Some Erlang vocabulary transfers: `send` resembles a cast, `ask` resembles a
call, `restart: 'on-crash'` restarts from the init args, and owned children
are disposed with their parent. This remains cooperative JavaScript, not an
OTP supervision system.

The wire carries state rather than rendered templates. The client handles DOM,
canvas, or other rendering, local interactions require no network round trip,
and the server can be written in any language
(`docs/PROTOCOL.md` plus the conformance vectors are the contract).

You give up BEAM preemption and hot-code reloading. A hot loop in JS still
blocks its thread; worker threads are the isolation strategy. Nonchalant does
not provide process isolation, escalation hierarchies, or OTP supervision trees.

## A migration path that works

1. Port state first: processes with typed message unions, running under your
   existing UI via plain reads and `send`.
2. Move views over gradually. `mount` can manage a single island.
3. Route shared or cached things through a registry as you touch them.
4. Add the wire last. The registry substitution is small; authentication,
   authorization, JSON boundaries, and failure handling require most of the care.
