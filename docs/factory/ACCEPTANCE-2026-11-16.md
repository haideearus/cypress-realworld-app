# Factory acceptance evidence — 16 November 2026

Documentation ticket: [#77](https://github.com/haideearus/cypress-realworld-app/issues/77).
Use [OPERATIONS.md](OPERATIONS.md) for installed behavior. The sanitized
[receipt bundle](evidence/acceptance-2026-11-16.json) binds this index to observed
controls, run IDs, approved commits, artifact digests and explicit limitations.
Receipts use UTC timestamps; the human-facing times below are Europe/Bucharest.
This index is not authorization, a billing audit or a declaration that every
course deliverable is complete.

## Current observation

At the bundle's snapshot on 16 November, source/main and the verified live app
were `f5969ed32fbe29eaea475b958d33d30f9dd30d18`. All three agent switches were
false, the durable stop was active, no ticket/grant was active/reserved, and
eight tickets had been admitted that Bucharest day. Monitoring, synthetic API
checks and feed-contract checks were true. The six recorded workflows were
enabled. These are dated observations, not permanent defaults.

Configured ceilings were 20 new tickets/day, five coding attempts, ten reviews,
four retries, one concurrent ticket, 200 turns and 30 minutes per session. Failed
attempts remain consumed. GitHub variables, protection hashes and ledger identity
were checked read-only during documentation preparation; no live control was
changed to obtain this evidence.

## Demonstrated paths

| Path                                 | Primary source                                                                                                                                                                                                                                                                        | Observed result and scope                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real monitor-created app repair      | [#68](https://github.com/haideearus/cypress-realworld-app/issues/68), [PR #69](https://github.com/haideearus/cypress-realworld-app/pull/69), [43849349459](https://github.com/haideearus/cypress-realworld-app/actions/runs/43849349459)                                              | Coding, CI, separate review and protected merge passed for the invalid pagination response. The run was manually dispatched; physical PC-off is owner-reported.                 |
| Approved app deployment and recovery | [43852606480](https://github.com/haideearus/cypress-realworld-app/actions/runs/43852606480), [43855263870](https://github.com/haideearus/cypress-realworld-app/actions/runs/43855263870)                                                                                              | Approved release `054a0efca643bd89f0dc756448e6f26de3e3c5a5`; matching healthy API/contract observations retired the incident and completed #68.                                 |
| Active emergency interruption        | [43764916721](https://github.com/haideearus/cypress-realworld-app/actions/runs/43764916721), job 132969639305                                                                                                                                                                         | An initialized Claude review and parent were cancelled; owner command completed in 30,018 ms wall time, with zero reported stop errors and consumed usage retained.             |
| Dependency trial                     | [PR #58](https://github.com/haideearus/cypress-realworld-app/pull/58), [43909582583](https://github.com/haideearus/cypress-realworld-app/actions/runs/43909582583)                                                                                                                    | All nine stages passed: selection, analysis, CI, reservation, read-only Claude review, assessment/status refresh, premerge, protected merge and finalization.                   |
| Dependency CI and production         | [43909783877](https://github.com/haideearus/cypress-realworld-app/actions/runs/43909783877), [43911865144](https://github.com/haideearus/cypress-realworld-app/actions/runs/43911865144), [43913104368](https://github.com/haideearus/cypress-realworld-app/actions/runs/43913104368) | Exact approved-head CI and main push CI passed; named-approved deployment verified release `f5969ed32fbe29eaea475b958d33d30f9dd30d18`, health, database readiness and frontend. |

PR #58 approved head was `d0451952eeedb97c14ae6ccd07e698e0c2957771`. The factory App
`haideearus-software-factory[bot]` merged it as `f5969ed32fbe29eaea475b958d33d30f9dd30d18`.
The ledger confirmed `merge.status=merged`, retaining approval and one consumed
Claude subscription review, zero coding and zero retries. Render accepted one
hook request, deploy ID `dep-dbtjeuei0phs73dhov00`. Approval by `haideearus` was
observed at **19:03:52**; verification completed at **19:07:01**. The approval API
does not supply a documented exact click timestamp; observed time is not that.
An independent unauthenticated GET check also verified the same release.

## Harness evidence and limits

| Requirement           | Evidence                                                                                                                                  | Qualification                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Least privilege       | [Model workflow](../../.github/workflows/factory-model.yml), [worker](../../scripts/factory/worker.cjs), protected publication/merge jobs | Model credentials/scopes are separated from publisher, App key and deployment hook; fixture tests are not a proof of every possible exfiltration path. |
| Protected main        | Native `verify` and `Factory review gate` checks; before/after protection hash in the bundle                                              | Existing strict protection and App-bound checks were preserved. No bypass was used for these controlled merges.                                        |
| Named production gate | Deployment receipt and [deployment source](../../scripts/factory/deploy.cjs)                                                              | Owner approval is required for each production candidate and remains a human decision.                                                                 |
| Pinned dependencies   | [yarn.lock](../../yarn.lock), action SHAs and trusted tool locks                                                                          | Reproducible pinning does not mean the entire dependency tree is free of vulnerabilities.                                                              |
| Secret handling       | [Native CI](../../.github/workflows/factory-ci.yml), scanner and sanitized artifacts                                                      | CI ran the pinned scanner and seeded-credential rejection. No secret value or raw credential-bearing URL is included in this index.                    |
| Audit                 | `factory/state` ledger, monitor registry, run/commit/artifact identities in the bundle                                                    | Curated evidence is not the complete human-action log. Old failed/held outcomes remain history.                                                        |
| Cost/work cap         | [policy](../../scripts/factory/policy.cjs), observed limits and grant counts                                                              | These bound work, not exact tokens, account balances or uninterrupted capacity. Usage-credit and hosting-billing settings remain provider-side checks. |
| Stop                  | Active-stop record above and [quarantine evidence](evidence/stale-run-43467058965/README.md)                                              | One observed active interruption within a minute; the contained old queued record remains visible. This is not a future cancellation SLA.              |

The stop observer had a post-stop reporting error. Its independently recovered
read-only verification established the cancelled job, command timing, false
switches, inactive ledger and preserved usage. The bundle retains both facts.
Older tests that stopped a session after it had already finished do not replace
this active interruption evidence.

## Test and artifact provenance

Issue #68's coding-agent report records `yarn test:unit:ci` failing before the fix
with `expected [400,422] to include 200`, then passing with 79 tests and ten skips.
The added regression is in
[public-transactions-route.test.ts](../../src/__tests__/public-transactions-route.test.ts).
The original code and review artifact ZIPs were downloaded earlier; their local
SHA-256 digests were matched to current GitHub artifact metadata during this
update. **A separate raw original RED console transcript was not independently
verified by this index.** Archive/check it before claiming standalone raw RED
proof; any later reproduction must be labelled retrospective.

| Artifact                        | SHA-256                                                            | Provenance                                                                  |
| ------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Code artifact 14215694678       | `932fa687cf6354c823d2a6b191ae5f3e2ddaa9e88405915ed17280910edd696c` | Run 43849349459; downloaded ZIP matched GitHub metadata                     |
| Review artifact 14218011440     | `754817782d9cee3242cbc1454e11e0ed9c34f0886015b4ef76d5dc83d2839025` | Same parent run; downloaded ZIP matched GitHub metadata                     |
| Deployment artifact 14249845987 | `4c4f084dfdaf979955b8b4596ee5d3b5ebe387ddb73092af7326683be949e2c9` | Run 43913104368; downloaded ZIP and candidate/approval/live fields verified |
| Active-stop observer archive    | `06f03357d57bbbd94082ca92be051fc925096e945305adc51f340ec4b56e7db9` | Locally retained observer archive; not claimed to be a GitHub artifact      |

Only sanitized selected receipts are committed. Full archives stay with the
operator; hashes and run links identify them but do not reproduce expired
artifacts. Preserve original evidence before retention expiry.

## Material human actions and unresolved record work

This is a verified action index, not a complete human log:

- The owner reported shutting the PC down at **12:25** and restarting at **12:50**
  on 16 November. Core issue #68 jobs fell within that interval according to
  runner timestamps; physical shutdown was not independently observed.
- Harness installation, credentials, scopes, limits and controlled run enablement
  were owner-authorized setup/maintenance actions. Their full click-by-click log
  still needs consolidation for submission.
- Owner rebase/recreate comments on PR #58 were unacknowledged during the check.
  The owner used **Update branch with merge commit** to include current main.
  Commit `d045195` records that setup synchronization. It is not a claim that the
  Dependabot comment handler worked; no manual intervention was needed inside
  the subsequent successful dependency run.
- The owner approved each cited production deployment. The approval observed
  time/comment in the latest receipt binds the tested merge commit and CI.
- The owner ran the stop command after the trial and restored all three variables
  false; both temporarily disabled pickup workflows were re-enabled. The operator
  cancelled stale unapproved deployment 43868591238 to release the production
  queue; it remains in GitHub history. Neither action approved a deployment.
- PR #57's earlier ambiguous merge and owner reconciliation remain history; they
  are not counted as a clean automatic-merge demonstration. See
  [dependency recovery](DEPENDENCY-MAINTENANCE.md).

## Remaining acceptance

1. Complete operating/account allowance and notification preflight without
   changing controls until separately authorized. Provider usage credits,
   billing limits, token availability and free-plan quotas are not audited here.
2. After authorization, record a **scheduled** 12–24-hour PC-off observation:
   actual schedule events, eligible pickup, CI/review/merge, bounded failures and
   approved production verification. The recorded successful controlled runs
   above used `workflow_dispatch`; they do not prove ongoing scheduler delivery.
3. Consolidate raw failing/passing evidence and the complete human log. Synthetic
   traffic covers login/session/feed/pagination/logout APIs, not all UI flows.
4. Prepare the narrated video of up to ten minutes and one A4 PDF with evidence
   links/timecodes and human decisions, due 1 December 2026, 23:59 campus time.

Do not reset counters, fabricate a passing check, start another session or remove
the stop to make this documentation look complete. Future live actions require
the owner's explicit authorization and the existing enforced gates.

## Documentation preparation checks

The documentation update passed 105 local file/anchor link checks with no new
broken links. One pre-existing site-root `/LICENSE` link in the unchanged README
was excluded from local resolution. JSON consistency and the three GitHub artifact
digests above matched retained sources. Explicit formatting and whitespace checks
passed, as did the 455-file tracked-source secret scan. No new runtime tests were
added or application/factory suites run locally for this documentation-only diff.
Native PR CI may execute its existing suites after opening.

A fresh local Codex review found no blocking issue. Its one minor request for an
explicit before/after protection comparison was resolved in the bundle and
rechecked. That local review does not satisfy the separate Claude Pro gate.
No Claude session, paid AI API, stop/resume, live trial, merge or deployment was
started by this documentation preparation. CI and a separately authorized fresh
subscription review remain required before protected merge.
