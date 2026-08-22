# Examples

The teaching ladder, in order. Everything is type-checked in CI (`pnpm check`);
the entries marked ⏱ carry their own CI-asserted tests or budgets. All demos
are self-contained — no backends required.

| example | shows |
|---|---|
| `counter/` | widget state as a closed-over `cell`; a Process as a live slot |
| `todomvc/` | one state process + one view; the keyed list patches one row at a time |
| `typeahead/` | `latest()` racing, abort via `self.signal` (fake API with latency) |
| `form/` | `ask()` — a submit that learns its own outcome (try someone@taken.com) |
| `router/` | pages as view processes: interim loading yield, `import()` code splitting, dispose cascade |
| `undo-redo/` | middleware as function composition over `channel` |
| `drag/` | a gesture with a lifetime: born on pointerdown, dead on pointerup |
| `bounce/` | one physics process, two renderers at once — the DOM sink and a canvas effect |
| `multi-tab/` | one tab auto-elected host (Web Locks) over BroadcastChannel |
| `shared-cart/` | **the pitch demo** — state moves tab → server by changing one line |
| `mario/` | ⏱ the golden demo: 1 view yield, ≤ 3 DOM writes/frame, CI-asserted |
| `7guis/` | the classic seven; ⏱ cells last (it stresses derivations) |
| `js-framework-benchmark/` | the standard krausest benchmark app, keyed |

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
- **shared-cart** — works standalone. For the server version: run
  `pnpm cart-server` in another terminal, then swap the one commented line at
  the top of `shared-cart/main.ts`.
- **7guis/cells** — type `=A1+1` into B1, `=B1*2` into C1, then edit A1.
  Only the dependents recompute — the same thing its test asserts by counting
  evaluations.
- **js-framework-benchmark** — the app is implemented here; submitting it to
  the benchmark harness repo is a separate, external step.
