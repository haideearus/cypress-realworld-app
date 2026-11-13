# Cloud monitor repair rehearsal implementation plan

**Goal:** Prepare a reviewed, default-preview cloud rehearsal with one bounded
Claude subscription repair and measured isolated recovery, without running it.

**Architecture:** A dedicated coordinator creates a temporary fixture commit and
drill monitor incident, then reserves a drill-only grant in the existing ledger.
The existing model workflow uses narrower file-only capabilities. An independent
container verifier measures the repair; a trusted finalizer records recovery.

**Tech stack:** Node 22.20.0 CommonJS, node:test, GitHub Actions, Docker.

**Spec:** `docs/superpowers/specs/2026-11-14-cloud-monitor-repair-drill-design.md`

## Global constraints

- Owner-only dispatch on main, attempt 1; preview default; no schedule.
- One coding invocation, no AI review/retry/publication/merge/deployment in drill.
- Existing subscription credential only; existing limits and four switches unchanged.
- Separate drill registry/branch/label; no production fault or data changes.
- Generated code executes only in a credential-free, network-disabled sandbox.
- Installation PR remains draft pending genuine independent Claude Pro review.

## Tasks and interfaces

### 1. Restrict drill ledger grants and worker capabilities

- [x] Add negative tests first for wrong context, repeated reservation, normal
      admission/publication/review, forged completion and shell tools.
- [x] Add `drill-contract.cjs`: fixed workflow ref, fixture paths, context and
      provenance validation. Provenance fields: `runId`, `runAttempt`, `workflowRef`,
      `workflowSha`, `seedSha`, `incidentId`.
- [x] Extend policy with explicit `origin: drill`, one code grant at slot `drill`,
      zero reviews/retries, terminal `drill_complete` without PR/approval. Reject
      reclassification or another reservation. Preserve normal cancellation.
- [x] Controller rejects drill label/title/registry receipts even before admission.
      Worker derives file-only prompt/tools from verified ledger origin.
- [x] Run focused policy/controller/worker tests and existing regressions.

### 2. Reuse monitor transitions with fixed namespaces

- [x] Add namespace and shared-transition tests first.
- [x] Extract `observeIncident({api,context,store,observation,now,issueText,labels})`;
      production entrypoint retains all current identity/probe/switch guards.
- [x] `new MonitorStore(api, namespace = "production")` accepts only production
      or drill, mapping to `factory/monitor` or `factory/monitor-drill`.
- [x] Prove production behavior, deduplication and publication-failure semantics.

### 3. Provide the fixture and independent sandbox verifier

- [x] Add failing tests for extra-file artifacts, failed probes, command bounds,
      process/credential isolation and forged report fields.
- [x] `drill-fixture.cjs` exports fixed paths, broken source, seeded regression
      and server/oracle files. A readiness contract defect is the only seeded fault.
- [x] `drill-sandbox.cjs` exports `checkFixture(source, {release, ...deps})`, using
      a pinned Node container, network none, readonly filesystem, resource limits,
      nonprivileged candidate and separate trusted oracle. Return sanitized observations.
- [x] `drill-verify.cjs` validates bundle identity and exactly one fixed regular
      implementation file, measures baseline then candidate, and writes a report
      bound to run, grant, seed SHA and bundle digest outside the sandbox.
- [x] Add a non-AI Linux container integration test to CI; run local transport and
      negative tests. Do not represent a skipped Windows Docker test as executed.

### 4. Coordinate the rehearsal and finalization

- [x] Write controller transport tests for preview/disabled/error/success paths.
- [x] Add `monitor-drill.cjs` operations: preview, seed, observe/reserve, finalize.
      Exact context guard; available budget checks; immutable receipt before writes;
      unique branch; no automatic retry after ambiguous external writes.
- [x] Workflow `factory-monitor-drill.yml`: preview/prepare, one model call,
      unprivileged verification, trusted finalization, bounded evidence artifact.
      90-second shutdown window; re-read live variables afterward through a separate
      trusted job using fresh `vars`. No runtime variable mutations.
- [x] Finalizer checks exact incident/issue/run/grant/head/report, terminal model
      job and trusted successful verification job before recovery. Preserve counters
      and historical evidence; failed/uncertain paths never claim recovery.

### 5. Integration, documentation and PR

- [x] Add operator runbook covering separate installation review, preview, live
      switch prerequisites, shutdown window, results, failed/cancelled recovery and
      exact limits of the evidence.
- [x] Run factory suite, lint, types, formatting, actionlint and diff checks.
- [x] Fresh-context branch review; address substantive findings and rerun affected
      checks. Capture test counts and any environment-limited checks honestly.
- [ ] Push only this feature branch and open a draft PR for issue #35. Read back
      current switches to confirm no changes. Do not dispatch any model or rehearsal.

## Review focus

- Mutable variables between preview, wait, reservation and worker preparation.
- Ambiguous issue/ref writes must retain evidence and never duplicate a grant.
- Candidate code must not write trusted reports or execute in model-credential job.
- Failure/cancellation must not release a still-running worker's reservation.
- Drill receipts and terminal states must never satisfy production approval gates.

## Execution record

Design approved by the owner on 2026-11-14. Dedicated branch starts at `eda1359`.
Independent tasks have disjoint file ownership; root integrates coordinator,
workflow and evidence. No live rehearsal or subscription review is authorized in
this implementation turn.
