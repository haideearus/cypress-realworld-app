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

- [ ] Archive the provider observations and frozen-source hash manifest; preserve
      credential-free legacy policy fixtures and demonstrate its ledger refusal.
- [ ] Write failing quarantine eligibility/changed-fact/admission/integration tests.
- [ ] Implement the pinned contract and live evidence verifier; deny replay of the
      exact run ID in current authorize/preflight.
- [ ] Integrate explicit quarantine classification into preview/stop/resume and
      audit without releasing unconfirmed real locks or rewriting GitHub history.
- [ ] Run targeted and full factory tests, source scanning, formatting and fresh
      local review; fix findings and open a draft PR linked to the dedicated issue.
