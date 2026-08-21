# Examples (planned — see docs/ROADMAP.md for milestones)

Ladder, in teaching order:
counter → todomvc → typeahead → form → router → query-cache → undo-redo →
multi-tab → shared-cart (the one-line local→server move, the pitch demo) →
mario-dom (golden: 1 view yield, ≤3 DOM writes/frame, CI-asserted) →
mario-canvas (same app, different sink) → 7guis (cells last).

Mario is ported from ../sprezzatura-acto-mario and must fix the double-step
physics bug the old stack had (diamond glitch in acto's combineLatest).
