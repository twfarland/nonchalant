# Examples

The teaching ladder, in order. Every example is type-checked in CI
(`pnpm check`); the ones marked ⏱ carry CI-asserted budgets or tests.

| example | shows | notes |
|---|---|---|
| `counter/` | transient state: a closed-over `cell`; a Process as a slot | |
| `todomvc/` | one state process + one view; keyed list patches one row | |
| `typeahead/` | `latest()` (flatMapLatest), abort via `self.signal`, registry | |
| `form/` | `ask()` — a submit that learns its own outcome, typed | |
| `router/` | route as a process; lazy routes via `import()` in a thunk | code splitting |
| `undo-redo/` | middleware = function composition over `channel` | |
| `multi-tab/` | BroadcastChannel transport; one tab hosts, the rest connect | |
| `shared-cart/` | **the pitch demo** — local → server by changing one line | server.ts is the whole backend |
| `mario/` | ⏱ the golden: 1 view yield, ≤ 3 DOM writes/frame, CI-asserted | double-step bug regression-tested |
| `mario-canvas/` | the same process retargeted to a canvas renderer | demonstrated, not asserted |
| `7guis/` | counter, temperature, flight-booker, timer, crud, circle-drawer, ⏱ cells | cells last — it stresses derivations |
| `js-framework-benchmark/` | the standard krausest benchmark app, keyed | submission to the harness repo is external |

Mario is ported from `../sprezzatura-acto-mario` and fixes the double-step
physics bug the old stack had (diamond glitch in acto's combineLatest): arrows
are process state, only ticks step the world — see
`mario/mario.golden.test.ts`.

## Running them

```sh
pnpm dev          # vite dev server; opens the example gallery at /examples/
```

Every page is plain HTML + a TS module; vite resolves the workspace packages
straight from source (no build step). Notes:

- **mario / mario-canvas**: arrow keys to move and jump. Sprites are vendored
  under `examples/mario*/img/` (from the original repo).
- **multi-tab**: open one tab at `/examples/multi-tab/#host` (it hosts), then
  more tabs at `/examples/multi-tab/` — the counter syncs across all of them.
- **shared-cart** (the pitch demo): `pnpm cart-server` in a second terminal
  starts the WebSocket host on :4321; then flip the one commented line in
  `shared-cart/main.ts` to move the cart's state from the tab to the server.
- **typeahead / form** expect a backend at `/api/*`; without one they still
  demonstrate pending states and validation.
- **7guis/cells**: try `=A1+1` chains, then edit A1 — only dependents
  recompute (the same behavior its test asserts).
