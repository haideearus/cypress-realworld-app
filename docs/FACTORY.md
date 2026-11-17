# Maintaining this copy

This is haideearus's maintenance fork of Cypress Real World App for the Software
Factory coursework. The original application and tests were written by the
upstream project. The goal is to deploy this demo and have agents implement and
review its maintenance tickets.

## Where things live

| Place                                                                          | Purpose                                                  |
| ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| [This repository](https://github.com/haideearus/cypress-realworld-app)         | Our application code and maintenance changes             |
| [Our Issues](https://github.com/haideearus/cypress-realworld-app/issues)       | Bugs, improvements, and failures found by monitoring     |
| [Our pull requests](https://github.com/haideearus/cypress-realworld-app/pulls) | Proposed fixes and their review evidence                 |
| [Our Actions](https://github.com/haideearus/cypress-realworld-app/actions)     | CI, monitoring, maintenance and approved deployment jobs |
| [Original project](https://github.com/cypress-io/cypress-realworld-app)        | Upstream changes we may incorporate through reviewed PRs |
| [Agent instructions](../AGENTS.md)                                             | How agents work in this repository                       |
| [Source record](factory/baseline.json)                                         | The original revision used to start this fork            |

## Step one: verified foundation

On 2026-11-11 the repository was verified as a public fork of
`cypress-io/cypress-realworld-app`, with `main` as its default branch and Issues
enabled. The initial `main` commit matched upstream `develop`:
`0729f68ac220f7cda4ad09c5693dba11d7c532c6`.

A local checkout was created at:

```text
C:\Users\haide\Documents\Codex\2026-11-03\c\cypress-realworld-app
```

The local remotes are:

```text
origin    https://github.com/haideearus/cypress-realworld-app.git
upstream  https://github.com/cypress-io/cypress-realworld-app.git
```

`origin` is our copy. `upstream` supplies the original project's changes. These
remote settings are local Git configuration; someone cloning the repository
again must add the `upstream` remote as shown below.

## Current setup status

Snapshot, **16 November 2026**: the installed cloud factory is deliberately
paused. `FACTORY_ENABLED`, `FACTORY_AUTOMATION_ENABLED` and
`FACTORY_AUTOMERGE_ENABLED` are all false and the durable owner stop is active.
The automatic/dependency workflows are enabled; enabled workflows do not override
those controls. Production monitoring, synthetic-user API checks and the feed
contract check are enabled independently.

The app is live at https://haide-software-factory.onrender.com. Its approved
release is `f5969ed32fbe29eaea475b958d33d30f9dd30d18`. The following paths have
demonstrated runs:

- Monitor incident [#68](https://github.com/haideearus/cypress-realworld-app/issues/68)
  led to Claude coding, CI, independent review and protected merge of
  [PR #69](https://github.com/haideearus/cypress-realworld-app/pull/69). After named
  deployment approval, a matching recovery observation automatically completed
  the incident. The owner reported the core run occurred with the PC off.
- Dependency [PR #58](https://github.com/haideearus/cypress-realworld-app/pull/58)
  passed analysis, exact-head CI, a fresh Claude Pro review, evidence refresh,
  fresh premerge checks and an App-backed protected merge. Its approved
  deployment and independent public release checks passed.
- An initialized Claude review was interrupted in **30,018 ms wall time** by
  the owner stop command. The separately contained historical queued record
  remains quarantined; it is not falsely described as cancelled.

Use the [operations guide](factory/OPERATIONS.md) for controls and recovery, and
the [dated acceptance index](factory/ACCEPTANCE-2026-11-16.md) for source links,
receipt hashes, manual actions and evidence limitations. These are observations,
not authorization to start a session or change live settings. No remaining
provider quota, uninterrupted availability or future cancellation latency is
guaranteed by a past successful run.

Still outstanding: final operating preflight and notifications, a separately
authorized **scheduled 12–24-hour PC-off observation**, and the course video,
one-page PDF and complete human log. A manually dispatched cloud success does not
establish ongoing scheduler delivery. The synthetic traffic currently covers API
login/session/feed/pagination/logout, not every rendered UI interaction.

### Historical update, 2026-11-15

The following paragraphs preserve the status at that date; they do not override
the current snapshot above.

On 2026-11-15 the app, Claude coding/CI/independent review, App-backed
automatic merging and named human-approved deployment have demonstrated runs
linked below. Production monitoring is installed and enabled. The isolated cloud
repair rehearsal passed in
[43581712040](https://github.com/haideearus/cypress-realworld-app/actions/runs/43581712040);
it does not establish a real unattended production incident repair or a physical
PC-off interval.

Secret scanning and owner stop controls merged in PR #40; the narrowly guarded
stale-record exception merged in PR #43. The owner shutdown trial
[43654287550](https://github.com/haideearus/cypress-realworld-app/actions/runs/43654287550)
completed in 37.5 seconds wall time, cancelled the parent workflow and preserved
usage. Claude finished successfully during shutdown, so forced interruption of a
still-running Claude process remains separate acceptance evidence. The stop
marker remains active, all three agent switches are false, and the ledger is idle.

The [synthetic-user API checks](factory/APP-CHECKS.md) are prepared under #46,
default-off and not yet installed. They extend existing outage tickets with
signed-in behavior failures; no account secret or live setting was changed during
preparation. Dependency/CVE automation, rendered-browser traffic, a complete
unattended production-repair cycle and final course evidence remain follow-up
work. Historical status and foundation milestones below are dated evidence.

### Historical update, 2026-11-13

Update on 2026-11-13: the cloud coding, CI and independent Claude Pro review path
was demonstrated for issue #11. Its public-feed repair, including a real HTTP
regression, merged through [PR #25](https://github.com/haideearus/cypress-realworld-app/pull/25).
The [automatic pickup and merge guide](factory/AUTOMATIC-PICKUP.md) describes
ticket #26's implementation. The App-backed automatic trial for issue #29 passed
coding, CI, independent review and merge in
[run #7](https://github.com/haideearus/cypress-realworld-app/actions/runs/43481055400),
producing merged PR #30. All three factory switches were restored to false.
The [approved deployment guide](factory/APPROVED-DEPLOYMENT.md) covers ticket #31.
PR #32 merged and [production run 43493762007](https://github.com/haideearus/cypress-realworld-app/actions/runs/43493762007)
passed after human approval, deploying main commit
`54525bc837a1be222ea0c1bdc115d38b1e5889e0`; live health, readiness and frontend
checks passed. All three factory switches remained false.
The [monitoring guide](factory/PRODUCTION-MONITORING.md) describes ticket #33's
default-disabled monitoring and trusted incident tickets, plus the approved
daily ceiling increase from 10 to 20. Its live rollout is still pending review,
merge and preview. Generic unattended recovery remains unfinished.
The foundation table below is historical evidence, not the current full status.

The [Claude factory guide](CLAUDE-FACTORY.md) describes the first agent-workflow
implementation under ticket #6. Keep `FACTORY_ENABLED=false` through installation.
It adds durable limits and separate coding/review roles. Required branch checks
and a real owner-triggered ticket have since been verified, along with the
production approval workflow. Monitoring still needs rollout. The application is deployed at
https://haide-software-factory.onrender.com with Neon persistence. The table below
records the earlier foundation milestone, rather than the whole current rollout.

This foundation change adds instructions, source provenance, and a PR evidence
template. It does not itself enforce permissions or start agents.

| Component                                              | Status after this foundation change     |
| ------------------------------------------------------ | --------------------------------------- |
| Public fork, default `main`, Issues                    | Verified                                |
| Local clone and upstream remote                        | Verified                                |
| Agent instructions and maintenance guide               | Added in the foundation PR              |
| Dependency installation and application tests          | Verified locally; see the results below |
| Factory CI and independent agent reviewer              | Pending                                 |
| Branch protection and least privilege jobs             | Pending                                 |
| Live app, persistent storage, production approval gate | Pending                                 |
| Secret scanner, audit collector, traffic monitor       | Pending                                 |
| Cost cap enforcement and kill switch                   | Pending                                 |

Ticket #2 archives the inherited workflows under `.github/upstream-workflows`
and adds a single read-only `Factory CI` job without Cypress Cloud recording.
Its remote result and required-branch-check configuration must be verified
separately. An existing upstream badge is not evidence that this fork passes.

## Historical production preparation (ticket #2, 2026-11-11)

The production change builds the frontend and compiled API for one origin,
persists demo data and sessions in PostgreSQL, removes password hashes from user
responses, and includes real database restart, concurrency, and failure checks.
The [deployment guide](DEPLOYMENT.md) has exact free-plan setup instructions.

At this foundation milestone, the public URL, provider quotas, named production
approval, protected branch, cost guard, kill switch and unattended dispatcher
still required installation and verification. The current snapshot and acceptance
index above supersede those installation-status claims; provider billing and
ongoing availability still require operator attention.

## Historical local verification on 2026-11-11

The locked dependency installation, TypeScript check, lint, and CI frontend build
passed. Unit tests finished with 44 passed and 10 skipped. Cypress API and desktop
UI tests finished with 109 passed across 16 specs; one user-search test needed a
retry. See the [verification report](factory/verification-2026-11-11.md) for the
commands, scope, and limitations. This is local evidence; the factory's GitHub
checks and agents still need to be installed.

The chosen hosting direction is a free cloud app plus a free persistent database,
so the owner's laptop can be off. Follow the [deployment guide](DEPLOYMENT.md)
for account setup, required production changes, and spending controls.

## Recreate the local checkout

From a chosen parent folder, use:

```shell
git clone https://github.com/haideearus/cypress-realworld-app.git
cd cypress-realworld-app
git remote add upstream https://github.com/cypress-io/cypress-realworld-app.git
git remote -v
```

Install the Node version from `.node-version` and Yarn Classic `1.22.22`, then:

```shell
yarn install --frozen-lockfile
yarn dev
```

The development frontend is at http://localhost:3000 and the API at
http://localhost:3001. See [AGENTS.md](../AGENTS.md) for check commands and the
original [README](../README.md) for the upstream development instructions.

## Where new maintenance tasks go

Create an issue in **our Issues**, describing the problem, how to reproduce it,
and the expected behavior. An upstream issue can be linked as the source; it is
not automatically copied into our backlog by forking.

When live operation is authorized and its controls allow work, app repairs use:

```text
Issue -> coding agent -> failing test -> fix -> PR -> checks
      -> fresh agent review -> merge -> human deploy approval
      -> live smoke test -> close ticket or open a repair ticket
```

Each PR must target `haideearus/cypress-realworld-app:main`. GitHub may suggest the
original project as the target when working with a fork, so check the base
repository before opening a PR.

The installed picker takes eligible owner issues labelled `factory-ready` and
receipt-verified monitor incidents. Monitor publication supplies its own label;
an arbitrary old issue or a label without the required provenance is not enough.
The separate dependency lane selects eligible genuine Dependabot PRs without
that label. See the operations guide before creating or changing queue entries.

## Incorporating upstream changes

Fetch upstream changes, compare them, and create a maintenance PR for any update
we want to adopt. For example, starting from a clean checkout:

```shell
git fetch origin
git fetch upstream develop
git switch -c maintenance/upstream-update origin/main
git log --oneline HEAD..upstream/develop
git merge upstream/develop
```

Resolve any conflicts in the maintenance branch, run the required checks, and
open a PR into our `main`. Dependency and source updates go through the same
review process as bug fixes. Preserve the factory configuration and evidence.

## Original foundation milestone (historical)

Make the full application run with a production startup, one public URL,
persistent demo data, and environment-managed secrets. Then install the factory
checks and agents and demonstrate one ticket all the way to an approved live
deployment. The demo uses synthetic users and payments.
