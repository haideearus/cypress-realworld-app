# Monitor repair rehearsal

This workflow is an isolated test, not an outage test against Render. It creates
a broken temporary readiness fixture, opens a real `[DRILL]` issue, gives Claude
one repair attempt, and independently measures recovery in a disposable container.
It never publishes a repair PR, merges, or deploys the generated repair.

Implementation ticket: [#35](https://github.com/haideearus/cypress-realworld-app/issues/35).
Installation and a live run remain unverified until their actual GitHub evidence
is recorded. Local transport/Docker tests do not establish a live Claude run.

## Before installation

Review the implementation PR through the existing independent Claude Pro review
and required CI gates. The installation review is separate subscription usage.
Merge only after the required checks pass. No new secrets, permissions in GitHub
settings, provider API keys, or purchases are needed by this workflow.

The implementation does not change repository variables. Preserve the current
values until the owner is ready to perform the following steps.

## Step 1: preview

After installation, open **Actions → Monitor repair rehearsal → Run workflow**.
Select `main` and leave **Preview prerequisites without mutations or Claude
usage** checked. Click **Run workflow** once.

Open the run summary. It must say `outcome: preview`, `modelCalls: 0`, and show
prerequisites. Preview creates no branch, issue, ledger reservation or model call.
The coding, verification and finalization jobs must be skipped.

The prerequisite booleans are useful even when false: they show what must change
before a live run. A green preview does not mean an actual repair has happened.

## Step 2: prepare one live attempt

Wait for existing factory work to finish and confirm no ticket holds the ledger
lock. Save the original switch values, then set these values yourself:

| Variable                     | Required for this controlled rehearsal |
| ---------------------------- | -------------------------------------- |
| `FACTORY_ENABLED`            | `true`                                 |
| `FACTORY_AUTOMATION_ENABLED` | `false`                                |
| `FACTORY_AUTOMERGE_ENABLED`  | `false`                                |
| `FACTORY_MONITOR_ENABLED`    | May stay unchanged                     |

Do not change the existing limits. One drill uses one daily ticket and one coding
attempt, up to the configured turn and duration limits. It has zero automatic
retries and zero model reviews. Used allowance is never refunded, including after
failure or cancellation. No paid API authentication fallback exists.

Use the existing Claude Pro OAuth secret and keep purchased/extra usage off in
the provider account. A rate limit or expired token stops the run. These workflows
do not change or override provider billing settings.

Run the preview again if needed. Then open a **new** run form on `main`, uncheck
the preview box and click **Run workflow** once. Do not use **Re-run jobs**;
attempts after the first are rejected.

## Step 3: the PC-off window

Open the **Preview or PC shutdown window** job. When its **Allow 90 seconds for
the owner to shut down their PC** step starts, record your local shutdown time and
turn the PC off. The remaining jobs execute on standard GitHub-hosted Linux
runners. The test service exists only inside those disposable runners.

After returning, record your return time and open the run's summary from GitHub.
Compare your offline interval with job and evidence timestamps. Evidence must
show coding and verification occurred during that interval, not before shutdown.
GitHub cannot independently prove the physical PC was powered off.

Switches and allowance are checked again at admission and model preparation, but
GitHub may snapshot configuration variables. To stop an already queued/running
test, **cancel the run**; changing a variable is not immediate cancellation.

## Step 4: inspect the result

A passing run ends with **Record measured recovery and retire the attempt** and
`outcome: drill_complete`. Download **drill-result** and **drill-verification-…**.
Confirm:

- `synthetic: true`, the actual workflow/run, source and seed SHAs, issue/grant IDs.
- Baseline: readiness and regression fail while health and frontend pass.
- Candidate: all four checks pass, from a separate trusted oracle.
- `deduplicated: true`: repeated failure reused one issue.
- The exact `[DRILL]` issue is closed, its incident is recovered, and the active
  drill registry pointer and factory ledger lock are cleared.
- One coding grant, zero reviews/retries, preserved daily usage, no PR or approval.
- The generated bundle digest and verification timestamps match this run.

The broken fixture lives only on `factory/drill-<run-id>`. The history is retained
there and in `factory/monitor-drill`; production uses `factory/monitor`. Do not
merge the drill branch or add `factory-ready` to its issue. Ordinary admission,
publication and approval gates reject drill evidence even if its label changes.

After the run, save `FACTORY_ENABLED=false` while checking the evidence. Leave
pickup and merging off until the owner explicitly restores unattended operation.
Restore monitoring only if you changed it yourself. No workflow changes switches.

## If it fails or is interrupted

Do not repeat the dispatch to obtain another attempt. A terminal model or verifier
failure leaves the issue unresolved and retires the grant as `blocked`; it does
not claim recovery. Investigate the preserved evidence before authorizing more work.

If finalization did not run or cannot confirm terminal model jobs, the lock stays
held. Once the run is terminal, use **Factory agents → Run workflow → main →
operation `cancel`** to recover its ledger reservation. Existing cancellation
waits for the active run to stop before releasing the lock and preserves counters.

A crash after issue/branch publication can leave an incomplete durable receipt.
That needs an owner-reviewed state repair, not deletion of history or a blind
retry. Cancellation clears an active ledger reservation; it does not repair an
ambiguous issue publication or reset the drill incident registry.

## What this proves

A live passing run proves monitor-created drill ticket → real Claude coding →
independent deterministic verification → isolated recovery, using cloud runners.
It does not prove independent AI review of the generated repair, production
automatic admission, merging, Render deployment, or automatic stale-run recovery.
The earlier real maintenance/deployment evidence remains separate.

## Maintainer checks without AI or account mutations

```shell
yarn test:factory
FACTORY_DRILL_DOCKER_TEST=true node --test scripts/tests/factory-drill-sandbox.test.cjs
yarn types
yarn lint
```

On PowerShell set `$env:FACTORY_DRILL_DOCKER_TEST = 'true'` before the sandbox test
and remove it afterward. Docker integration exercises a pinned Node image, read-only
filesystem, UID/process boundaries, no external network, malicious output, and
healthy/unhealthy CLI reports. It calls no model or GitHub API. Factory CI runs
this Docker check on Linux automatically.
