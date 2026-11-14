# Guarded stale-run quarantine implementation plan

> For agentic workers: use executing-plans to implement this plan task by task.

**Goal:** Unblock stop/resume for one proven nonexecuting stale record without
claiming it was cancelled or weakening cancellation of any real agent.

**Architecture:** Protected-code identity and frozen-source proof, live fail-closed
evidence checks, explicit result/audit classification and a current-code run-ID
denial. No arbitrary ignore list or live policy override.

**Tech stack:** Existing Node 22 CJS policy, GitHub REST and node:test.

**Spec:** ../specs/2026-11-15-stale-run-quarantine.md

## Constraints and review focus

All three agent switches false; no Claude/paid API/merge/live stop/resume. Preserve
provider record and all counters/grants/audit. Changed attempts, source, jobs,
reservations or containment history invalidate the exception. API failure never
grants quarantine. Unknown zero-job runs remain ordinary cancellation targets.

- [x] Archive the provider observations and frozen-source hash manifest; preserve
      credential-free legacy policy fixtures and demonstrate its ledger refusal.
- [x] Write failing quarantine eligibility/changed-fact/admission/integration tests.
- [x] Implement the pinned contract and live evidence verifier; deny replay of the
      exact run ID in current authorize/preflight.
- [x] Integrate explicit quarantine classification into preview/stop/resume and
      audit without releasing unconfirmed real locks or rewriting GitHub history.
- [ ] Run targeted and full factory tests, source scanning, formatting and fresh
      local review; fix findings and open a draft PR linked to the dedicated issue.

## Verification record

Regression evidence: the pre-fix stop suite reported four failures, including
the stale ID being treated as an ordinary/terminal run. Current admission also
accepted the retired ID before the denial was added. Focused checks now pass
22/22, including provider outages, changed jobs/history and late settlement or
resume changes. The actual legacy policy accepts a valid ordinary baseline and
refuses the retained drill ledger without credentials or network access.

Fresh read-only local review at `14d4abb` found no actionable findings, verified
all five archived source hashes against the original Git objects, checked worker
packaging, and independently passed the 22 focused tests. This local review is
not the required Claude Pro gate.

Read-only live preview found no other agent parents, reported the original run
as quarantined with actual status `queued`, and confirmed all three switches
`false`. It executed no stop/resume or model session. Provider snapshots are not
transactional; immutable-controller refusal remains essential. Live cancellation
timing and the course's one-minute proof remain pending.
