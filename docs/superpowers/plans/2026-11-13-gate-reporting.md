# Gate Reporting Resolution Record

**Goal:** Finish the native required gate in existing PR #19 with the full owner
authorized scope and no additional workflow permission grants.

**Architecture:** The native read-only pull-request job evaluates trusted base
policy and current ledger proof. The controller publishes informational evidence
only. The owner/authorized repository manager explicitly refreshes the native
gate after a genuine review. No rerun API helper remains in the source.

**Spec:** [Final design](../specs/2026-11-13-gate-reporting-design.md).
**Review scope:** [Complete brief](../../factory/PR-19-REVIEW.md), issue #20.

## Resolution

- Preserve the native job and executable stdin verifier with missing/stale/fake
  proof, unavailable ledger, wrong/closed/changed PR and disabled-read-only tests.
- Restore the three metadata jobs' exact original Actions permissions, remove
  the automatic rerun helper/controller wiring, and restore GitHub client behavior.
- Test that controller gate reporting makes no Actions request or usage write.
- Require exact recovery reviews=2/daily=5 alongside coding=2/retries=1, testing
  that positive reductions (reviews=1/day=4) refuse recovery and its preflight.
- Record the owner's one additional review allowance under existing #20, whose
  criteria cover the entire final PR. Preserve #18's two historical reviews and
  issue #11's failed coding history. No counter or approval is reset.

## Evidence and finalization

The prior revision had 109 factory tests, including automatic-rerun tests. That
feature is removed rather than retained with unreviewed permissions. The resolution
first reproduced two failures: Actions write instead of read, and positive lower
budgets not refusing recovery. Final local suite after removal: 103 passed,
zero failed, one existing Windows symlink skip (104 tests). The actual stdin
success/failure regression remains. Final formatting, lint, workflow validation,
CI and separately authorized review evidence are recorded in PR #19.

The factory remains disabled during preparation. After CI, only one additional
Claude Pro subscription review is authorized; then restore the flag, refresh the
native status only after a pass, and confirm actual merge eligibility. Any further
work must preserve the genuine review gate and historical counters.
