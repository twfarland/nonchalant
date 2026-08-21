# Nonchalant

One primitive. A **process** holds its own state in plain `let` variables, yields
values over time, and does not care which side of the wire it runs on.

- State is a process of data; a view is a process of UI — same type, same lifecycle.
- Fine-grained rendering: write plain, read tracked. No vdom sweep.
- Location transparency: state is addressed by name; a name resolves identically
  in this tab, a worker, or a server, over a language-agnostic patch protocol.

Status: **design complete (draft 3), implementation starting.**
Read `docs/DESIGN.md` first — it is the canonical context. `docs/ROADMAP.md` has the
build order. The full illustrated proposal is `docs/design-proposal.html`.

Successor to [sprezzatura](https://github.com/twfarland/sprezzatura) and
[acto](https://github.com/twfarland/acto), which are retired as artifacts.

MIT © Tim Farland
