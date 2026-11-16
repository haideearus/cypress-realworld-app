# Monitor acknowledgment preparation evidence

Dedicated ticket: [#66](https://github.com/haideearus/cypress-realworld-app/issues/66).
Approved design: [owner acknowledgment](../superpowers/specs/2026-11-16-recovered-monitor-acknowledgment-design.md).
Base: `166c5d8c668906f7b96ed509c20528530d6b6413`.

This records local implementation preparation on 16 November 2026,
Europe/Bucharest. It does not claim that the new workflow has run in GitHub or
closed any real issue. Required final-head Claude Pro review remains pending.

## Executed verification

| Check                                                      | Observed result                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------- |
| Existing monitor baseline                                  | 70 passed                                                         |
| New acknowledgment/probe/workflow tests                    | 23 passed                                                         |
| Final `yarn test:factory`                                  | 544 total: 534 passed, 10 optional integrations skipped, 0 failed |
| `yarn lint`                                                | Passed                                                            |
| Direct formatting check of changed CJS/Markdown/YAML files | Passed                                                            |
| Checksum-pinned actionlint 1.7.12, new workflow            | Passed                                                            |
| Checksum-pinned Gitleaks 8.30.1 source scan                | Passed; complete staged/tracked source snapshot                   |

Positive feature tests first failed before implementation. Later regressions
failed for absent pending-intent/admission/repair guards and then passed. The
availability-order regression first failed because metadata started its deadline
before the public probe, then passed after the probe was moved outside that phase.

The tests use simulated GitHub transport, synthetic report files and injected HTTP
responses. They exercise preview, close-intent ordering, exact-target closure,
receipt/source/owner guards, durable pause and admission refusal, same-release and
freshness checks, lost issue/final registry responses, an accepted write with a lost
response, unchanged counters, and retry with a newer active incident. No Render,
production database, production account journey or AI provider was contacted by
these test commands. Optional integration skips are not described as tested.

## Independent local review

A fresh read-only Codex review found one Important issue: the 60-second metadata
deadline included the separately budgeted availability retry interval. A healthy
late public response could therefore cause a false hold. Its reproduction used
simulated time and no network. The correction verifies public availability before
the first metadata API request and revalidates report freshness before writes.

The reviewer independently confirmed 23 new tests passing, including a simulated
152-second availability interval, and reported no remaining Critical, Important or
Minor findings. This is preparation review only; it does not replace the required
Claude Pro subscription review gate.

## Controls and scope

Read-only GitHub checks after implementation confirmed all three agent switches
false, the durable stop active, and no active ledger ticket. Issue #65 remained
open with no closure time. No acknowledgment workflow, ordinary monitor workflow,
Claude session, repair, merge or deployment was dispatched by preparation.

No application, package/lockfile, model cap, paid-service setting or protection
rule was changed. The new workflow has no schedule/PR trigger, uses the existing
standard Linux runner and pinned actions, and receives only the existing synthetic
account secrets in its checker. Its publisher receives no account, AI, App,
database or deployment credential.

Acknowledgment is an explicit owner decision about observed standard recovery.
It is ineligible for contract/drill or historically admitted incidents and cannot
authorize AI admission or count as reviewed/deployed repair proof. Original
receipts, publication days, counters, stop/quarantine data and issue criteria are
preserved. Live preview and execution remain future, separately authorized work.

Local raw logs are retained outside the repository in `../outputs/ack-*.log`;
public CI on the PR will provide final-commit evidence independently.
