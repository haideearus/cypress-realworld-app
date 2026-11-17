# Proactive Discovery Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Discovery remains disabled until a later authorized rollout.

**Goal:** Run bounded Claude Pro code inspection and exploratory tests against an isolated disposable app, producing candidate evidence without publishing repairs.

**Architecture:** A new discovery source/phase reserves the existing ledger/capacity budget. A restricted model writes only test proposals and reports; a trusted executor runs generated tests inside a credential-free internal container network and a separate validator replays supported failures.

**Tech Stack:** Existing Claude OAuth worker isolation, GitHub-hosted runners, pinned Docker, Vitest, Node API tests and Cypress without Cloud recording.

**Spec:** [Approved design](../specs/2026-11-17-event-pickup-and-notifications-design.md), proactive testing sections.

## Global Constraints

All [master constraints](2026-11-17-factory-expansion.md#global-constraints) apply. Two discovery sessions/day, four new bug tickets/day, two findings/sweep, four test batches/sweep, five minutes/batch, at most 200 turns/30 model minutes, one slot per sweep within two shared slots. `FACTORY_DISCOVERY_ENABLED` defaults false. No production data or additional provider access.

## Review Focus

Daily rollover/duplicate CI signals, discovery bypassing the twenty-ticket budget, generated tests reading host credentials, unsupported test oracles and stop after uncertain publication are pinned in tasks below and finding intake.

## File structure

- Create `scripts/factory/discovery-contract.cjs`, `discovery-policy.cjs`, `discovery-store.cjs`, `discovery-run.cjs`, `discovery-sandbox.cjs`, `discovery-evidence.cjs`, `discovery-oracles.cjs`, and `scripts/factory/discovery/Dockerfile`.
- Create `.github/workflows/factory-discovery.yml`; adapt policy/worker/artifact/stop contracts for the exact new source and phase, plus activity observer allowlists.
- Create `scripts/tests/factory-discovery-policy.test.cjs`, `factory-discovery-sandbox.test.cjs`, `factory-discovery-evidence.test.cjs`, `factory-discovery-workflow.test.cjs` and disposable fixtures under `scripts/tests/helpers/`.

### Task 1: Daily sweep source and metered discover grant

**Interfaces:** `selectSweep({state,context,head,day,charter}) -> Decision`; `reserveSweep(state, request, config) -> {state,grant}`; `finishSweep(state, grantId, outcome) -> State`. Origin is `discovery-sweep`, phase `discover`; each unique source issue can reserve once and is never factory-ready. A separate versioned discovery registry retains source/publication intents and daily discovery counters.

- [ ] Test two accepted discovery grants and a rejected third in one Bucharest day, globally exhausted twenty admissions, duplicate main-CI delivery, two distinct charters on unchanged source and both active slots already occupied.
- [ ] Test interrupted/provider-rejected/invalid output attempts remain consumed, a second day does not refund a source, and an uncertain source-issue POST is reconciled rather than repeated. Existing code/review grant limits stay unchanged.
- [ ] Run discovery policy/workflow tests for RED, then implement current-tested-main validation and the narrow new source/phase across reservation, worker and artifact validators. Preserve actual parent/actor identity; no general free discovery call.
- [ ] Implement manual guarded request, successful new-main CI wake and fallback 03:12/15:12 Europe/Bucharest. Prefer eligible repairs, never preempt active work and do not guarantee timer delivery. Emit typed activity events.
- [ ] Run policy/controller/stop compatibility tests; commit with discovery opt-in false and no live source issue/model creation.

### Task 2: Test-only model and isolated executor

**Interfaces:** `prepareDiscovery({head,grant,charter}) -> Context`; `runDiscoveryBatch({trustedRoot,requestFile,grant}) -> BatchReceipt`; `collectDiscovery({head,grant,output}) -> CandidateReport`. Requests identify only approved unit/API/Cypress modes and validated test artifacts, never shell fragments or arbitrary URLs.

- [ ] Add failing tests for application/config/lockfile writes, symlink/traversal artifacts, inherited model/GitHub/deploy/database credentials, public-network access, host networking/socket mounts, fifth batch and over-five-minute batch.
- [ ] Implement immutable source plus writable output, isolated internal app/test/database containers, explicit environment allowlists and fixed command templates. Install pinned browsers/packages before model credentials exist; missing isolation holds rather than uses the host/live app.
- [ ] Give the model source reads and output-area writes plus only the fixed trusted batch helper; do not expose arbitrary shell, MCP, network, GitHub publication or production credentials. Retain sanitized results/screenshots for iterative scenario refinement.
- [ ] Run offline Docker-backed sandbox tests using fixture code only, including synthetic reseeding and rejected production destinations. Verify container/app/source identity and enforce outer bounded baseline/model/replay job times.
- [ ] Commit restricted execution with evidence that source stayed unchanged; no actual Claude discovery is needed to test isolation.

### Task 3: Reproduction evidence and output correctness

**Interfaces:** `validateCandidateReport(report, identity) -> CandidateReport`; `verifyReproducer({head,testArtifact,oracle}) -> VerifiedFinding|Hold`. A versioned trusted oracle catalog initially recognizes unhandled app exceptions, unexpected server errors, existing response/validation contracts and synthetic-account isolation failures. Free-form model expectations remain triage-only.

- [ ] Test genuine deterministic failure twice after fresh data resets, a fabricated assertion, flaky timing, startup/download failure, existing baseline failure and a zero-finding report. None may be labelled a verified repair or passing independent review.
- [ ] Implement strict test/report bounds, canonical source/artifact hashes, secret scanning, exact command/spec/input/output receipts and immutable raw RED evidence. Keep candidate count at most two; preserve actually checked/skipped coverage in zero/partial reports.
- [ ] Validate in a separate trusted replay job with no model token. Report uncertain or unsupported oracles for owner triage, with no factory-ready publication. Expose verified candidates through `VerifiedFinding` for plan 4.
- [ ] Add a discovery parent to emergency-stop inventory and prove two simultaneous parent cancellation/cleanup; an interrupted discovery grant cannot later publish. Run full factory/format/source scans, then prepare PR 3 for native CI and authorized genuine review.
