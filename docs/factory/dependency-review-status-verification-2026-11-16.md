# Dependency review status verification — 16 November 2026

Ticket: [#74](https://github.com/haideearus/cypress-realworld-app/issues/74).
Base: `7a16c12dc22b934026bae8ab5fd74ff4fc95b956`.

## Change

Dependency assessment now calls the existing `Controller.gate` after committing
its validated review outcome. The checker reads the durable ledger and current
PR head; assessment exposes `reviewed: true` only when both the review verdict
and the checker pass. Only the trusted assessment job gains `checks: write`.
The model job, required native checks and clean mergeability remain unchanged.

## Failing-before evidence

Using Node 22.20.0, added regressions and ran:

```text
node --test scripts/tests/factory-dependencies.test.cjs
# tests 24
# pass 19
# fail 5
```

The base implementation did not publish the success, blocked or changed-head
check, did not reject a failed publication, and lacked the assessor permission.
The invalid-artifact protection already passed. This run used only an in-memory
GitHub/ledger fixture; it did not invoke Claude or modify GitHub.

## Passing-after evidence

After the fix and an additional unavailable-proof regression:

```text
node --test scripts/tests/factory-dependencies.test.cjs
# tests 25
# pass 25
# fail 0

yarn test:factory
# tests 575
# pass 565
# fail 0
# skipped 10

yarn lint
All matched files use Prettier code style!
```

The focused tests prove assessment commits before publication, publication does
not write the ledger, blocked/invalid/changed-head/unavailable proof cannot pass,
and publication errors retain the finished grant, approval and consumed review.
Metadata-only recovery preserves the entire committed state. Permission tests
assert only assessment gains checks write and the model retains read-only scopes.
The ten full-suite skips are the existing optional/platform integration checks;
cloud CI must still run its supported integration checks after the PR opens.

No application code, dependency versions or package locks changed. No production
test, Claude workflow, live dependency trial, merge or deployment was run as part
of local verification. These simulated checks do not satisfy the required fresh
Claude Pro independent review before merge.

## Live controls

Read-only checks before and after implementation confirmed all three factory
switches false, the durable stop active and no reserved grant or active ticket.
Ledger commit `0b739cac1d799320ed742750753df2f0dc9787a1` is unchanged. SHA-256
comparisons of repository variables and the full `main` branch-protection response
also match. No counter reset, approval rewrite or new factory reservation occurred.

A fresh local Codex reviewer found no critical, important or minor findings and
independently passed the same focused and full factory suites using its locally
available Node 24.15.0. The implementer verification above used pinned Node
22.20.0. This local review did not start a Claude session or satisfy the separate
subscription-review gate.

## Operational limit

GitHub check publication can still fail or take time to appear. Assessment stops
on publication errors while retaining the valid review outcome and its usage.
Use the existing metadata-only gate refresh rather than spending another review;
subsequent merge recovery must revalidate the normal protected merge conditions.
No live dependency trial is claimed by this preparation record.
