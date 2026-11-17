# Verified Discovery Finding Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Live finding/repair acceptance requires separate owner authorization.

**Goal:** Publish reproducible new bugs once, route them into ordinary repairs and retain truthful closure and notifications.

**Architecture:** A trusted publisher accepts plan 3 verified findings, applies lifetime deduplication and durable publication caps, then issues receipt-backed tickets. Intake replays current main before model admission, preserving original RED evidence and existing independent-review/production gates.

**Tech Stack:** Existing GitHub issue/ledger CAS, discovery evidence, event wake, activity journal and protected repair pipeline.

**Spec:** [Approved design](../specs/2026-11-17-event-pickup-and-notifications-design.md), evidence and route-findings sections.

## Global Constraints

All [master constraints](2026-11-17-factory-expansion.md#global-constraints) apply. Four new findings/day, two/source sweep; repairs each use their own ticket within twenty admissions and one of two execution slots. No speculative automatic ticket or fake approval. Discovery and repair remain separate phases.

## Review Focus

Same bug across SHAs, ambiguous issue POST, midnight quota/stop, stale-main reproduction and a claimed fix unsupported by live-monitor coverage are tested explicitly.

## File structure

- Create `scripts/factory/discovery-publication.cjs`, `discovery-origin.cjs`, `discovery-intake.cjs` and finding schemas in the discovery contract/store.
- Modify automatic candidate intake, controller context/evidence, wake observer, activity publisher and discovery finalization; existing monitor proof remains a distinct source.
- Create `scripts/tests/factory-discovery-publication.test.cjs`, `factory-discovery-intake.test.cjs`, `factory-discovery-repair.test.cjs` and fixture-only integration evidence.

### Task 1: Deduplicated publication and deferred states

**Interfaces:** `fingerprintFinding({component,symptom,contract}) -> Hash`; `publishFinding({api,store,verifiedFinding,day}) -> PublicationReceipt`; `verifyDiscoveryIssue({api,issue}) -> VerifiedOrigin|null`. Schema binds source sweep, real finished discover grant, producer run/attempt/SHA, oracle/test/raw-output hashes and exact issue identity.

- [ ] Test four publications and rejected fifth/day, two/source maximum, duplicates across different SHAs, recurrence after resolved history and exact issue criteria/body binding. Updating an existing issue adds evidence in comments, never rewrites frozen admitted criteria.
- [ ] Test intent before POST, unknown response, existing matching issue and exhausted lookup bounds. Unknown publication retains its consumed intent/capacity until reconciled; no duplicate POST or issue swap.
- [ ] Test verified/held-stop/held-quota/publishing/published/duplicate/rejected/observed-resolved states across midnight. Already accepted pre-stop writes may finish but cannot admit a repair while stopped; interrupted grants cannot publish after resume.
- [ ] Run new publication tests for RED, then implement scanned typed tickets, durable daily cap and proof verifier. A label or bot identity without proof never grants eligibility. Wake through discovery producer completion, not a suppressed GITHUB_TOKEN issue event.
- [ ] Commit publication/verification plus precise activity entries; keep discovery opt-in false.

### Task 2: Current-head intake and ordinary repair

**Interfaces:** `replayForIntake({api,finding,currentMain}) -> CurrentHeadReceipt|Hold`; `admitDiscoveryRepair({issue,origin,replay,context}) -> ExistingRepairReservation`. Engineering bounds: at most two intake replays per finding/Bucharest day and eight total/day, each at most five minutes, regardless of new SHAs; no additional model session.

- [ ] Test main unchanged, main changed but bug persists, failure gone, broken reproducer, expired artifact, invented oracle and duplicate/forged discovery receipt. Preserve original discovery SHA/RED; record current-head replay separately.
- [ ] Test no admission when global budget/capacity/stop disallows work. A fixed-on-main candidate retires as observed resolved with evidence, not as a factory-authored repair. Replay caps hold visibly instead of looping across many heads.
- [ ] Run intake tests for RED; implement proof-backed candidate routing into the existing code/test/review/merge path. The coder must reproduce RED again before its own fix and prove GREEN; discovery output never satisfies the independent gate.
- [ ] Verify notifications distinguish sandbox reproduction, deployed release and actual live-monitor coverage. Preserve all existing coding/review/retry counters and named deployment approval.
- [ ] Run end-to-end offline seeded-defect fixtures, full factory tests, relevant app tests, format and source/artifact scans. Prepare PR 4 with exact-head native CI and authorized fresh review.

### Task 3: Later owner-authorized acceptance

- [ ] Preview all new flags, source/publication counters, concurrency state and current main before any live discovery. Retain already used attempts; never reset to make an acceptance run fit.
- [ ] Obtain specific authorization for fixture discovery and repair sessions using Claude Pro only. Demonstrate a real RED test, deduplicated finding, independent repair/review, protected merge and stop across two active parents; fixture evidence remains labelled and cannot pass production gates.
- [ ] Confirm actual email receipt for healthy/idle/held/discovery/review/deployment events and documented no-event silence limitations. No monitor widening or live-data mutation is implied.
- [ ] After sign-off, enable two discovery sessions/four findings per day and observe actual event/schedule execution with PC off. Continue approving each production deployment separately and archive sanitized evidence.
