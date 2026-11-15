# Dependency maintenance preparation evidence — November 15, 2026

Ticket: [#50](https://github.com/haideearus/cypress-realworld-app/issues/50).
Base: `195e083b868a0c59219bd3cb4bcc8d8cce98ad72`.
Implementation branch: `agent/dependency-cve-automation`.

## Scope

This verifies the disabled implementation locally, with simulated GitHub and model
responses. It does not claim a live Dependabot upgrade, genuine Claude review,
deployment or interruption acceptance. Those require the later controlled trial.

## Failure-first and review evidence

- Initial analysis, policy and coordinator tests failed because their new modules
  did not exist, then passed after implementation.
- Additional failing regressions established rejection of changed-selector hidden
  major edges, mismatched registry package URLs, prereleases, and incomplete report
  evidence. An unrelated unchanged legacy alias remains supported.
- A separate fresh read-only code reviewer examined the complete branch. Three
  important findings were reproduced before fixes: a root edge could downgrade to
  an unchanged existing selector; a bot rebase after approval stalled the queue;
  and rerunning a metadata workflow prevented cleanup of its historical attempt.
- All three regressions then passed. An additional failure-first test proves a
  live merge intent stays held on a bot head change. Only a verified terminal
  historical attempt plus an observed open, changed bot head permits retiring that
  unmerged intent. The old intent is audited; admissions, grants and counters stay.
- The local reviewer found no critical or minor findings. It set live activation,
  real Claude/deployment acceptance and the unrelated Windows unit runner aside;
  they remain outside implementation review, with live acceptance still pending.

## Commands and results

Node `22.20.0`, Yarn Classic `1.22.22`:

| Check                                                                               | Result                                                       |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Private tools: `npm ci --ignore-scripts --no-audit --fund=false` in their directory | Two pinned packages installed; no lifecycle scripts          |
| `yarn test:factory` after review fixes                                              | 460 passed, 10 skipped, 0 failed                             |
| `yarn types`                                                                        | Passed                                                       |
| `yarn lint` and explicit Prettier check of new CJS/YAML/docs                        | Passed                                                       |
| `yarn test:unit:ci --pool=threads --maxWorkers=1`                                   | 78 passed, 10 skipped; exited successfully                   |
| `yarn build:production`                                                             | Passed; existing large bundle warning                        |
| Actionlint on dependency and CI workflows                                           | Passed                                                       |
| `node scripts/factory/secret-scan.cjs source`                                       | Passed; values never printed                                 |
| Public OSV query for the pinned `semver@7.7.3`                                      | Completed without authentication or AI; no reported advisory |

The initial default unit-runner attempt was interrupted while taking longer than
expected. Its exit is not counted as a pass. The complete single-thread rerun above
finished successfully; no app code or unit-runner configuration was changed.

Factory fixtures cover immutable manifest/lock reads, malformed/partial/unavailable
OSV, genuine/forged bot intake, report replay and age, shared lock/admission rules,
no grant before analysis and CI, native expected-head merging, closed/lost-response
reconciliation, stop inventory and workflow credential separation. Root app
dependencies and its Yarn lock were not upgraded by this implementation.

## Live state during preparation

Read-only GitHub inspection confirmed `FACTORY_ENABLED=false`,
`FACTORY_AUTOMATION_ENABLED=false` and `FACTORY_AUTOMERGE_ENABLED=false`.
Monitoring and synthetic app checks stayed enabled. No setting, limit, secret,
branch protection or retained history was changed, and no Claude run or paid AI
API was started. Dependabot fork activation is documented for after review/merge.

The connected implementation and orchestration were committed together to avoid
an intermediate partially wired policy change; this makes the first implementation
commit larger to review. The approved design and its runtime boundaries did not change.
