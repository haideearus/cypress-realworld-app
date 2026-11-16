# Monitor repair acceptance setup verification

Issue: [#63](https://github.com/haideearus/cypress-realworld-app/issues/63).
Base: `ad0022b614c5b4b6446ed80606657a7594d3a99e`.
Branch: `agent/monitor-feed-contract-recovery`.

This records setup preparation on 16 November 2026 (Europe/Bucharest), not a live
trial, installed rollout, successful Claude review, automatic retirement in
production or permission to enable an agent. Existing app source/dependencies
were not changed. No provider model, paid AI API or production HTTP request was
used in implementation verification.

## Actual authenticated local baseline

The compiled production-mode app used disposable loopback PostgreSQL `rwa_test`.
The synthetic account signed in, read both queries, and logged out. The test
transport never targeted Render or production Neon.

| Request                                       | Observed result                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /api/transactions/public?page=1&limit=5` | 200, page 1, limit 5, totalPages 9, five records                       |
| `GET /api/transactions/public?page=1&limit=0` | 200, page 1, limit 0, totalPages null, hasNextPages true, zero records |

This establishes the acceptance candidate without planting an outage. The later
factory repair must supply its own failing-before application regression; this
setup detects the bug and includes no application fix.

## Failure-first implementation and review corrections

- Six new probe/report/proof tests failed before implementation. They cover the
  real null metadata response, safe rejection/normalization, default-off behavior,
  malformed responses, report substitution and immutable contract scope.
- The first monitor-scope integration test then failed until required probe mode
  was retained in the incident and could not be replaced by a standard observation.
- Five recovery tests failed before the new verifier existed. Passing tests now
  cover actual policy/ledger validation, strict GitHub metadata transports,
  named-approved exact-release deployment, close intent and response reconciliation.
- A fresh local Codex whole-change review found missing release binding across
  rollout and missing read-only PR permission. Three focused regressions failed
  before correction. The contract journey now brackets account checks with public
  release observations; unbound legacy reports cannot authorize retirement. The
  monitor has only the additional Actions/PR read permissions it consumes.
- A further failure-first test proved that another ticket's valid PR approval
  could mask this incident's wrong grant pointer in the generic review gate. The
  verifier now directly requires this issue's finished review grant and genuine
  approval fields, as well as the existing gate.

The release-bound mode makes eight bounded requests with six-second deadlines,
retaining a 206-second maximum journey and the existing eight-minute job. The
default standard journey remains five requests with its existing bounds. No cap,
review gate, allowed patch path or isolated drill origin was loosened.

Read-only inspection of historical runs `43691015736`, `43753346000` and
`43752762408` checked actual provider job names, statuses and commit fields. The
review/model jobs carry the parent workflow SHA, not their separately checked-out
candidate SHA; the verifier checks these identities independently. This metadata
inspection did not start/retry any workflow or attest a new production repair.

## Executed validation

| Check                                                           | Observed result                                                        |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Baseline focused app/monitor suite                              | 37 passed, zero failures                                               |
| Final `yarn test:factory`                                       | 521 total: 511 passed, 10 optional integrations skipped, zero failures |
| `yarn types`                                                    | Exit 0                                                                 |
| `yarn lint`                                                     | Exit 0                                                                 |
| `yarn test:unit:ci`                                             | 11 files passed, 1 skipped; 78 tests passed, 10 skipped                |
| `yarn build:production`                                         | Exit 0; existing build warnings remain                                 |
| Disposable production suite (`yarn test:production` equivalent) | 8 passed, zero failures; includes real new probe/route integration     |
| actionlint 1.7.12 on modified workflow                          | Exit 0                                                                 |

The disposable integration checks the current bad route response is detected, and
also permits a later genuine rejection/normalization repair to pass. It does not
force future CI to preserve the bug. Provider API failures are exercised with
bounded local transports, not paid APIs or live fault injection.

Checksum-pinned Gitleaks 8.30.1 scanned all 427 tracked/staged files successfully;
scanner values were never logged. Final branch/cloud CI evidence belongs to the
PR. Ten optional factory integrations were not executed by this local run;
CI retains its existing credential-free Linux sandbox and scanner integration.
Existing unit/build deprecation/chunk warnings were not expanded into unrelated
application changes.

## Preserved controls and next gate

The three agent switches remain false and the durable owner stop is preserved.
Existing monitoring and synthetic checks remain enabled. The new flag is not
created; absent means false. No new secret, provider credential, hosting purchase,
deployment or ledger admission is part of setup. Limits stay at 20 daily tickets,
5 coding attempts, 10 reviews, 4 retries, 1 concurrent ticket, 200 turns and
30 minutes. All historical usage and the existing stale-run quarantine remain.

The local review does not replace the required future Claude Pro independent
review of the exact PR head. Merge/preview/live acceptance and named production
approval are later authorized steps. Follow the
[operator runbook](MONITOR-TO-REPAIR-ACCEPTANCE.md).
