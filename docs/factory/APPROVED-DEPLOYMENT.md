# Human-approved production deployment

Ticket [#31](https://github.com/haideearus/cypress-realworld-app/issues/31) adds
`Approved production deployment` (`factory-deploy.yml`). It connects the existing
Render Free service to a GitHub environment approval. No model runs, AI keys,
extra provider accounts, hosting upgrades or database migrations are involved.

## Setup and current evidence

The owner configured the `production` environment with required reviewer
`haideearus`, administrator bypass disabled, and a selected **Branch** rule for
`main`. `Prevent self-review` is off so the owner can approve a manually started
deployment. The secret `RENDER_DEPLOY_HOOK_URL` is stored **in this environment**.
Only its name was read during implementation; its value was not read or tested.
Keep Render Auto-Deploy off and the existing service on Free.

On November 13, 2026, automatic run
[#7](https://github.com/haideearus/cypress-realworld-app/actions/runs/43481055400)
completed coding, CI, independent Claude review and protected merge of issue
#29 through [PR #30](https://github.com/haideearus/cypress-realworld-app/pull/30).
The merge commit's
[main CI](https://github.com/haideearus/cypress-realworld-app/actions/runs/43484041045)
also passed. That does not mean the change was deployed. This deployment workflow
still needs its own PR review/merge and a controlled approved live run.

All three agent switches stay false during setup: `FACTORY_ENABLED`,
`FACTORY_AUTOMATION_ENABLED`, and `FACTORY_AUTOMERGE_ENABLED`. They control agent
pickup/coding/review/merge, not this separate deployment workflow. A deployment
never turns them on or invokes Claude. Cancelling/rejecting the pending
production approval is how to stop a deployment that has not yet started.

## What happens automatically

1. A completed `Factory CI` run caused by a **push to this repository's main**
   triggers preparation. Failed CI and PR CI cannot deploy.
2. Preparation fetches the CI run and its actual successful `verify` job from
   GitHub. The CI SHA must equal both current `main` and the immutable deployment
   workflow source SHA. It shows the full candidate SHA and source CI link in
   the workflow summary.
3. The `Deploy tested commit <SHA>` job waits at the `production` environment.
   Review that SHA and CI evidence, then approve or reject the job in GitHub.
   The hook secret is only released to the job after environment approval.
4. After approval the job checks the CI/head again and requires the approval
   history to identify `haideearus` as the human approving `production` on this
   run. If main advanced while waiting, the candidate is rejected; it never
   silently substitutes a newer commit.
5. The job sends **one** POST to the existing service's secret hook, setting
   `ref` to the full approved SHA. It does not build code, install packages,
   download CI artifacts, or execute PR code in the secret-bearing job.
6. It polls only the fixed public app URL, for at most 20 minutes. It requires
   `/healthz` to report the exact SHA, `/readyz` to report database readiness,
   the root page to serve the React HTML, and a second matching health response.
   This tolerates cold starts but does not run Cypress or reseed production.

Only these trusted scripts are checked out at `github.workflow_sha` and run;
the GitHub token has only `contents: read` and `actions: read`. A fixed deployment
concurrency group serializes deployment jobs without cancelling an active one.
GitHub may replace an older pending concurrency job when a newer one arrives;
there is no promise that every intermediate main commit will be deployed.

## First controlled deployment after merging this PR

1. Keep the agent switches false and Render Auto-Deploy off. Wait for **Factory
   CI / main** to pass on the commit that includes this workflow.
2. Open **Actions → Approved production deployment**. Its automatically started
   run should show the prepared commit and wait for `production` approval.
3. If no run appeared, choose **Run workflow → main** and enter the numeric run
   ID from that successful main **push CI** URL. Do not enter a PR number, SHA,
   the deployment run's ID, or a factory dispatch CI run's ID.
4. Check the candidate summary, then choose **Review deployments**, select
   **production**, and approve. This is the named human production decision;
   the assistant preparing the PR has not made it on your behalf.
5. Wait for the deployment and live checks to finish. Inspect the workflow
   summary and download `deployment-evidence-<run>-1` for course evidence.
6. Check the repaired behavior in the deployed UI. The automated smoke checks
   establish release identity, readiness and HTML delivery; they do not prove
   every interaction or a complete browser login. Keep regression evidence from
   CI and record the human UI result separately.

## Evidence and recovery

The JSON artifact and workflow summary record the exact SHA, source CI run and
attempt, deployment run, approving actor/environment, approval observation time,
hook-attempt time, safe Render deployment ID if supplied, and verified live SHA.
GitHub's approval-history API does not provide an approval timestamp: the field
`observedAt` is explicitly the time the workflow observed approval. Comments,
hook URLs, credentials and raw server response bodies are excluded. Artifacts
are retained for 30 days; download evidence before it expires.

A Render HTTP 200 or 202 means started/queued, **not verified live**. If the
request times out or verification fails, the workflow stops and records failure.
Render may still finish after the workflow stops. Inspect Render's Deploys page
and the public release before deciding whether another request is needed.
Public probes establish that the approved SHA is serving; they do not establish
that a particular Render deployment ID finished. For a repeat deployment of a
SHA that is already live, the old instance can satisfy those probes. Use Render's
Deploys page when the completion of that particular rebuild matters.

Use a **new Run workflow dispatch and fresh approval** for recovery. Deployment
run attempts greater than one cannot execute the helper, including failed-job
reruns that retain earlier preparation outputs. Each fresh run sends at most
one hook request; repeated human-approved runs may redeploy the same commit.
There is no automatic rollback, hook retry, ledger reset, or destructive data
repair. If main changed, use its newly successful push CI run, not the stale ID.

This workflow does not change or bypass GitHub's existing independent-review
gate. The implementation PR still needs a genuine fresh Claude Pro review before
merging. Preparing or testing this code does not consume a Claude review grant.

The old automatic run #5 remains a separate GitHub queue anomaly. Do not add new
`factory-ready` tickets until that incident is resolved. It cannot re-admit #29,
which already has a merged ledger record. Monitoring, incident-ticket creation
and generic stale-run recovery are separate unfinished stages.

References: [Render deploy hooks](https://render.com/docs/deploy-hooks),
[GitHub environment protection](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments),
[workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run),
[approval-history API](https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run).
