# Monitor repair acceptance setup implementation plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution,
> with one fresh whole-branch review after implementation. No Claude workflow run.

**Goal:** Prepare a disabled pagination contract check and proof-based production
incident retirement in one PR for #63.

**Architecture:** Extend the existing credential-free app-check reports and monitor
receipts with an optional bound contract mode. A separate recovery verifier reads
ledger, merge, CI, deployment and approval metadata; the monitor persists close
intent and confirmation without editing ledger counters or invoking agents.

**Tech Stack:** Node 22.20.0 CommonJS, GitHub Actions, existing Express/PG test app.

**Spec:** [Approved design](../specs/2026-11-16-monitor-repair-acceptance-design.md).

## Global constraints

- All three switches false; preserve durable stop, monitoring settings and caps.
- No application fix, Claude call, paid API or live/prod test during preparation.
- No new dependency, provider key, production mutation or gate bypass.
- Read-only probes use the existing fixed origin and isolated account secrets.
- Rejected/ambiguous evidence never closes an incident or refunds allowance.

## Review focus

- A disabled or legacy probe cannot certify a contract incident's recovery.
- A similarly named or stale workflow cannot establish deployment approval.
- A lost issue-close response must not lose durable intent or duplicate issues.
- Closure cannot race an active grant or change original issue/usage history.
- Release-bound journeys plus metadata verification remain inside time budgets.

## Task 1: Confirm baseline and add the optional probe

Files: `scripts/factory/app-checks-probe.cjs`, `app-checks.cjs`,
`app-checks-budget.cjs`, `scripts/tests/factory-app-checks-probe.test.cjs` and budget
tests. Record local actual HTTP evidence outside the repository.

- [ ] Confirm authenticated limit-zero response on a disposable local test app.
- [ ] Write tests: default adds no request; enabled detects 200/null and accepts
      JSON 422 or coherent positive normalization; errors still log out safely.
- [ ] Run tests red; add `feedContract=false` option and bounded enum result.
- [ ] Use six-second request windows for the eight-request release-bound contract mode;
      assert both modes fit the existing job bound. Run tests green.

## Task 2: Bind reports, incidents and workflow mode

Files: `app-checks-contract.cjs`, `monitor-proof.cjs`, `monitor-state.cjs`,
`monitor.cjs`, `.github/workflows/factory-monitor.yml` and their existing tests.

Interfaces: result's optional `feedContract` is ok/failed; report v2 requires it;
incident/proof v2 requires `probeMode: feed-contract`. Standard v1 stays intact.

- [ ] Write red tests for version/profile substitution, immutable proof tampering,
      missing expected mode and preview override isolation.
- [ ] Implement validation and fixed issue reproduction details without raw data.
- [ ] Wire the default-false flag/preview input with existing credential boundaries.
- [ ] Run report/monitor/provenance tests and legacy/drill tests green.

## Task 3: Verify and retire repaired production incidents

Files: new `monitor-recovery-contract.cjs`, `monitor-recovery.cjs`,
`scripts/tests/factory-monitor-recovery.test.cjs`; monitor/state integration.

Interfaces: `verifyRepair({api,incident,issue,observation,context,now})` returns
bounded retirement evidence or refuses; `retireIncident(...)` persists intent,
closes/confirms exact issue and completes the receipt. No ledger writes.

- [ ] Write red tests using real ledger/store validation and strict API transports
      for valid repair and refusals (wrong head, grant, PR, workflow, CI, approval,
      release, criteria, mode, active work and malformed/paginated evidence).
- [ ] Verify source-run proof, actual merge and main CI, approved deployment jobs
      and exact live release, bounded to the publication phase.
- [ ] Add durable intent/confirmation tests including lost close/save replies,
      repeated observations, manually closed issues and counter preservation.
- [ ] Serialize production monitor control with the shared ledger job group;
      preserve independent isolated-drill retirement. Run focused suite green.

## Task 4: Verify, document and open one PR

- [ ] Run full factory suite, secret scan, workflow validation, types/lint, unit
      tests, production build and disposable integration appropriate to changes.
- [ ] Preserve RED/GREEN commands/results, actual baseline and limitations in
      `docs/factory/monitor-repair-acceptance-verification-2026-11-16.md`.
- [ ] Update app-check/monitor runbooks with exact preview and future trial steps.
- [ ] Review the complete branch in fresh context; resolve blocking findings with
      failure-first regression tests. This does not replace required Claude review.
- [ ] Verify false switches/unchanged pause and counters, then push branch and open
      a draft PR against this fork's main. Report CI and leave live work disabled.
