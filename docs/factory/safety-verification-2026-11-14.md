# Scanner and direct-stop implementation evidence

Ticket: [#39](https://github.com/haideearus/cypress-realworld-app/issues/39).
Base: `487a11c03d980f35557c462cb75c68b60e39fe78`.
Branch: `agent/security-scanner-stop-control`.

This records local implementation verification, not production installation or a
successful timed stop of a real Claude session. No provider API, Claude session,
rehearsal, deployment, stop/resume execution, budget change or protection change
was performed while preparing this change.

## Executed checks

| Command / check                                                                               | Observed result                                                        |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `yarn test:factory`                                                                           | 401 tests: 391 passed, 10 optional integration tests skipped, 0 failed |
| `FACTORY_SECRET_SCAN_INTEGRATION=true node --test scripts/tests/factory-secret-scan.test.cjs` | Real pinned Gitleaks: 9 passed, 0 skipped/failed                       |
| `yarn types`                                                                                  | Exit 0                                                                 |
| `yarn lint`                                                                                   | Exit 0                                                                 |
| Explicit Prettier check of new CJS and documentation                                          | Passed                                                                 |
| actionlint 1.7.12 on both modified workflows                                                  | Exit 0                                                                 |
| Tracked-source Gitleaks scan                                                                  | Passed for the final 373-file staged snapshot                          |
| `node scripts/factory/stop.cjs`                                                               | Read-only preview; found queued agent parent `43467058965`, no changes |

The scanner installer verified the official Windows release archive and binary
checksums locally. Linux archive/executable pins are committed for required CI;
the Linux executable is not executed by the Windows local tests.

## Failure-first and review evidence

Initial tests failed with the missing scanner/stop modules before implementation.
A separate agent's fresh local review then found three actual defects. Each was
reproduced by a failing regression before its fix:

1. A variable write/verification outage skipped active-run cancellation. The
   regressions now prove cancellation is attempted independently and shutdown
   cannot be falsely acknowledged.
2. Windows NTFS alternate-stream filenames bypassed the scanner. Unsafe Windows
   paths are rejected on all hosts.
3. Gitleaks inherited filename exclusions skipped plaintext OAuth credentials in
   configuration/image filenames. Generated staging names now defeat those
   exclusions; a real-scanner regression covers all three reproduced names.

The final local re-review reported no blocking findings. Its first combined
integration command encountered one prolonged scanner timeout; the wrapper
failed closed. An isolated rerun passed 9/9 normally. This local Codex review does
not satisfy or replace the required independent Claude Pro review of the final
PR revision. No review evidence or required status was fabricated.

Stop tests simulate running/queued agents, failed API requests, bounded deadlines,
owner checks, resume, stale workflow variables, publication/merge refusal and
conservative reservation cleanup. Counters remain unchanged. They do not prove
GitHub's actual cancellation latency. The old queued run is explicitly retained
as an unresolved platform limitation rather than hidden from the inventory.

## Preserved live settings

Read-only checks during preparation observed:

```text
FACTORY_ENABLED=true
FACTORY_AUTOMATION_ENABLED=false
FACTORY_AUTOMERGE_ENABLED=false
FACTORY_MONITOR_ENABLED=true
FACTORY_MAX_TICKETS_PER_DAY=20
FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET=5
FACTORY_MAX_REVIEWS_PER_TICKET=5
FACTORY_MAX_AUTOMATIC_RETRIES=4
FACTORY_MAX_CONCURRENT_TICKETS=1
FACTORY_MAX_TURNS_PER_RUN=200
FACTORY_RUN_TIMEOUT_MINUTES=30
FACTORY_TIMEZONE=Europe/Bucharest
```

The live ledger had 15 tickets, no active reservation and no stop marker. These
values are observations, not new defaults or authorization to start an agent.

## Remaining gates

Required GitHub CI, a separately authorized independent Claude Pro review, normal
protected merge, and a separately authorized timed cloud stop/resume trial remain
installation steps. See [the operator runbook](SAFETY-CONTROLS.md). Production
approval and the factory's existing usage limits remain in force.
