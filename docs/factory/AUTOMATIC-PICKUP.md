# Automatic ticket pickup and protected merging

Implements maintenance [#26](https://github.com/haideearus/cypress-realworld-app/issues/26). Keep all enable flags false through installation and review.

## What changes for you

After installation, create an application-maintenance issue with clear acceptance criteria and add `factory-ready`. GitHub checks the queue every 30 minutes, selects one eligible owner-created issue (or a verified production-monitor receipt under ticket #33), runs coding, tests and a fresh independent Claude review, then merges only the reviewed commit after both native required checks pass. Your PC can be off.

Owner maintenance/harness PRs, public mentions, issues created by strangers, and previously admitted/blocked/exhausted tickets do not automatically enter this queue. Automatically reviewed PRs pending merge are handled before newer work. Provider or infrastructure failures stop; this change does not introduce an unlimited repair loop.

Deployment remains separate: Render Auto-Deploy is off, and the course's human production approval is still required. [Production monitoring](PRODUCTION-MONITORING.md) adds authenticated incident tickets behind its own disabled switch. Generic stale-run recovery remains a later stage.

## Why a repository-only GitHub App

The owner selected this approach for unattended operation. GitHub App installation tokens let App-created/updated PR checks run without the manual approval prompt seen with `GITHUB_TOKEN`. Tokens are minted per trusted control job, expire after one hour, and are revoked at job end. The private key stays in GitHub Secrets.

Coding/review and PR-code test jobs never receive this key or an App write token. Claude still uses only `CLAUDE_CODE_OAUTH_TOKEN`; no AI API key, fallback provider, purchase or billing change is added. Keep Claude usage credits/extra usage off. These work counters cannot enforce that provider account setting or guarantee unlimited included Pro capacity.

## One-time App registration

1. Open [New GitHub App](https://github.com/settings/apps/new) under `haideearus`.
2. Use an available name such as `haideearus-software-factory`. Set Homepage URL to this repository. User OAuth callbacks and device flow are not needed.
3. Disable **Active** under Webhook; this integration uses scheduled Actions rather than a webhook server.
4. Set only these repository permissions:

   | Permission    | Access         | Purpose                                                  |
   | ------------- | -------------- | -------------------------------------------------------- |
   | Actions       | Read and write | Correlated CI and metadata-only gate refresh             |
   | Contents      | Read and write | Factory ledger, application branches and protected merge |
   | Pull requests | Read and write | Publish and merge the approved PR                        |
   | Checks        | Read           | Verify native required checks                            |
   | Issues        | Read           | Read approved maintenance tickets                        |
   | Metadata      | Read           | GitHub supplies this automatically                       |

   Leave administration, workflow-file write, organization and account permissions unset. Do not add the App to a branch-protection bypass list.

5. Limit installation to your account. Create the App, then **Install App → haideearus → Only select repositories → cypress-realworld-app**.
6. In App settings, copy its **Client ID** (the `Iv...` value, not the numeric App ID). Its slug is the last part of its public `github.com/apps/...` URL.
7. Generate a private key. Keep the downloaded PEM private. Copy the complete PEM directly into the GitHub Actions secret below, including its BEGIN/END lines. Do not paste it into chat, issues, commits or logs.

## GitHub configuration

On **Settings → Secrets and variables → Actions → Variables**, save:

| Name                           | Installation value        |
| ------------------------------ | ------------------------- |
| `FACTORY_ENABLED`              | `false`                   |
| `FACTORY_AUTOMATION_ENABLED`   | `false`                   |
| `FACTORY_AUTOMERGE_ENABLED`    | `false`                   |
| `FACTORY_GITHUB_APP_CLIENT_ID` | Actual App Client ID      |
| `FACTORY_GITHUB_APP_SLUG`      | Actual installed App slug |

Do not add empty values or example placeholders for the identity fields. They can remain absent until you create the App.

On **Secrets**, add `FACTORY_GITHUB_APP_PRIVATE_KEY` with the complete PEM. Keep the existing `CLAUDE_CODE_OAUTH_TOKEN` secret. Never configure an AI API key as a substitute.

All existing limits stay unchanged: 10 new tickets/day, 5 lifetime coding attempts/ticket, 5 lifetime reviews/ticket, 4 retries, 200 turns/model session, 30 minutes/model job, one active ticket and Europe/Bucharest daily accounting.

Create the issue label `factory-ready` if it does not exist. Apply it only to an owner-created application bug with concrete reproduction, expected behavior and test criteria. Do not label the installation/harness ticket itself.

## Preview before a real trial

After the reviewed code is merged into main:

1. Leave all three enable flags false.
2. Open **Actions → Automatic factory → Run workflow**.
3. Choose **main** and leave **dry_run=true**.
4. Run once. The result can propose a queued issue or pending automatic merge, but writes no reservation, invokes no model and performs no merge. App credentials are not used for this preview.

A preview is not proof that the installed App can publish or that a real Pro session is available.

## Controlled live rollout

Only after the owner approves a trial, choose one small real issue and its regression criteria. Verify no active ledger reservation.

- Set all three enable flags true when ready. A scheduled tick can run once enabled, so do not queue unrelated tickets during this trial.
- To start immediately, dispatch **Automatic factory** on **main** with **dry_run=false**, once.
- Confirm App connection validation precedes model admission, native PR checks actually start without manual approval, and the final merged head is exactly the approved head.
- Confirm one initial coding session and an independent review reserve durable grants before invocation. Failed checks/review may use only the remaining existing retries.
- Confirm merge receipt/audit and issue/PR state. Then restore all three flags false for inspection.

Only after this trial is observed should the owner leave the flags enabled for ongoing scheduled work. This PR's tests alone do not establish live unattended operation.

## Guards and recovery

- Missing/corrupt ledger, missing or malformed App setup, wrong repository/main/workflow/actor, changed criteria, missing approval/checks or exceeded limits refuse work.
- Publication has no unattended `GITHUB_TOKEN` fallback. Failed App validation stops before a model is admitted.
- Checks are matched to their actual native Actions workflow, PR, head and issuer; a newer dispatched `verify` cannot replace native PR CI.
- Native review status can be refreshed only after a genuine ledger approval; no model is rerun for this metadata step.
- Merge records intent before the expected-head merge call. A durable active-ticket lock prevents concurrent model admission during an uncertain merge. Later ticks observe GitHub first and reconcile a completed prior attempt rather than blindly repeating a merge.
- A blocked/exhausted ticket does not restart on a later day and its history is never refunded. Owner recovery is a separate decision.
- For a stop, save all three flags false and cancel the active Actions run. GitHub can snapshot variables, so a flag edit alone is not an instant cancellation. The existing owner-only `Factory agents → cancel` operation can help stop model work. For an uncertain merge, first inspect the real PR: cancellation cannot undo a merge already accepted by GitHub. Do not reset or hand-edit ledger counters.
- Generic stale-run recovery remains a later stage. Monitor-created tickets require their immutable receipt and actual successful main source run at pickup, admission and merge; bot authorship or labels alone do not qualify.

Schedules are best-effort, can be delayed, and public-repository schedules may disable after 60 days without repository activity. Pro quota/authentication or free hosting/database quotas can also stop work. No local computer is needed, but this is not an availability guarantee.

## Evidence

See the maintenance PR for RED/GREEN test counts, exact-head CI and genuine independent review. The verification covers real policy/ledger/controller behavior with local transports, including competing admissions, stale/foreign native checks, lost merge responses and App credential boundaries; it does not contact an AI provider.

Sources: [GitHub workflow triggers](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow), [App token action](https://github.com/actions/create-github-app-token), [reusable workflow context](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations), [schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).
