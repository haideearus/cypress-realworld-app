# Claude Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Prepare the first implementation PR for subscription-only Claude coding and independent review, with durable enforced limits and no real model calls during installation.

**Architecture:** GitHub Actions invokes trusted Node controllers, isolated Claude jobs, and separate publishers. An orphan `factory/state` branch stores reservations and outcomes using fast-forward updates. Two bounded coding/review cycles use the existing CI and publish a current-commit review gate.

**Tech Stack:** Node 22.20.0 CommonJS, node:test, GitHub REST, pinned GitHub Actions, Claude Code 2.1.322 with OAuth subscription authentication.

**Spec:** docs/superpowers/specs/2026-11-11-claude-factory-design.md (approved by owner).

## Global Constraints

- Keep FACTORY_ENABLED=false; do not read its secret or run real Claude.
- Use only CLAUDE_CODE_OAUTH_TOKEN, no paid API key/provider/fallback.
- Limits: 2 new tickets/day in Europe/Bucharest; 2 coding and 2 review invocations per ticket; 1 retry included in coding attempts; 1 active ticket; 15-minute model jobs; 20 turns.
- Preserve required verify, production application/data, and original license.
- Only trusted owner dispatches on main; no unrestricted mentions or public event triggers.
- Persist before invoking; refuse missing/corrupt state, stale reservations, and mismatched head commits.
- No production secrets or repository write token in model jobs.
- Work through ticket #6 and a PR against this fork; no merge or deployment.

## Review Focus

- GitHub rerun-failed-jobs reusing successful admission outputs must fail current-run-attempt preflight.
- Interrupted commits, compare/update races, and abandoned active tickets must never reset counters or overlap workers.
- Untrusted artifact paths, symlinks, malformed review output, and secret-like patch content must not reach a privileged publisher.
- CI dispatch association and current-head review must reject results from another commit/run.
- A skipped model job and test fixture approval must never become a genuine review gate pass.

## File structure

- scripts/factory/policy.cjs: typed configuration, admission, counters, reservations, review gate.
- scripts/factory/github.cjs: fixed-origin REST and compare/update ledger persistence.
- scripts/factory/artifacts.cjs: patch/file validation and review schema.
- scripts/factory/controller.cjs: trusted admission, publication, CI wait, review recording, cancellation.
- scripts/factory/worker.cjs: reservation preflight, isolated context/prompt, artifact collection.
- .github/workflows/factory-agents.yml: owner-only initialize/run/cancel entry point.
- .github/workflows/factory-cycle.yml: one coding/publication/CI/fresh-review cycle.
- .github/workflows/factory-model.yml: least-privilege reusable coding/review job.
- .github/workflows/factory-review-gate.yml: deterministic current-head gate, no model calls.
- .github/workflows/factory-pr-review.yml: bounded owner maintenance PR review using the same ledger and read-only role.
- .github/actions/factory-control/action.yml: trusted controller invocation shared by privileged jobs.
- scripts/tests/factory-\*.test.cjs: real policy, mock HTTP GitHub, temporary Git repos, and workflow contract tests.
- docs/CLAUDE-FACTORY.md: owner steps, limits, evidence, recovery, rollout boundaries.

### Task 1: Policy and durable reservations

**Interfaces:** `readConfig(vars)`, `emptyState(repo)`, `reserve(state,request,config,now)`, `preflight(state,grant,context,config)`, `finish(state,grant,outcome)`, `reviewGate(state,pr)`.

- [x] Write policy tests for disabled/config/auth refusal, Bucharest date boundaries, daily and lifetime caps, one active ticket, and rerun/stale-head rejection.
- [x] Run `node --test scripts/tests/factory-policy.test.cjs`; expect missing module/assertion failures before implementation.
- [x] Implement pure transitions, strict state validation, and exact grant identity; no network or secrets.
- [x] Run the policy tests; expect all passing. Commit policy and tests.

### Task 2: GitHub persistence and artifact boundaries

**Interfaces:** `GitHub.request(method,path,body)`, `Ledger.read()`, `Ledger.initialize()`, `Ledger.update(mutator)`; `validateChanges(files)`, `validateReview(result,head)`.

- [x] Add fake-HTTP GitHub tests for fixed origin, orphan initialization, CAS races, committed reservations, 403/corruption, and no implicit reset.
- [x] Add artifact tests using temporary Git repositories for regular-file allowlists, forbidden policy paths, binary/large changes, secret-like values, and strict current-head review output.
- [x] Run new tests; expect missing implementations.
- [x] Implement REST adapter, ledger, and artifact validation without executing model artifacts.
- [x] Run all factory tests; expect all passing. Commit task.

### Task 3: Trusted controller and isolated worker

**Interfaces:** controller operations `initialize`, `admit`, `publish`, `ci`, `review`, `assess`, `cancel`; worker operations `prepare`, `collect`.

- [x] Add tests showing a fixture ticket traverses reservations, patch publication, CI association, fresh review, and retry exhaustion without a provider call.
- [x] Cover stopped/failed workers, stale PR heads, canceled prior runs, missing artifacts, and rejected patches consuming their reservations.
- [x] Run new tests; expect missing controller/worker behavior.
- [x] Implement trusted operations, exact run/head binding, fresh prompts, and artifacts with no credentials.
- [x] Run all factory tests; expect all passing. Commit task.

### Task 4: Disabled workflows and tool pins

**Interfaces:** reusable workflows pass grant IDs and cycle slots; only model steps receive the OAuth secret; jobs return plain ready/head/PR/retry outputs.

- [x] Add workflow contract tests that parse actual YAML for permissions, real enabled guards, timeouts, immutable actions, no API keys/deploy secrets, and no public mention triggers.
- [x] Run contracts before workflow files exist; expect failures.
- [x] Add the pinned action (which installs CLI 2.1.322), reusable model/cycle jobs, entry point and deterministic review gate.
- [x] Add `test:factory` to package scripts and existing CI, without removing any checks.
- [x] Run factory tests, YAML validation/actionlint where available, lint/types/unit/build and applicable production checks. No real model invocation.
- [x] Commit workflow deliverable.

### Task 5: Evidence, fresh review and PR

- [x] Document exact owner steps: merge bootstrap PR, initialize state while disabled, verify blocked runs, add review check in documented order, and defer enable/demo to a later owner decision.
- [x] Record RED/GREEN evidence, what was simulated, and outstanding GitHub permissions/real-model validation.
- [x] Run final checks and obtain a fresh-context whole-branch review, fixing significant findings with regression tests.
- [ ] Push only the feature branch and create the first implementation PR. Wait for required verify and report its real result; no merge/deploy/enable.
