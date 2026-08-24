# Examples

The examples are ordered from introductory to advanced. CI type-checks all of
them with `pnpm check`, and entries marked ⏱ have dedicated tests or performance
budgets. Most run entirely in the browser; the chat example uses the included
local server.

| example | shows |
|---|---|
| `counter/` | widget state as a closed-over `cell`; a Process as a live slot |
| `todomvc/` | ⏱ one state process + one view; the keyed list patches one row at a time |
| `typeahead/` | `latest()` queue conflation, lifetime abort via `self.signal` |
| `form/` | a submission that receives its result through `ask()` (try someone@taken.com) |
| `router/` | pages as view processes over the userland router in `lib/router.ts` |
| `undo-redo/` | middleware as function composition over `channel` |
| `query/` | ⏱ server state the process way: queries as definitions, mutations as `ask()` |
| `drag/` | a process that lasts from pointerdown to pointerup |
| `bounce/` | one physics process rendered through both DOM and canvas output |
| `multi-tab/` | one tab auto-elected host (Web Locks) over BroadcastChannel |
| `worker/` | ⏱ the wire over a Web Worker port, keeping expensive work off the UI thread |
| `agent/` | ⏱ an agent loop as a process: tools as processes, human approval, durable |
| `multi-agent/` | ⏱ delegation, hand-off, a state-machine supervisor, shared usage limits |
| `messaging/` | ⏱ pub/sub and a work queue as ports, with in-memory adapters |
| `chat/` | a client-server chat room over the wire protocol (`pnpm chat-server`) |
| `shared-cart/` | the same cart and view using either a local or remote registry |
| `mario/` | ⏱ the golden demo: 1 view yield, ≤ 3 DOM writes/frame, CI-asserted |
| `7guis/` | the classic seven; ⏱ cells last (it stresses derivations) |
| `js-framework-benchmark/` | the standard krausest benchmark app, keyed |

`lib/` contains reusable code built from the public primitives. It currently
includes hash and History API routers with replace-by-default navigation.
There is no separate plugin API or set of framework hooks. Each demo explains
its implementation beside the running example and links to its source.

## Running them

```sh
pnpm dev          # vite; opens the gallery at /examples/
```

Notes:

- **mario:** Use the arrow keys to walk and press up to jump. The golden test
  (`mario/mario.golden.test.ts`) also pins the classic input bug: holding a
  key down must never double-step the physics.
- **bounce:** Click either panel. Both renderers read the same process, so
  they stay in lockstep.
- **multi-tab:** Open several tabs of the same page. One automatically
  becomes the host. Close it and the job moves to another tab.
- **worker:** Press Start, then move the calculation between the worker and the main
  thread. The numbers are identical; the frame meter is not. Its tests run
  both halves of the wire over a `MessageChannel`
  (`worker/primes.test.ts`) and assert that the bindings follow the grinder
  across the switch (`worker/switch.test.ts`).
- **agent:** The agent loop, tools, and human approval queue all run as
  processes in the tab. The page binds to their state like any other demo.
  Press *kill the machine* during a question to see `durable()` recover the
  process from its journal.
- **multi-agent:** Brief the team, then press *kill the supervisor* while it
  is writing: the brief replays and the researcher's run count does not move,
  because the delegated call is answered from its record. Drop the budget to
  watch the pipeline stop at *out of budget* instead of half-finishing.
- **messaging:** Publish to a topic and watch the subscription processes
  processes) update; push jobs and watch two workers share them. Press *kill*
  while a worker holds a job: its lease expires and the other one finishes it,
  to see at-least-once delivery in practice.
- **chat:** Run `pnpm chat-server`, then open the page in several tabs or
  browsers) and hop between rooms. Each room is one server-side process,
  started by the first lookup and evicted when idle. One Node process can hold
  thousands of them. Kill the server mid-conversation to watch stale reads
  and the reconnect.
- **shared-cart:** The default version runs by itself. To use the server, run
  `pnpm cart-server` in another terminal, then swap the one commented line at
  the top of `shared-cart/main.ts`.
- **7guis/cells:** Type `=A1+1` into B1, `=B1*2` into C1, then edit A1.
  Only dependent cells recompute, which its test verifies by counting
  evaluations.
- **js-framework-benchmark:** The app is implemented here. Submitting it to
  the benchmark harness repo is a separate, external step.
