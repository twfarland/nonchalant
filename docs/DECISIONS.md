# Decision record

Settled across proposal drafts 1–3 (full arguments: docs/design-proposal.html).

| # | Decision | Went to | Because |
|---|----------|---------|---------|
| 1 | Signal vs Process | One type: `Process` | A signal is a process with no mailbox that resolves synchronously. Two implementation tiers (suspended generator frames; alien-signals push–pull graph), one type over both. |
| 2 | Reactive plain `let` | Generator locals | No interception point for a variable binding without a compiler (Svelte 4's lesson). A suspended frame makes `let` real state; `yield` is the only ceremony. Deep-proxy `state()` demoted to optional entry point. |
| 3 | View representation | Function calls `div({}, …)` | Scorecard 140/150 vs JSX 111, tuples 104, tagged templates 97. Decisive: type safety (tag-specific attrs) and retargetability (typed plain data any sink can walk). JSX ships as ~50-line adapter, never primary. |
| 4 | What crosses the wire | State patches, never markup | DOM patches ⇒ server templates ⇒ SSR under another name. Plain-data patches keep backends DOM-ignorant and open non-DOM sinks. |
| 5 | Async iterators as core | No — as an interface | Sync multicast glitch-free reads vs microtask single-consumer lossless streams are different types. A process exposes both: `p()` and `for await`. |
| 6 | Reactivity algorithm | Port alien-signals | 262 lines, benchmark-winning, ported into Vue 3.6. Solved problem. |
| 7 | Erlang scope | Half of it | Taken: private state, message-only input, supervision, location transparency. Not: preemption, crash-first. Added: every yield published ⇒ free reads. |
| 8 | Granularity | Write plain, read tracked | Immutable snapshots + ephemeral get-only read proxy recording paths; reconcile ops matched against recorded paths. No write traps, no reactive/raw identity split. |
| 9 | Request/response | `Call<Req,Res>` + `ask()` | Erlang call/cast, compiler-enforced (`send`ing a call is a compile error). Wire: correlated call/reply ops. |
| 10 | Naming | Registry, `lookup` = get-or-spawn | One concept = DI + query cache + remote addressing. `connect(url)` returns a Registry (fixes draft 2 transport/address conflation). Schema doubles as security whitelist. |
| 11 | Mailbox | FIFO + `latest()` | Backpressure by default (double-submit queues); `latest()` is flatMapLatest as an iteration mode. `self.send` for actor self-send. |
| 12 | First read | `initial` decides the type | `spawn(p, a)` → `Process<T \| undefined>`; `spawn(p, a, {initial})` → `Process<T>`. |
| 13 | Transient state | Anonymous spawn + ambient scope | Closed-over processes are the useState case; owned by the enclosing scope, die with it. `cell()` ships as acknowledged sugar (not a primitive). Inside generator bodies reads are pulls; subscription is iteration. |
| 14 | Keyed lists | One honest localized diff | Sink reconciles children by key (as Solid For / lit repeat). "No vdom" = no whole-tree sweep, not no list diff. Splice ops can drive DOM splices directly. |

## Open questions
- Q1 Per-yield epoch scoping vs explicit dispose → ship explicit-first.
- Q2 predict/rebase in v1 → stale+replay in v1; predict behind a flag after splice-vs-splice property tests.
- Q3 Mailbox overflow policy → bounded, drop-oldest for casts, dev warning; bound is a spawn option.
- Q4 npm: claim `nonchalant` + `@nonchalant` scope before first publish.
- Q5 RFC 6901 path escaping in reconcile/applyPatch (currently rejected keys).
