# Claude factory installation verification

Scope: ticket [#6](https://github.com/haideearus/cypress-realworld-app/issues/6),
branch `agent/6-claude-factory`, base `5c2030ac723f51b6c764df0f52f9e5365e3fc27e`.
The owner approved the design. This installation does not enable agents, call
Claude, merge main, or change the running production application.

## Regression evidence

Tests were written and observed failing before their corresponding implementation:

| Increment                                                       | Before implementation | After implementation       |
| --------------------------------------------------------------- | --------------------- | -------------------------- |
| Typed policy and durable reservations                           | 13 failed, 1 passed   | 14 passed                  |
| GitHub persistence and artifact boundaries                      | 12 failed             | 26 passed across the suite |
| Controller                                                      | 8 failed              | 34 passed across the suite |
| Worker                                                          | 5 failed              | 39 passed across the suite |
| Parsed workflow contracts                                       | 5 failed              | 44 passed across the suite |
| Corrupt history, lowered limits and orphan publication recovery | 3 failed, 22 passed   | 47 passed across the suite |

Local logs are saved outside the repository under `../outputs/claude-factory-*`.
They are development evidence, not a claim that a real Claude session ran.

The latest `yarn test:factory` result after the 2026-11-12 review fixes is:

```text
1..59
# tests 59
# pass 59
# fail 0
# cancelled 0
# skipped 0
```

The tests exercise the actual policy, REST adapter, ledger, controller, worker
and artifact validators with injected fake GitHub HTTP responses and temporary
Git repositories. No inference SDK is imported and no model service is called.
They verify owner/default-branch authorization, admission dates, lifetime limits,
atomic reservations, stale reruns/heads, refused patches, independent structured
review records, CI identity and safe cancellation/recovery.

## Installation checks

- `yarn install --frozen-lockfile --production=false`: exit 0; existing patches applied.
- `yarn test:factory`: 59 passed, 0 failed.
- Actionlint 1.7.12: exit 0 for all six factory workflows; optional ShellCheck
  and Python integrations were disabled because those programs are not installed.
- `yarn types`: exit 0.
- `yarn lint`: exit 0.
- `yarn test:unit:ci`: 44 passed, 10 inherited skipped tests, exit 0.
- `yarn build:production`: exit 0. Existing Vite configuration/large-bundle
  warnings remain; no application bundle behavior was changed by this PR.
- Full disposable PostgreSQL/browser/Cypress checks: initial
  [PR verify run](https://github.com/haideearus/cypress-realworld-app/actions/runs/43102101170)
  passed for `8813254`. The final revision's required check and result are recorded
  in [PR #7](https://github.com/haideearus/cypress-realworld-app/pull/7).

## Independent implementation review and repairs

A separate reviewer with a fresh context read the whole branch from `5c2030a`
through `8813254`. It reported no critical findings and three important findings.
One repair pass addressed all three:

| Finding                                                               | Repair and regression evidence                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Polling could accept an older CI run at the same head                 | Persist a unique dispatch request ID before dispatch, match its run title, save the exact run ID, and require that record for review/assessment. Delayed visibility and another same-head run: 2 new tests failed before repair; controller suite then 12 passed.                                       |
| Output scanner missed GitHub credentials                              | Refuse GitHub token formats in generated source, evidence and review fields. Two new tests failed before repair; affected suites then 16 passed. All test credentials are synthetic.                                                                                                                    |
| Owner/harness PRs could never satisfy the required all-PR review gate | Add explicit owner-only existing-PR review, using the same admission/review budget and lock with zero invented coding calls. Eight policy/controller/workflow tests failed before repair; full suite then 57 passed. Two additional worker/workflow boundary tests bring the final result to 59 passed. |

The owner-PR path is a repair to make the approved all-PR gate and separate
owner maintenance path usable. It does not raise limits or bypass review. CI
polling uses brief atomic ledger updates, without holding the controller queue
throughout the wait; owner cancellation remains able to proceed.

The reviewer explicitly deferred live authentication/account access, live
cancellation/GitHub permissions, scheduling, auto-merge and deployment. These
remain rollout validation or later coursework, as documented below. The review
and simulations are not a real Claude maintenance-ticket approval.

The official Claude action is pinned to
`4fa93a88de49bbef68b10eb15aabedf28ca0e1ed`; its source installs Claude Code
2.1.322. Native `claude.exe --help` confirmed the configured CLI restriction
flags without starting a model session. Actionlint checks YAML/GitHub syntax,
not real provider authentication or SDK behavior.

## Deliberately not claimed

The repository variable remains owner-set `FACTORY_ENABLED=false`. The token
secret was created by the owner; its value was not read during implementation.
No API credential, paid fallback, usage-credit purchase or billing change was
added. The owner previously confirmed Claude extra usage was off; the workflows
cannot inspect that account setting or promise unlimited Pro usage.

Initialization of `factory/state`, disabled-run proof, registration of the new
required review check, GitHub PR-creation permission and a real subscription
coding/review demo remain owner rollout steps in
[the installation guide](../CLAUDE-FACTORY.md). Real GitHub/Claude authentication,
model output quality and cancellation of a live model job have not been tested.
The initial installation is manual and does not yet schedule unattended work,
merge changes or deploy production.
