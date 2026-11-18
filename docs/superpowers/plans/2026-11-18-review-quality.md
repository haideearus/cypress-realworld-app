# Review quality implementation plan

> Execute inline using the executing-plans and test-driven-development skills, then request one fresh local code review. No Claude session is authorized.

**Goal:** Stop pass/test/test evidence from becoming usable approval while preserving both consumed reviews.

**Architecture:** One four-field validator, reused by collector/assessment and retained-feedback gate; read-only prompt remains permission-limited.

**Spec:** docs/superpowers/specs/2026-11-18-review-quality.md

- [x] Trace SDK structured_output through collector and ledger; verify original artifact digest.
- [x] Reproduce collector and gate acceptance with RED tests using the observed artifact and two retained reviews.
- [x] Add text checks and prompt/schema guidance, then run focused tests.
- [x] Update synthetic positive fixtures to carry actual review explanations; no production-history edits.
- [x] Verify controller/dependency/merge paths, full factory suite, formatting and secret scan.
- [x] Obtain fresh local review, update PR #94 and combined brief, verify settings/counters unchanged and prepare the next unstarted review.

Ruling: preserve JSON shape and strengthen obvious non-evidence checks rather than migrate all review records. Missing historical review content stays readable but cannot authorize a merge. No live ledger write or model call.

Local review found one padded-sample bypass. The single fix pass added the exact sentence as a RED regression, then rejected explicit sample self-descriptions and required multiple explanatory words. Follow-up review cleared the finding. Full suite: 788 pass, 14 skipped, zero failures. Live read-only evaluation denied the original placeholder while preserving both #93 reviews byte-for-byte. No live state writes or model session.
