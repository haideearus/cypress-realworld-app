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
| [Our Actions](https://github.com/haideearus/cypress-realworld-app/actions)     | Test runs and future factory jobs                        |
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

This foundation change adds instructions, source provenance, and a PR evidence
template. It does not itself enforce permissions or start agents.

| Component                                              | Status after this foundation change     |
| ------------------------------------------------------ | --------------------------------------- |
| Public fork, default `main`, Issues                    | Verified                                |
| Local clone and upstream remote                        | Verified                                |
| Agent instructions and maintenance guide               | Added in the foundation PR              |
| Dependency installation and application tests          | Not run during this documentation setup |
| Factory CI and independent agent reviewer              | Pending                                 |
| Branch protection and least privilege jobs             | Pending                                 |
| Live app, persistent storage, production approval gate | Pending                                 |
| Secret scanner, audit collector, traffic monitor       | Pending                                 |
| Cost cap enforcement and kill switch                   | Pending                                 |

The inherited workflows refer to upstream services, including Cypress Cloud.
Review and adapt them before relying on them as this fork's required checks.
An existing upstream badge is not evidence that our fork passes tests.

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

Each repair will follow this path once the automation is installed:

```text
Issue -> coding agent -> failing test -> fix -> PR -> checks
      -> fresh agent review -> merge -> human deploy approval
      -> live smoke test -> close ticket or open a repair ticket
```

Each PR must target `haideearus/cypress-realworld-app:main`. GitHub may suggest the
original project as the target when working with a fork, so check the base
repository before opening a PR.

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

## Next milestone

Make the full application run with a production startup, one public URL,
persistent demo data, and environment-managed secrets. Then install the factory
checks and agents and demonstrate one ticket all the way to an approved live
deployment. The demo uses synthetic users and payments.
