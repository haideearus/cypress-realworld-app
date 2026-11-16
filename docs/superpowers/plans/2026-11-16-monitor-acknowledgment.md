# Monitor acknowledgment implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task by task. Steps use checkbox syntax.

**Goal:** Let the owner acknowledge an unadmitted recovered standard monitor incident without claiming an AI repair.

**Architecture:** Separate owner-only manual workflow, bounded report and durable intent/confirmation transaction. Preserve the ordinary monitor and repair evidence formats.

**Tech stack:** Existing Node 22 CommonJS, node:test, GitHub Actions and pinned scanner; no new dependency.

**Spec:** `docs/superpowers/specs/2026-11-16-recovered-monitor-acknowledgment-design.md`.

## Global constraints

- Three agent switches false, stop active; no Claude, live checks, #65 mutation or paid APIs during preparation.
- Preserve history, original receipts, limits, counters and branch protection.
- New workflow first attempt, owner/main only, preview default true, eight-minute standard Linux runner.
- Only unadmitted standard incidents; fresh same-release evidence, no contract/drill/repair substitution.

## Review focus

- A lost final write must not clear a new active incident on retry.
- A stopped ledger or target can change after initial verification; recheck before writes.
- Ordinary report validation must reject the distinct acknowledgment report.
- Expired evidence or different releases must hold closure.
- An acknowledgment must never become an automatic admission or repair approval.

## Task 1: Evidence contract and transaction

Files: new `scripts/factory/monitor-ack-contract.cjs`, `monitor-ack.cjs`; tests `scripts/tests/factory-monitor-ack.test.cjs` and a dedicated fixture helper.

Interfaces: `acknowledge({api,context,settings,issueNumber,dryRun,report,store,ledger,probe,now})`; report/record validation from the contract module.

- [x] Write failure-first tests for read-only preview, intent/close/confirm ordering, owner/stop/admission/contract guards and ambiguous-response recovery.
- [x] Run `node --test scripts/tests/factory-monitor-ack.test.cjs`; confirm missing feature failures.
- [x] Implement bounded validation and transaction. Revalidate identity and stopped ledger before each mutation; preserve immutable intent when reconciling.
- [x] Run the same tests; expect all pass.

## Task 2: Checker, registry integration and refusal paths

Files: new `scripts/factory/monitor-ack-probe.cjs`; modify the probe's pure exports, monitor-state/origin/recovery/observe hooks; tests `factory-monitor-ack-probe.test.cjs` plus transaction regression tests.

Interfaces: `probeAckJourney(options)` returns standard check enums and bracketing release SHAs. Use a distinct current-run report at the existing bounded report path; scanner works on that file without schema relaxation.

- [x] Write and run regressions for mixed releases, no contract request/cookie leakage, stale reports, pending acknowledgments, repair/admission refusal and idempotency with a newer incident.
- [x] Implement seven six-second request windows per round and existing three-round retry bound; separate checker and publisher credentials.
- [x] Extend registry validation with a mutually exclusive acknowledgment record. Existing repair proof must reject it; normal ticks hold pending acknowledgment.
- [x] Run acknowledgment and existing monitor suites; expect all pass.

## Task 3: Workflow, documentation and integration

Files: new `.github/workflows/factory-monitor-acknowledge.yml`, operator guide and verification record; workflow tests.

Interfaces: manual inputs `issue` and `dry_run`; checker -> scanner -> publisher, trusted variables snapshot, pinned source/actions and shared monitor/ledger concurrency.

- [x] Test workflow guards, preview default, scopes, credential split, unchanged timeout and no model/deploy secrets.
- [x] Implement workflow and operator guide. Preparation is not authorization to execute it.
- [x] Run full factory suite, relevant probe/report regressions, formatting, workflow validation and secret scan.
- [x] Get a fresh local independent code review and address important findings.

Delivery: commit/push and open a draft owner PR linked to #66. Do not invoke Claude or merge.

## Execution record

Native execution authorized with the implementation request. Baseline: 70 monitor tests passed. Task 1 -> Task 2 share record/report validators; Task 2 -> Task 3 share CLI/environment names and report path. Keep those interfaces explicit. No additional implementation approval checkpoint is needed.

Tasks 1/2: core, probe, evidence and integration regressions went from expected
failure to green. Task 3: 23 new tests passed; final full suite 534 passed, 10
optional integration skips, zero failures. Lint, pinned actionlint and source
secret scan passed. The local independent review found one Important deadline
interaction, reproduced and fixed with a failure-first ordering regression.

Ruling: public availability must finish before the first metadata API request,
so its separately budgeted 152 seconds cannot consume the shared 60-second
publication deadline. Report freshness is rechecked after availability and before
intent/closure/final writes. The reviewer independently confirmed the fix with
152 seconds of simulated availability and reported no remaining findings.
