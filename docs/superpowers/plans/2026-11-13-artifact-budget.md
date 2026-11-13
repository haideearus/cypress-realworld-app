# Output and Budget Repair Plan

**Goal:** Complete issue #21 in one PR so issue #11 can make another correctly
counted attempt from repaired main. Use native implementation and local tests;
the only factory inference is the separately authorized Claude Pro review.

**Spec:** [Design](../specs/2026-11-13-artifact-budget-design.md).

## Tasks and evidence

1. Reproduce unit disk mutation and collector path/size failures, then isolate
   Vitest writes and improve bounded diagnostics without widening artifacts.
   RED: real seed/update changed tracked bytes; three collector cases failed.
   GREEN: full unit suite: 45 passed / 10 existing skips, tracked database diff empty.
2. Raise approved ceilings, permit normal counted attempts after legacy recovery,
   and extend serial cycles 3–5. Preserve history and lower-limit enforcement.
   RED: old ceilings, then old ledger bounds rejected valid extensions.
   Targeted policy/workflow/migration suite passed55tests.
3. Derive next slots, stop terminal reservations, and use new main for blocked
   unpublished retries. RED: wrong retry head, missing mapping, repeated cycle2,
   and a stranded terminal grant. GREEN: end-to-end five-cycle fixture completes
   with coding=5/reviews=5/retries=4 and no active/pending lock.
4. Finalize formatting/lint/workflow checks and one independent subscription
   review against the complete frozen #21 scope before merge. Keep current live
   values until merged; then set the six higher numerical settings while off.

The integrated local factory suite passes 119 tests with zero failures and one
existing Windows symlink skip (120 total). Exact commands/logs, CI and review
links are recorded in the PR. The historical failing filename is unknown; no
lost Claude patch or approval is invented. New issue #11 execution remains a fresh
ordinary run with all three previous grants preserved.
