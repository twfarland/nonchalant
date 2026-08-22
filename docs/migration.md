# Migration guides

Rosetta stones, honest about differences. Each maps the concepts you have to
the one primitive here, and names what does *not* carry over.

## From React

| React | nonchalant |
|---|---|
| `useState` | a closed-over `cell` (or any process) — no hook rules, no render-order dependence |
| `useReducer` | the `for await (msg of self)` loop — the reducer is your generator body |
| `useEffect` | usually nothing: lifetimes are scopes. For real effects, `effect(fn)` with a cleanup return |
| `useMemo` / `useCallback` | `derive(fn)` / plain closures — nothing re-renders, so nothing needs memoising against re-render |
| Context / prop drilling | `registry.lookup(name)` — the registry is the context, and it works outside the tree |
| TanStack Query | `define(queryProc, { evict })` + `lookup(['key-ish', args])` — see docs/recipes.md |
| Suspense boundary | none needed: a pending promise holds only its own slot |
| `key` prop | the same `key` attr, same job, `key: 0` handled |

The deep difference: there is no render loop. A component function runs
**once**, returns a tree of bindings, and is never called again — updates flow
through the graph, not through re-execution. Everything you do in React to
survive re-renders (dependency arrays, memo, callback identity) has no
equivalent because the problem does not exist. What you give up: the
"just re-run the function" mental model; structural changes must be expressed
as keyed lists or region swaps, not as divergent return values from a re-run.

## From Solid

You already think fine-grained; the mapping is close.

| Solid | nonchalant |
|---|---|
| `createSignal` | `cell` (a process), or plain `let` inside a process |
| `createMemo` | `derive` |
| `createEffect` | `effect` |
| `createResource` / async signals | a process that fetches and yields — `pending`/`stale`/`error` are on the face |
| `<For>` | the keyed thunk hole: `() => rows().map(r => li({ key: r.id }, …))` |
| stores + `produce` | immutable `let` + spread; granularity is recovered on the read side by path tracking |
| ownership / `onCleanup` | scope ownership: spawns die with their spawner; `finally` in the generator body |

The deep difference: state has a **mailbox and a lifetime**, not just a value.
Where Solid composes signal graphs, nonchalant composes processes — the same
unit does local widget state, a query, a server actor. And there is a wire:
`lookup` resolves the same name in-tab or remote. What you give up: Solid's
compiler-free JSX ergonomics are matched only by function calls here (JSX is a
planned ~50-line adapter, never primary), and the thunk tax (`() =>
cart().total`) is accepted and priced.

## From Phoenix LiveView

| LiveView | nonchalant |
|---|---|
| a LiveView process | a process — genuinely the same shape: state + messages + a mailbox |
| `handle_event` | a message arriving in `for await (msg of self)` |
| assigns diffing → HTML over the wire | `reconcile` → **state patches** over the wire, never markup |
| `phx-click` | `onclick: () => proc.send(…)` — but the handler can be local |
| reconnect / re-render | re-lookup + full snapshot, diffed against the retained value |
| PubSub | a shared named process both sides `lookup` |

The deep difference: the wire carries state, not rendered templates, so the
client owns rendering (any sink — DOM, canvas), local-only state costs no
round-trip, and the host half is language-agnostic (`packages/wire/spec/` —
a BEAM host certifies against the same vectors; your Elixir instincts about
processes, casts/calls, and supervision transfer almost verbatim: `send` is
cast, `ask` is call, `restart: 'on-crash'` restarts from init args). What you
give up: BEAM preemption — a hot JS loop still blocks its thread; worker-thread
hosts partition the blast radius.

## General advice

1. Port state first, as processes with typed message unions; run them under
   the existing UI via `p()` pulls and `p.send`.
2. Move views over piecemeal — a nonchalant `mount` can own one island.
3. Shared/cached things go through a registry as you touch them.
4. The wire comes last, and by then it is one line.
