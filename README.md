# Nonchalant

One primitive. A **process** holds its own state in plain `let` variables, yields
values over time, and does not care which side of the wire it runs on.

- State is a process of data; a view is a process of UI — same type, same lifecycle.
- Fine-grained rendering: write plain, read tracked. No vdom sweep.
- Location transparency: state is addressed by name; a name resolves identically
  in this tab, a worker, or a server, over a language-agnostic patch protocol.

Status: **M0–M8 implemented and tested** (reconcile, the reactive graph, the
process runtime, the DOM sink, the registry, the wire + conformance vectors, the
Node host, and the Mario golden with CI-asserted budgets: one view yield,
≤ 3 DOM writes/frame). M9 (site, 7GUIs, benchmark entry, first publish) is next.
Read `docs/DESIGN.md` first — it is the canonical context. `docs/ROADMAP.md` has the
build order and per-milestone detail. The full illustrated proposal is
`docs/design-proposal.html`. Try it: `pnpm check && pnpm test` (125 tests);
the pitch demo is `examples/shared-cart` — state moves from tab to server by
changing one line.

Successor to [sprezzatura](https://github.com/twfarland/sprezzatura) and
[acto](https://github.com/twfarland/acto), which are retired as artifacts.

MIT © Tim Farland
