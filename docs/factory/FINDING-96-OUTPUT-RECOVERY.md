# Final finding proof and bounded #96 output recovery

This prepares a future separately authorized run. All four factory switches stay
false and the five pickup/discovery/intake workflows stay paused while preparing
the PR. No Claude, repair, recovery, merge or deployment starts during preparation.

## Two diagnosed defects

The [third #96 coding reservation](https://github.com/haideearus/cypress-realworld-app/actions/runs/44376807620)
passed fresh trusted RED, model-context scanning, Claude coding, collection and
trusted GREEN. Its final bundle scan rejected one generic API-key match, so no
artifact was published and no PR was created. The same scanner rejection can be
reproduced using only the trusted receipt's public finding identifier under `key`.
The rejected live bundle was not uploaded; the synthetic reproduction does not
claim that every byte of that unavailable bundle has been inspected or cleared.

The repeated Postgres `role root does not exist` messages were a separate probe
misconfiguration. Both workflows now explicitly probe their existing
`factory_test` user and `rwa_test` database. No database role, production setting
or connection credential is changed.

## Complete final output boundary

New repair receipts use version **2** and an explicit public `findingRef`. The
producer and strict consumer both require it to equal the original finding
identifier. Grant, head, candidate, file digest, RED/GREEN digests and outcomes
remain bound. Legacy wire receipts, unknown fields and changed identities are
rejected for new publication. Historical ledger origin/intake records and old
retry/continuation receipts are unchanged.

The production GREEN path calls `finalizeRepairBundle` after proving GREEN. It
assembles the complete bundle with the trusted receipt and scans that exact
representation before writing it. The existing full pre-upload scan still runs.
There are no scanner rule changes, value exceptions, credential encodings or
secret suppression. Generated source, evidence and extra content still fail
closed when they contain a secret. The tests include actual `worker.collectCode`
against a disposable synthetic Git checkout, production finalization, the real
unchanged scanner, identity tampering and injected synthetic credentials.

## One separate recovery receipt, ordinary usage

The new `findingOutputRecovery` is distinct from, and cannot replace, either
`findingRetry` or `findingContinuation`. Its only starting point is blocked
grant `d91d546e-f952-4dea-9fc4-99b053477d92`, parent `44376807620`, attempt 1,
with all three historical grants and both previous receipts pinned unchanged.
It proves RED/context preparation/model/collection/GREEN succeeded and the
final scan failed; ambiguous stages, duplicates, extra model invocations and
rerun attempts are refused. It never republishes that rejected output.

A later authorized recovery reserves a fresh coding session and consumes normal
capacity: coding **3 → 4**, retries **2 → 3**. No counter, old grant, daily
admission or allowance is reset. The new owner-only parent and its tested main
are recorded in a separate receipt. All old parents remain historical; only the
new parent may continue. Later ordinary coding/review cycles stay in that parent
and within the existing caps, including the final coding attempt 5.

Repeated recovery, another ticket, edited issue/proofs, occupied or stopped
ledger, pending merges, exhausted capacity, an existing publication branch,
unpaused competing workflows or stale/unverified main are rejected. The operation
selects #96 directly without queue selection or #97 reads. It cannot
automatically merge or deploy. Fresh RED/GREEN, app CI and independent review
are required even though the rejected candidate previously passed GREEN.

## Later preview, after PR review and merge

1. Retain all four false switches and keep Factory event wake, Dependency
   maintenance, Proactive app discovery and Verified discovery finding intake
   disabled. Temporarily enable only Automatic factory for its manual form.
2. Run on `main`, operation **recover-finding**, ticket **96**, `wake_id` empty,
   with **preview/dry_run checked**. Launch once.
3. Expected: `pick` succeeds; coding/review/merge jobs are skipped. The controller
   result is `finding-output-recovery-preview`, `outputRecoveryEligible: true`,
   `ready: false`, `modelCalls: 0`. The workflow UI may display only a generic
   summary; input logs, job outcomes and a read-only ledger comparison verify
   selection and absence of writes. No usage or activity-store write is made.
4. Pause Automatic factory again and inspect the run and unchanged ledger before
   considering a live operation.

## A live operation needs separate owner authorization

Only after that authorization, temporarily enable `FACTORY_ENABLED` and
`FACTORY_AUTOMATION_ENABLED`; keep discovery and merging false and the other four
workflows disabled. Use the same `recover-finding`/96 selections with preview
unchecked, launch once and pause Automatic factory again. Do not rerun historical
parents or use GitHub's Re-run jobs button for an admitted recovery.

After the entire parent finishes, restore `FACTORY_ENABLED=false` first, then
`FACTORY_AUTOMATION_ENABLED=false`, retaining discovery/automerge false and all
five workflows paused. Preserve failed attempts and inspect the outcome before
further action. Production deployment still requires named human approval.
