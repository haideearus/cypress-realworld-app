# Automatic Merge Confirmation Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for this focused fix.
> Implement inline and perform a fresh read-only code review before handoff.

**Goal:** Confirm protected merge results without losing receipts, demanding a
post-write rebase, or repeating an ambiguous PUT.

**Architecture:** Keep write guards unchanged. Use a separate bounded observation
path for existing intents, append sanitized receipts to the existing audit, and
route dependency recovery directly to observation.

**Tech Stack:** Existing Node.js CommonJS, node:test, GitHub REST and Actions.

**Spec:** `docs/superpowers/specs/2026-11-16-merge-confirmation-design.md`.

## Global constraints

- All three live factory switches stay false; the durable stop stays active.
- Preserve #57's historical approval, counters and owner reconciliation.
- No Claude, paid AI API, permission/limit change, merge or deployment.
- A tree or API response alone cannot manufacture a merged PR record.

## Review focus

- Lost responses and later workflow ticks cannot cause a second write.
- Read-only observation cannot leak into fresh write authorization.
- Changed head/approval, receipt SHA mismatch and durable stop fail closed.
- Temporary API failures and incomplete metadata preserve evidence and locks.
- Preflight failures can release only a request that was provably never sent.

## Task 1: Preserve outcomes and bound confirmation

**Files:** `scripts/factory/merge.cjs`, `scripts/tests/factory-merge.test.cjs`.

**Interfaces:** `pr(ticket,t,{confirmation})`, `confirm(ticket,t,options)`;
existing `merge()` results retain `merged`, with explicit pending `reason`.

- [x] Add delayed metadata, receipt sanitization/mismatch, uncertain outcome,
      cross-run replay, read failure and unsent preflight regressions.
- [x] Run targeted tests; retain the failing output and base revision.
- [x] Implement one protected PUT, sanitized audit receipt, bounded confirmation,
      and audit-preserving release of provably unsent intents.
- [x] Run the complete merger tests and check all original protection regressions.

## Task 2: Route dependency intents safely

**Files:** `scripts/factory/dependencies.cjs`, dependency workflow and tests,
`docs/factory/DEPENDENCY-MAINTENANCE.md`.

**Interfaces:** coordinator observation preserves identity validation while
skipping write-only rebase/report guards; existing `reconcile` workflow mode
can consume open pending intents without model or premerge work.

- [x] Add regressions for advanced main with open metadata, old-head changes,
      pending pickup without analysis and strict fresh-write guards.
- [x] Run regressions and retain RED evidence.
- [x] Route intents to observation and retain existing fresh-write validation.
- [x] Run the full factory suite, lint and formatting; inspect branch diff and
      scan tracked source for secrets. Record all failures and blocked checks.
- [ ] Perform a fresh read-only review, address substantive findings with tests,
      then push only the feature branch and open a draft PR linked to #72.

## Execution record

Implementation follows the user's explicit request to prepare the fix PR, using
the existing checkout on a dedicated feature branch. No additional design
question or live run is needed for this already diagnosed, bounded correction.

Fresh read-only Codex review found two substantive concurrency/revalidation
issues. Both were reproduced with four failing regressions, then fixed: terminal
CAS checks the latest receipt, late receipts survive concurrent reconciliation,
and the entire dependency terminal read remains in observation mode. Two further
regressions cover a live writer and unnecessary post-write file-list reads; both
failed before those corrections. The focused suite now passes 95 tests. The final
factory suite passes 559 tests with 10 optional checks skipped and no failures;
the application unit suite passes 79 tests with 10 existing skips. Root lint and
explicit changed-file formatting checks pass. Local full API/browser CI was not
repeated because this PR changes only the harness and its tests/documentation;
ordinary PR CI will validate the complete source snapshot.

Ruling: reuse the existing reconciliation workflow mode instead of modifying its
YAML or permissions; the already-gated lane skips premerge and model jobs. The
tradeoff is that permanently inconsistent GitHub metadata still requires owner
reconciliation, rather than an unsafe duplicate write or invented merged status.
