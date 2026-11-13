# Monitoring and allowance verification — 2026-11-13

Ticket: #33. Base: `54525bc837a1be222ea0c1bdc115d38b1e5889e0`.
Environment: Windows, Node 22.20.0, Yarn 1.22.22.

## Evidence

- Added monitor tests failed before their implementation (missing modules).
- New receipt integration tests initially failed five of six cases against the
  existing owner-only pipeline, then passed with the trusted monitor integration.
- Raising daily boundary tests to 20 initially failed against the old ceiling;
  the updated policy passes with usage/grants/history preserved and ticket 21
  rejected until the next Bucharest daily window.
- Separate local review found mutable latest-run lookup and an orphaned pending
  incident invariant. Both were corrected. The latter regression produced
  `Missing expected exception` before the fix; the final targeted 24-test suite
  and independent local re-review passed.
- Final `node --test scripts/tests/factory-*.test.cjs`: **319 tests, 318 passed,
  0 failed, 1 existing Windows symlink privilege skip**.
- `yarn lint`, `yarn types`, scoped Prettier checks, actionlint 1.7.12 and
  `git diff --check` passed.
- A real read-only probe of the fixed public endpoints returned:

  ```json
  {
    "healthy": true,
    "checks": { "health": "ok", "readiness": "ok", "frontend": "ok" },
    "attempts": 3,
    "release": "54525bc837a1be222ea0c1bdc115d38b1e5889e0"
  }
  ```

- Read-only GitHub API inspection confirmed the attempt-specific run endpoint
  returns the repository, actor, workflow path, commit and attempt fields used by
  provenance validation. A real monitor receipt has not yet been produced.

## Scope and rollout

All three live factory switches were verified false. Daily variable remained 10;
no variable or secret was changed, no Claude session was started, no AI provider
API was called, and no production data was written. The higher ceiling is code
prepared for review, not an already-active repository allowance.

Local transport fixtures exercise registry writes, publication ambiguity,
deduplication, receipt validation, admission, independent-review records and
protected merge behavior. They do not constitute a genuine Claude review or
proof of a live unattended incident cycle. Those remain separate rollout steps.

The monitor has no live failure-injection mode. It does not automatically resolve
provider incidents or close recovered issues; the owner assesses evidence before
closure. Generic recovery and the final PC-off trial remain unfinished.
