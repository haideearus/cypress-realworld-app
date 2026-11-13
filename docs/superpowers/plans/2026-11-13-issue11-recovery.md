# Issue #11 Recovery Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. Do not start a model or independent reviewer during preparation.

**Goal:** Prepare one owner-only recovery of issue #11 with clearer command guidance and intact failed-attempt history.

**Architecture:** A pure recovery validator scopes the optional ledger extension to the exact approved case. Policy reserves a separately tagged third code grant only for explicit recovery. Existing controller/cycle/worker boundaries enforce the same publication and review process.

**Tech Stack:** Node 22.20.0, Yarn 1.22.22, node:test, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-13-issue11-recovery-design.md`, maintenance #18 and the owner request.

## Global constraints

Keep factory false, live ledger untouched, no inference/reviewer/paid AI API,
merge or deploy. Preserve all permissions and normal work caps, source criteria
and the two failed grants. Scope one extra code attempt to issue #11 only.

## Review focus

- Forged, stale or replayed recovery data must not grant another ticket authority.
- Unknown recovery flags must be refused rather than becoming ordinary requests.
- Third-attempt publication and review must work without enabling attempt four.
- Disabled/lowered settings and orphaned publication checks must remain effective.
- Worker guidance must match unchanged actual CLI preapprovals, not broaden them.

## Task: implement the combined recovery

**Files:** new `scripts/factory/recovery.cjs`; policy/controller/worker;
manual factory-agents workflow; recovery fixtures/tests; existing worker/workflow
tests; current owner guide; this spec/plan.

- [x] Reproduce policy gaps with a frozen real-shaped fixture: one baseline pass
      and seven expected recovery failures before implementation.
- [x] Add controller, worker-context and workflow contract tests; observe failures.
- [x] Implement the pure exact-history validator and consumed recovery marker;
      integrate reservation and preflight without changing normal quotas.
- [x] Wire explicit owner recovery to current main and existing cycle; add trusted
      command/test guidance with byte-for-byte unchanged permission arguments.
- [x] Run the full factory suite, lint, formatting, actionlint and appropriate
      type/app checks; inspect the whole diff and audit decisions.
- [ ] Commit and open one draft PR against this fork's main; follow ordinary CI.
      Genuine independent review stays pending until separately authorized.

Baseline: 80 passed, zero failed, one Windows symlink skip. Source base:
`508d13f0bc358ee3d8a288dae2c112b236903c4c`. Existing checkout and dedicated
branch `agent/18-issue11-recovery`; no extra worktree.

Initial full RED: 79 passes, 12 expected failures, one Windows skip (92 tests).
Final local factory suite: 95 passes, zero failures, one Windows symlink skip
(96 tests). Added dispatch/cancellation/current-checkout coverage after the
initial RED. The real-checkout test exposed a hardcoded main SHA in the synthetic
GitHub fixture; an explicit failing assertion preceded correcting that fixture
to use its branch map. No production workaround was needed.

Lint, targeted formatting, actionlint on six workflows and whitespace checks
passed. Both roles' generated CLI argument strings were compared with the
unchanged baseline worker and were byte-for-byte equal. Type/app suites and
Linux symlink coverage follow in ordinary CI.

Author inspection covers case provenance, preserved history, marker/tag binding,
lower-budget stops, replay refusal, the fourth-attempt guard, publication/review
continuity and the unchanged credential/tool boundary. It is not independent
approval; no new reviewer or inference run is started during preparation.
