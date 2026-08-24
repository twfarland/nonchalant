# Examples

The teaching ladder, in order. Everything is type-checked in CI (`pnpm check`);
the entries marked ⏱ carry their own CI-asserted tests or budgets. All demos
are self-contained — no backends required.

| example | shows |
|---|---|
| `counter/` | widget state as a closed-over `cell`; a Process as a live slot |
| `todomvc/` | ⏱ one state process + one view; the keyed list patches one row at a time |
| `typeahead/` | `latest()` queue conflation, lifetime abort via `self.signal` |
| `form/` | `ask()` — a submit that learns its own outcome (try someone@taken.com) |
| `router/` | pages as view processes over the userland router in `lib/router.ts` |
| `undo-redo/` | middleware as function composition over `channel` |
| `query/` | ⏱ server state the process way: queries as definitions, mutations as `ask()` |
| `drag/` | a gesture with a lifetime: born on pointerdown, dead on pointerup |
| `bounce/` | one physics process, two renderers at once — the DOM sink and a canvas effect |
| `multi-tab/` | one tab auto-elected host (Web Locks) over BroadcastChannel |
| `worker/` | ⏱ the wire over a Web Worker port — heavy state off the UI thread |
| `chat/` | a client-server chat room over the wire protocol (`pnpm chat-server`) |
| `shared-cart/` | the same cart and view using either a local or remote registry |
| `mario/` | ⏱ the golden demo: 1 view yield, ≤ 3 DOM writes/frame, CI-asserted |
| `7guis/` | the classic seven; ⏱ cells last (it stresses derivations) |
| `js-framework-benchmark/` | the standard krausest benchmark app, keyed |

`lib/` holds constructs written as if they were libraries — currently the
router (hash and History-API flavors, replace-by-default navigation) — to
show what defining your own costs here: no plugin API, no framework hooks,
just processes. Every demo page explains its own mechanism inline, with the
load-bearing code readable next to the running thing.

## Running them

```sh
pnpm dev          # vite; opens the gallery at /examples/
```

Notes:

- **mario** — arrow keys to walk, up to jump. The golden test
  (`mario/mario.golden.test.ts`) also pins the classic input bug: holding a
  key down must never double-step the physics.
- **bounce** — click either panel; both renderers read the same process, so
  they stay in lockstep.
- **multi-tab** — open several tabs of the same page; one automatically
  becomes the host. Close it and the job moves to another tab.
- **worker** — press Start, then move the grinder between the worker and this
  thread. The numbers are identical; the frame meter is not. Its tests run
  both halves of the wire over a `MessageChannel`
  (`worker/primes.test.ts`) and assert that the bindings follow the grinder
  across the switch (`worker/switch.test.ts`).
- **chat** — run `pnpm chat-server`, then open the page in several tabs (or
  browsers) and hop between rooms. Each room is one server-side process,
  spawned on first lookup and evicted when idle — one node process holds
  thousands of them. Kill the server mid-conversation to watch stale reads
  and the reconnect.
- **shared-cart** — works standalone. For the server version: run
  `pnpm cart-server` in another terminal, then swap the one commented line at
  the top of `shared-cart/main.ts`.
- **7guis/cells** — type `=A1+1` into B1, `=B1*2` into C1, then edit A1.
  Only the dependents recompute — the same thing its test asserts by counting
  evaluations.
- **js-framework-benchmark** — the app is implemented here; submitting it to
  the benchmark harness repo is a separate, external step.
