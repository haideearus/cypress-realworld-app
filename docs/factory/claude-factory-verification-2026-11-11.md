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

The latest `yarn test:factory` result is:

```text
1..47
# tests 47
# pass 47
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
- `yarn test:factory`: 47 passed, 0 failed.
- Actionlint 1.7.12: exit 0 for all five factory workflows; optional ShellCheck
  and Python integrations were disabled because those programs are not installed.
- `yarn types`: exit 0.
- `yarn lint`: exit 0.
- `yarn test:unit:ci`: 44 passed, 10 inherited skipped tests, exit 0.
- `yarn build:production`: exit 0. Existing Vite configuration/large-bundle
  warnings remain; no application bundle behavior was changed by this PR.
- Full disposable PostgreSQL/browser/Cypress checks: to be recorded from the
  installation PR's required `verify` job before handoff.
- Fresh-context whole-branch implementation review: pending at this checkpoint.

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
