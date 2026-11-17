# Two Active Tickets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Follow checkbox steps and retain independent review evidence.

**Goal:** Safely support two executing tickets without changing live concurrency during development.

**Architecture:** Add a versioned active-ticket adapter and stopped/idle CAS migration. Existing v1 state stays usable at concurrency one until migration; all lanes share the v2 capacity map, while metadata/merge/deployment writes retain their serializers.

**Tech Stack:** Existing CommonJS policy/controller, GitHub ledger CAS and Node test runner.

**Spec:** [Approved design](../specs/2026-11-17-event-pickup-and-notifications-design.md), especially Two active tickets.

## Global Constraints

All [master constraints](2026-11-17-factory-expansion.md#global-constraints) apply: active ceiling two, daily twenty, no paid API/model dispatch during implementation, no history reset, no live migration without later authorization. Monitor registry `active` remains an incident pointer.

## Review Focus

Mixed v1/v2 state, simultaneous third admission, cross-ticket completion, ambiguous merge ownership and partial emergency stop each receive explicit tests below.

## File structure

- Create `scripts/factory/active-tickets.cjs`: pure v1/v2 active-entry operations.
- Create `scripts/factory/concurrency-migration.cjs`: owner preview/execute migration with exact expected commit.
- Modify `github.cjs` ledger validation, `policy.cjs`, `controller.cjs`, `dependency-policy.cjs`, `dependencies.cjs`, `automation.cjs`, `merge.cjs`, `stop.cjs`, `quarantine.cjs`, `recovery.cjs`, and usage-ledger checks in `monitor-drill.cjs`/`monitor-recovery.cjs` under `scripts/factory/`.
- Modify automatic/dependency workflow-level concurrency; keep metadata `factory-ledger`, shared `factory-auto-merge` and production deployment serializers.
- Create `scripts/tests/factory-concurrency.test.cjs` and `factory-concurrency-migration.test.cjs`; extend affected existing policy/controller/stop/recovery/merge/workflow fixtures and tests.

### Task 1: Active entries and atomic capacity

**Interfaces:** `activeEntries(state) -> Entry[]`, `activeFor(state, ticket) -> Entry|null`, `claimActive(state, entry, limit) -> State`, `releaseActive(state, {ticket, runId, runAttempt}) -> State`. Entry is exactly `{ticket, runId, runAttempt}`. V2 uses `activeTickets` keyed by ticket and forbids a simultaneous legacy `active`; v1 remains readable at capacity one.

- [ ] Write tests named `v1 remains capacity one`, `two distinct v2 claims fit`, `third claim is rejected`, `duplicate ticket cannot claim twice`, `mixed schemas are rejected` and `release A preserves B`, with exact limits 1 and 2 and a rejected value 3.
- [ ] Run `node --test scripts/tests/factory-concurrency.test.cjs`; record the actual missing-feature failure before implementation.
- [ ] Implement the pure adapter, dual-version validation and reserve/finish integration. CAS retries must reread capacity/daily admission; never overwrite another active entry from a stale snapshot.
- [ ] Run the new tests plus `node --test scripts/tests/factory-policy.test.cjs scripts/tests/factory-controller.test.cjs scripts/tests/factory-dependency-policy.test.cjs`; require zero failures.
- [ ] Commit the independently testable adapter/policy change with its RED/GREEN evidence.

### Task 2: Routing and independent workers

**Interfaces:** Existing controller/merger methods use `activeFor` for their own ticket and preserve unrelated entries. Reservation grants still bind one phase/run/attempt/head. Terminal owner-review handoff releases its slot; executing automatic/dependency publication retains ownership until finalization.

- [ ] Add tests for app plus dependency, two app parents, owner review plus discovery-compatible placeholder, cancellation of only A, and completion while B is reserved. The same ticket cannot execute code/review concurrently.
- [ ] Run affected controller/dependency/automatic/workflow tests and preserve the failing singleton assumptions.
- [ ] Replace usage-ledger singleton reads with the adapter; do not replace monitor-registry incident pointers. Remove whole-lane worker serialization while retaining metadata job serialization and the authoritative capacity guard.
- [ ] Verify isolated run workspaces/services and same-ticket duplicate rejection with deterministic fixtures. Run `yarn test:factory`; require zero failures, including automatic, dependency and workflow tests.
- [ ] Commit routing/workflow changes without modifying live variables or running models.

### Task 3: Stop, merge ownership and migration

**Interfaces:** `previewMigration(state) -> {eligible, reasons, beforeDigest, afterDigest}`; `migrateConcurrency({api, actor, expectedCommit, execute:false}) -> Receipt`. Execute requires owner, all switches false, durable stop, no active entries/reserved grants/executable parents and matching ledger commit. Existing merge intents retain per-ticket ownership plus one global merge writer.

- [ ] Add migration refusal tests for active A/B, a reserved grant, switches true, stale commit and mixed schema. Verify tickets/grants/days/approvals are byte-equivalent after migration and audit only appends its migration receipt.
- [ ] Add two-parent stop tests, partial cancellation failure, terminal A with running B, unchanged quarantine case, simultaneous merge requests and main advancing before second merge. A partial stop must retain unresolved entries and durable stop.
- [ ] Run new migration and affected stop/merge/quarantine/recovery/drill tests, record RED, then implement migration and all ownership-specific cleanup.
- [ ] Run `yarn test:factory`, formatting and source secret scan; fix failures without resetting fixtures to conceal broken invariants. Document how an owner later previews/migrates/resumes and why setting 2 before migration is rejected.
- [ ] Commit and prepare PR 1 against current main. Require native CI and authorized independent review; no live migration is part of PR preparation.
