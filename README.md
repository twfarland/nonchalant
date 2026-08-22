# Nonchalant

One primitive. A **process** holds its own state in plain `let` variables, yields
values over time, and does not care which side of the wire it runs on.

- State is a process of data; a view is a process of UI — same type, same lifecycle.
- Fine-grained rendering: write plain, read tracked. No vdom sweep.
- Location transparency: state is addressed by name; a name resolves identically
  in this tab, a worker, or a server, over a language-agnostic patch protocol.

Status: **M0–M9 implemented and tested** — reconcile, the reactive graph, the
process runtime, the DOM sink, the registry, the wire + conformance vectors,
the Node host, the Mario golden (CI budgets: one view yield, ≤ 3 DOM
writes/frame), 7GUIs (cells included), size budgets (core 6.2 KB gzip, a full
app 10.6 KB). npm publish is the remaining step.

Docs: [tutorial](docs/tutorial.md) ("Thinking in processes") ·
[concepts](docs/concepts.md) · [recipes](docs/recipes.md) ·
[migration](docs/migration.md) (React / Solid / LiveView) ·
[protocol](docs/PROTOCOL.md) · [examples](examples/README.md).
Contributors: read `docs/DESIGN.md` first — it is the canonical context;
`docs/ROADMAP.md` has per-milestone detail; the illustrated proposal is
`docs/design-proposal.html`.

Try it: `pnpm check && pnpm test` (133 tests). The pitch demo is
`examples/shared-cart` — state moves from tab to server by changing one line.

Successor to [sprezzatura](https://github.com/twfarland/sprezzatura) and
[acto](https://github.com/twfarland/acto), which are retired as artifacts.

MIT © Tim Farland
