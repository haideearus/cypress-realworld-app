# Gate Reporting Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. The owner forbids another Claude run; independent review waits for separate authorization.

**Goal:** Replace the unrecognized required report with a genuine fail-closed PR job in PR #19.

**Architecture:** A read-only native job loads trusted base policy and verifies
current-head ledger proof. The controller retains an informational API report
and requests one bounded refresh of only the failed native gate after approval.

**Tech Stack:** Node 22.20.0, existing CommonJS policy/ledger, GitHub Actions.

**Spec:** [Design](../specs/2026-11-13-gate-reporting-design.md).

## Constraints and review focus

- Keep the factory false, protection/limits intact, model and deployment idle.
- Never carry the old approval to the new commit.
- Test unavailable/forged/stale proof and changed/closed/outside PRs.
- Test wrong workflow/event/head/PR/repository, cancellation, attempts and API failure.
- Confirm refresh does not mutate counters or launch CI/model workflows.

## Task 1: Native required gate and bounded refresh

- [x] Record baseline `yarn test:factory`.
- [x] Add failing tests in `scripts/tests/factory-gate-status.test.cjs` for the
      real inline verifier and refresh controller using existing GitHub fixtures.
- [x] Run the suite and preserve RED evidence.
- [x] Add `.github/workflows/factory-review-status.yml`,
      `scripts/factory/gate-report.cjs`, controller integration and fixed-workflow
      fixture routes. Accept empty successful refresh responses in the existing
      GitHub client. Limit privileged permission changes to gate refresh callers.
- [x] Run `yarn test:factory`; expected all tests pass apart from the known
      Windows symlink skip. Run lint, targeted formatting and workflow validation.
- [ ] Update the operating guide and PR evidence, commit and push the same branch.
- [ ] Observe live native gate failure for the newly unreviewed head and ordinary
      verify success. Confirm factory false, unchanged protection and live ledger.
- [ ] Stop before fresh independent review, merge, recovery or deployment.

## Local evidence

Baseline: 95 passed, zero failed, one Windows symlink skip (96 tests). The first
repair suite had eight expected failures (107 tests). Additional execution tests
reproduced the stdin entry not running and empty HTTP 201 being parsed as JSON;
each failed before its fix. Final suite: 108 passed, zero failed, one existing
Windows symlink skip (109 tests). Lint, targeted formatting, all seven workflows
under actionlint 1.7.12, and whitespace checks passed. Both roles retain identical
Claude CLI arguments. No live ledger write or provider request was involved.
