# Approved Render deployment implementation plan

**Goal:** Complete ticket #31 by preparing a reviewed PR for deployment after named human approval. This task does not authorize a real deployment or a Claude run.

**Architecture:** A separate `factory-deploy.yml` workflow prepares a candidate after successful `Factory CI` on a push to `main`, or accepts a CI run ID on manual dispatch. A job protected by the `production` environment revalidates the same candidate and the named human approval, sends one service-scoped Render hook request with the full commit SHA, and verifies the live app. It executes only trusted scripts checked out at `github.workflow_sha`.

**Tech stack:** Node 22 built-ins, existing GitHub REST helper, GitHub Actions, existing Render Free service. No new packages or AI calls.

## Constraints and decisions

- All three agent factory switches remain false throughout preparation. Deployment is a separate human-approved operation, not gated by agent enablement.
- Keep existing protected branches, review requirements, usage limits, subscription authentication and Render Auto-Deploy off.
- `production` must require `haideearus`, prohibit administrator bypass, allow only branch `main`, and hold `RENDER_DEPLOY_HOOK_URL` as an environment secret.
- Verify repository, workflow identity, first deployment run attempt, successful push CI, the actual successful `verify` job, and exact equality of CI SHA, current main SHA and trusted workflow SHA. Repeat after approval. Reject PR CI, forks, stale candidates and reruns.
- Record approval actor/environment and observation time. GitHub's approval history has no documented approval timestamp; never invent one. Do not log comments.
- Use the deploy hook rather than an account-wide Render API key. The hook supports exact-commit deployment and requires no new paid product. Poll public health/readiness/frontend endpoints instead of requesting broader Render API access.
- Send at most one hook POST per run, including timeouts and HTTP 202. A new workflow run and approval are required for retry. No automatic rollback or production data writes.
- Concurrency serializes deployment jobs. Fixed URLs, no redirects, bounded bodies/request/poll timeouts, and sanitized evidence prevent credential leakage and unbounded waiting.
- A successful local simulation is not proof of production deployment. Live approval and release verification remain rollout work after merge.

## Review focus

1. A delayed approval must not deploy a different or superseded revision.
2. A workflow rerun must not reuse approval to send another hook request.
3. A successful hook response or old healthy release must not count as a verified deployment.
4. Secret-bearing URLs and untrusted response bodies must never reach logs/artifacts.
5. New workflow files must not break existing required CI or independent-review gates.

## Tasks

- [x] Add failing orchestration and workflow tests for the context, CI, approval and stale-revision cases.
- [x] Implement `scripts/factory/deploy.cjs` and `.github/workflows/factory-deploy.yml`, using only read GitHub permissions and the protected hook secret.
- [x] Add and run failing transport tests, then implement `scripts/factory/deploy-render.cjs` with simulated POST and live-check responses. Tests never call a real service.
- [x] Run all factory protection tests and relevant lint/format checks. Review the complete diff in a separate context and resolve material findings.
- [x] Document rollout, evidence, limitations and recovery. Prepare a draft PR linked to #31; leave genuine independent Claude review pending and switches unchanged.

## Evidence

- Baseline on main `8948ab7c6f21205d356e9009596862553cdd8c31`: factory tests 220 passed, 1 existing skip, 0 failures.
- Reuse the clean existing checkout on a new branch; no worktree or dependency installation needed.
- User explicitly requested the implementation PR after choosing the protected Render-hook setup; continue within that authorization without another design-permission round.
- RED: orchestration tests failed because the implementation did not exist. Transport tests also started RED; additional negative cases caught explicit default-port hooks and misleading `data-id` HTML before fixes.
- GREEN on pinned Node 22.20.0: 48 new deployment tests pass. Full factory suite: 268 passed, 1 existing skip, 0 failed. `yarn lint`, `yarn types`, targeted Prettier, actionlint 1.7.12 and whitespace checks pass.
- Read-only live GitHub metadata confirmed all three switches false, owner approval required, admin bypass disabled, only branch main allowed, and the environment secret's name present. The candidate helper accepted the real successful main CI 43484041045 without reading the hook or requesting a deployment.
- Separate local code review found no material defects. It does not replace the genuine Claude subscription review required by branch protection. Documented limits: public probes verify HTML and a live SHA, not browser behavior or completion of a particular same-SHA Render rebuild.
