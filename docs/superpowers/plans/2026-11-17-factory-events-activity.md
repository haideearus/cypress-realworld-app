# Event Pickup and Full Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Implement task by task after the concurrency foundation is merged.

**Goal:** Wake eligible work from trusted GitHub events and report complete factory activity without a new provider.

**Architecture:** A main-only metadata bridge issues durable wake receipts and explicit dispatches; receivers validate actual actor/source identity before normal admission. A separate typed activity publisher uses GitHub issue notifications and never starts a model.

**Tech Stack:** Existing GitHub Actions/GITHUB_TOKEN, CommonJS validators/CAS stores and Node tests.

**Spec:** [Approved design](../specs/2026-11-17-event-pickup-and-notifications-design.md), event and email sections.

## Global Constraints

All [master constraints](2026-11-17-factory-expansion.md#global-constraints) apply. New `FACTORY_EVENT_PICKUP_ENABLED` and `FACTORY_ACTIVITY_LOG_ENABLED` default false; `FACTORY_ACTIVITY_ISSUE_NUMBER` must name the approved unlabelled journal. Keep twenty daily tickets and two execution slots; no live dispatch/model run during implementation.

## Review Focus

Early receiver versus unacknowledged intent, forged actor/source, GITHUB_TOKEN-suppressed monitor issue, idle completion recursion and notification/inbox mismatch are pinned below.

## File structure

- Create `scripts/factory/wake-contract.cjs`, `wake-store.cjs`, `wake-controller.cjs`, `trusted-wake.cjs` and `.github/workflows/factory-wake.yml`.
- Modify existing automatic/dependency workflow inputs plus policy/controller/worker/automatic/dependency/merge provenance checks; preserve manual owner paths.
- Create `scripts/factory/activity-contract.cjs`, `activity-store.cjs`, `activity.cjs` and `.github/workflows/factory-activity.yml`; integrate trusted phase events with controllers/model workflows/stop reporting.
- Create `scripts/tests/factory-wake.test.cjs`, `factory-wake-workflow.test.cjs`, `factory-activity.test.cjs`, `factory-activity-workflow.test.cjs`; extend existing provenance/gate/stop tests.

### Task 1: Receipts and trusted receiver identity

**Interfaces:** `classifySignal({api,event,context}) -> Signal|null`; `createWake({signal,lane,producer}) -> Receipt`; `verifyWake({api,context,receiptId,lane}) -> Provenance`; `WakeStore.read/update` uses a versioned `factory/wakes` branch with CAS. Signals/receipts contain typed IDs, attempts, heads and immutable producer identity; never free-text instructions.

- [ ] Write tests for correct owner/monitor/Dependabot sources and rejection of fork, wrong workflow SHA/path, unrelated bot, stale head and edited admitted criteria. Prove only `github-actions[bot]` plus complete valid receipt can use the new dispatch path.
- [ ] Add tests for intent recorded before POST, receiver arriving before acknowledgment, CAS binding only one receiver, duplicate source and uncertain dispatch reconciliation. A failed or cancelled producer cannot supply a later new reservation.
- [ ] Run `node --test scripts/tests/factory-wake.test.cjs`, record RED, then implement strict schemas/store/verification. Keep unresolved intents; registry saturation holds rather than deletes replay identities.
- [ ] Run provenance tests across policy/controller/worker/dependency/merge. Retain actual actors in audit; do not substitute the owner name to satisfy old validators.
- [ ] Commit the receipt/provenance unit with tests before wiring live event listeners.

### Task 2: Bridge and bounded queue drain

**Interfaces:** `handleWake({api,context,event,preview}) -> {lane,receiptId,outcome}` sends at most one fixed-workflow/main dispatch per receipt. Receivers keep the existing coordinator queue scan, capacity and current-head checks. Source workflows remain independently verifiable.

- [ ] Test owner issue events, verified monitor completion recovering a bot-created issue, successful exact-head Dependabot CI completion and lock-release drain after a real admitted run. Test that failed CI, unrelated owner harness CI, journal comments and idle completion never start models.
- [ ] Test two busy slots, a queued third eligible ticket, cancellation, duplicate events and a third-level observer boundary. Drain must not create an endless idle or workflow_run chain.
- [ ] Run wake/workflow tests for RED; implement main-only `factory-wake.yml`, strict helper checkout and dispatch inputs. Give the bridge only contents/actions write plus issue/PR reads; no Claude/App/deploy/database credentials.
- [ ] Verify stop/capacity/budget rechecks before admission, with flags absent/false leaving current behavior unchanged. Run new tests and the existing automatic/dependency/gate suites.
- [ ] Commit and retain the bridge's source-event/run/attempt receipts as evidence; do not dispatch a live receiver during preparation.

### Task 3: Full activity journal and emails

**Interfaces:** `buildActivityEvent({producer,kind,state,subject,head,summary,links}) -> ActivityEvent`; `publishActivity({api,event,journalIssue}) -> Receipt`. Use `factory/activity` CAS intents and a deterministic event marker in comments; reconcile uncertain POSTs by bounded comment lookup. If lookup cannot prove absence, hold rather than repeat.

- [ ] Test one entry for each monitor healthy/unhealthy check, idle/held queue, coding/review/discovery phase transition, CI result, review outcome, merge, deployment approval/start/result and stop/budget hold. No digest/sampling default; duplicate source events publish once.
- [ ] Test secret-bearing/oversize bodies, forged producers, malformed artifacts, notification self-events and a journal issue labelled factory-ready. Reject all; notification failure cannot fabricate review success or consume a model grant.
- [ ] Test stale-monitor warning at 90 minutes, deduplicated unchanged staleness and later recovery. Explicitly test/document that zero delivered GitHub events means no independent silence detector.
- [ ] Run activity tests for RED, then implement allowlisted producer observation and trusted per-phase events outside model-editable output. Use actions/contents read and issues write; add PR write only for actual PR comments. Label pre-model messages `starting`, not proof a model already executed.
- [ ] Verify settings instructions for Actions Email without failed-only, watching/participating/own activity and repository All Activity. Offline tests prove comment creation, not inbox delivery. Commit and document the later owner-confirmed harmless email test.

### Task 4: PR and opt-in rollout documentation

- [ ] Run `yarn test:factory`, formatting, source/body scanning and relevant type/lint checks; preserve actual RED/GREEN results and controls snapshots.
- [ ] Prepare focused PR 2, new flags false, no journal creation or live dispatch. Native CI and fresh owner-authorized Claude review are required.
- [ ] Document preview initialization, source/receiver proof, empty-queue behavior and rollback by disabling only new opt-ins. Do not reset counters or disable the existing factory as a side effect.
