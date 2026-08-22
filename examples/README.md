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

The examples are entry modules (`main.ts` expecting `#app`, mario expecting
`document.body`); serve them with any TS-aware dev server (e.g. `vite`) from
the repo root.
