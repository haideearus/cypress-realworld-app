# Weekly AI Feature Planning Implementation Plan

> Implement inline with failing-before controller tests and the full model-free factory suite.

**Goal:** Admit evidence-backed features from a weekly planner through the existing app workflow.

**Architecture:** A protected metadata branch stores validated plans, planned work and publication intents. The usage ledger owns the single local-week planner reservation and records the typed feature receipt on automatic app admissions. Existing review, merge and deployment controls handle implementation.

**Spec:** Issue #202 and PR 2 of the 2026-11-23 browser discovery and weekly AI feature design, including the owner's later approval for ordinary product features across the app.

## Global Constraints

- Disabled by default, read-only preview, explicitly enabled small pilot, and subscription-only planning.
- One planner per Europe/Bucharest week, one active feature, and up to one major and five minor plans.
- Repair and incident work, due repair retries and eligible dependency repairs precede features.
- Model data is untrusted. Product proposals carry checked evidence and bounded acceptance criteria. Existing protected paths and human production approval apply.

## Review Focus

- An uncertain issue-create response must never cause a second create.
- An edited, copied, manually labeled or forged issue cannot claim the feature origin.
- A due repair still wins when a feature is waiting or retrying.
- A planning reservation counts once even if its workflow is retried, abandoned or crosses midnight.
- A major's stages never consume minor capacity or start alongside another active feature.

## Implementation

- [x] Specify the typed proposal/receipt contract and tests for forged, duplicate and out-of-scope proposals. Implement the strict validators, Bucharest week and issue serialization.
- [x] Verify origin binding, publication ambiguity handling, pilot isolation and repaired-first pickup with factory tests. Wire publication to protected metadata and automatic admission, retries and closure to the published origin.
- [x] Verify planner usage, workflow identity and preview credentials with tests. Add gated reservation, no-tool Claude planning, model-free validation, and durable queued progress.
- [x] Verify checkout and configuration boundaries, run the factory suite and record pilot/rollout steps. Commit locally.
