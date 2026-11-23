# Browser discovery and three-sweep rollout implementation

**Goal** — Increase verified ordinary functional browser coverage and allow an opt-in third daily Claude discovery sweep.

**Spec** — [Browser coverage and weekly features design](../specs/2026-11-23-browser-coverage-and-weekly-features-design.md), PR 1. The owner requested the third-sweep option in issue #203's implementation scope.

- [x] Add extended deterministic Cypress journeys for payment persistence across sessions, notification read persistence, narrow-screen filters, and bank-account deletion. Preserve named repeat verification and the existing functional incident publisher.
- [x] Bridge exact trusted browser sweep evidence to two matching disposable checks and the canonical browser incident publisher. Reject cross-repository, stale, changed, incomplete and nonmatching evidence. Preserve one active incident, the model-free verification path and existing API findings.
- [x] Test the default cap of two, the opt-in cap of three, all used charter exclusions, global admission and fail-closed GitHub headroom. Ask later sweeps to lead with distinct browser journeys within the existing four total batches.
- [x] Expose an optional third schedule without changing the repository variable. Verify formatting, focused tests, full factory tests, real Cypress checks and independent review before opening the draft.

Review focus includes nonreproducing browser failures, overlap between producers, no third reservation when busy or low on GitHub quota, time-window boundaries, and historical proofs. Independent review prompted two tested changes: recheck quota at grant reservation and recheck the durable stop before browser handoff publication.

Local Cypress on fresh disposable PostgreSQL covered the new cases. The payment,
notification and mobile cases passed. The existing app reproducibly omitted
onboarding after the final bank account deletion. The existing declined-request
balance assertion also failed on fresh attempts. Both are application findings.
