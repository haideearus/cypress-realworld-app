# Scanner and direct-stop implementation evidence

Ticket: [#39](https://github.com/haideearus/cypress-realworld-app/issues/39).
Base: `487a11c03d980f35557c462cb75c68b60e39fe78`.
Branch: `agent/security-scanner-stop-control`.

The initial sections record local implementation verification, not production
installation or a successful timed stop of a real Claude session. No provider API, Claude session,
rehearsal, deployment, stop/resume execution, budget change or protection change
was performed during the initial preparation. Subsequent authorized cloud CI and
the first Claude Pro review are recorded separately below.

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
checksums locally. The Linux executable is not executed by the Windows local
tests; its real GitHub-hosted verification is recorded in the next section.

## Actual Linux CI verification

Both CI runs below completed successfully for source commit
`4275b2f3336a12ffa5aad1a5efa7377d7bf7dd42`:

- [PR CI run 43633280945, verify job 132564445827](https://github.com/haideearus/cypress-realworld-app/actions/runs/43633280945/job/132564445827).
- [Exact-head review CI run 43634775016, verify job 132569066569](https://github.com/haideearus/cypress-realworld-app/actions/runs/43634775016/job/132569066569).

On the real `ubuntu-latest` runner, these steps all completed with `success`:

1. Install the checksum-pinned secret scanner.
2. Reject secrets in the complete tracked source snapshot.
3. Prove the scanner blocks a seeded credential without leaking it.

These are observed GitHub job results, not simulated HTTP fixtures or a claim
that Windows tests executed the Linux binary. They establish that the Linux
archive downloaded, both checksum checks succeeded, and the Linux scanner
actually ran against the source and seeded-credential tests. The complete
`verify` job, including application tests, also passed. Subsequent PR revisions
still require their own CI and independent review.

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

## First authorized Claude Pro review: rejected output

[Review run 43634724304](https://github.com/haideearus/cypress-realworld-app/actions/runs/43634724304/job/132570807248)
reviewed the commit above under issue #39. The subscription session completed
after 66 turns within its 200-turn limit. Its structured output combined verdict
`pass` with an `important` finding, so the unchanged validator rejected it with
`Invalid passing review with blocking findings`. No review bundle was uploaded
and no approval was recorded. The ledger retained one consumed review and marked
the ticket blocked; no counter was refunded or reset.

The important finding requested actual Linux CI evidence, which is supplied
above. The reviewer also made a minor suggestion about paginating repository
variable inventory; this documentation follow-up does not change that code. The
review output's contradictory verdict remains rejected. This evidence update
neither rewrites that verdict nor substitutes a human or local-agent approval.
Another independent subscription review must be explicitly authorized and must
produce a consistent result for the final revision before protected merge.

## Second authorized review and the next review brief

[Review run 43637028532](https://github.com/haideearus/cypress-realworld-app/actions/runs/43637028532/job/132577486043)
completed its real subscription session in 41 turns with no permission denials.
Its structured result for `96ed7c36fa86d4ded3ddb84ed9ac736f880652cd` contained a
passing verdict but only a generic test summary and test finding. The existing
shape validator accepted it and the ledger recorded approval. During the owner's
requested merge check, that text was found insufficient to explain an actual
independent assessment; PR #40 remained draft and the required native review gate
was not refreshed. No merge, replacement approval or counter reset was performed.

The [current review brief](PR-40-REVIEW.md) now makes the ticket's assessment scope
and report expectations explicit in the candidate diff. It does not change the
trusted worker, validator, tool permissions or limits. The new documentation
revision requires a new independent review; the normal admission path refuses a
repeat owner review of an unchanged head already marked reviewed. Issue #39's
description and saved criteria hash are preserved. Two reviews remain consumed;
another run must use the existing allowance and cannot inherit old approval.

The owner restored `FACTORY_ENABLED=false`; pickup and merging remain false,
monitoring remains true. No third review is started by preparing this brief.

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

The final revision still needs required GitHub CI, a separately authorized fresh
Claude Pro review, normal protected merge, and a separately authorized timed cloud
stop/resume trial. See [the operator runbook](SAFETY-CONTROLS.md). Production
approval and the factory's existing usage limits remain in force.
