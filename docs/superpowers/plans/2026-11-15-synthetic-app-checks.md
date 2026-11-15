# Synthetic-user app checks implementation plan

> For agentic workers: use executing-plans inline, with failure-first tests and
> one fresh whole-branch review at the end.

**Goal:** Detect signed-in API failures and reuse trusted maintenance tickets.
**Architecture:** Default-off bounded checker, scanned credential-free report,
existing trusted publisher and incident receipts. No dependency or live changes.
**Tech stack:** Node 22.20.0 CJS/fetch/node:test; existing Actions and scanner.
**Spec:** ../specs/2026-11-15-synthetic-app-checks-design.md

## Global constraints and review focus

Preserve all live switches/limits/stop/history. No Claude or authenticated
production execution. Only fixed-origin login/checkAuth/feed/logout requests;
login sessions are the sole product-side effect. Three attempts, five calls per
attempt, 10-second requests, 64-KiB bodies and two 30-second delays. Strict
current-run reports, secret separation and existing eight-minute workflow bound.

Review delayed/aborted login cleanup, cookie rotation/deletion and old-session
logout verification; stream/time bounds including noncooperative fetch; report
replacement/provenance/freshness; preview and disabled behavior; legacy/drill and
monitor-issue trust compatibility. Add tests in the owning task for these cases.

## Task 1: bounded API journey

Files: new scripts/factory/app-checks-probe.cjs and
scripts/tests/factory-app-checks-probe.test.cjs.
Produces probeUserJourney({username,password,fetch,sleep,attempts,requestTimeoutMs})
=> {healthy,checks:{login,session,feed,logout},attempts}; no response content.

- [ ] Write failing happy-path, contract, cleanup, endpoint and bound tests.
- [ ] Observe RED with node --test scripts/tests/factory-app-checks-probe.test.cjs.
- [ ] Implement fixed-origin probe and bounded cookie/body/request helpers.
- [ ] Run focused tests to GREEN, then commit.

## Task 2: private checker and public report boundary

Files: new app-checks-contract.cjs/app-checks.cjs in scripts/factory and
scripts/tests/factory-app-checks.test.cjs. Consumes Task 1 result. Produces
validateAppChecks, write/read report helpers and a default-off CLI; no credentials
are represented by the report. Validate monitor context before any operation.

- [ ] Write failing configuration, unrelated-secret, report identity/freshness,
      bounded regular-file, injection and disabled-path tests.
- [ ] Run the new suite RED, implement the strict boundary, run GREEN, commit.

## Task 3: monitor and workflow integration

Files: monitor.cjs, factory-monitor.yml; existing monitor/workflow/integration
tests. Publisher consumes only Task 2 current-run report through the fixed path.

- [ ] Add RED tests for optional appChecks health, sanitized deduplicated tickets,
      legacy/drill compatibility and per-step secret/token isolation.
- [ ] Add conditional checker/scanner steps; keep publisher step identity,
      schedule, permissions, preview default and incident caps unchanged.
- [ ] Validate/merge report only when the new flag is true. Keep disabled mode
      request-free and old availability-only mode intact. Run GREEN, commit.

## Task 4: real integration, documentation and delivery

Files: production-integration.test.cjs; docs/factory/APP-CHECKS.md,
PRODUCTION-MONITORING.md, docs/FACTORY.md. Real app test uses only disposable \_test
PG and a test transport mapping the immutable public-origin request to localhost.

- [ ] Add real app journey integration and assert origin/method/session contract.
- [ ] Run available integration and full factory checks, formatting, actionlint
      and source scanning. Record blocked checks honestly; ordinary CI runs PG.
- [ ] Document exactly one new variable/two secrets, default-off preview/rollout,
      existing emergency-stop state, no AI calls and API-only limitations.
- [ ] Request fresh local code review, fix material findings with RED/GREEN,
      push branch and open draft PR against this fork linked to #46.
- [ ] Observe normal CI and verify live configuration/history unchanged. Start
      no Claude review, authenticated production check, merge or deployment.
