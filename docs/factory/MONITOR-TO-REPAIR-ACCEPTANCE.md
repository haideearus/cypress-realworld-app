# Normal monitor-to-repair acceptance

Setup: [#63](https://github.com/haideearus/cypress-realworld-app/issues/63).
This installs a disabled check and verified incident retirement. It is not a live
repair, independent Claude review, or authorization to enable a switch.

## The real defect to detect

The authenticated feed accepts `GET /api/transactions/public?page=1&limit=0` and
currently returns HTTP 200 with `totalPages: null`, an empty result and potentially
`hasNextPages: true`. The normal five-item request succeeds. This was confirmed
against the actual compiled app with disposable loopback PostgreSQL, not Render.
No application fix is included. The later agent must add its own failing
regression and implement the repair through the ordinary factory.

The optional check accepts bounded JSON 400/422 rejection or coherent pagination
with a positive limit at most 50. Authentication/provider failures, redirects,
invalid JSON and null/inconsistent metadata fail. Normal feed checks stay separate.

## Controls and boundaries

| Control                               | Default / behavior                                                  |
| ------------------------------------- | ------------------------------------------------------------------- |
| `FACTORY_FEED_CONTRACT_CHECK_ENABLED` | Absent/false; adds no request                                       |
| Preview input `feed_contract`         | False; overrides only when `dry_run=true`                           |
| Three agent switches                  | Remain false during setup/preview                                   |
| Account secrets                       | Existing synthetic username/password only in checker                |
| Monitor token                         | Contents/issues write and Actions/PR read; no Claude/deploy/App key |
| Production deployment                 | Existing named human approval                                       |

Contract preview includes the synthetic journey. Live mode requires the repository
flag and `FACTORY_APP_CHECKS_ENABLED=true`; the preview input cannot enable it.
Installation saves no variable, changes no account and clears no stop marker.

Results add a `feedContract` ok/failed enum and public release SHA observations
before and after the journey, bound in version-two same-run reports. Their immutable incident/proof binds `probeMode: feed-contract`. Standard
version-one reports/receipts and isolated drill records remain valid. A standard
or disabled probe yields `required_probe_missing`, never contract recovery.
No remote body, cookie or exception text enters issues or reports. Legacy reports
without bracketing release identities cannot authorize retirement; a release-bound
journey must be enabled for that evidence, including for an older standard incident.

Eight-request release-bound journeys use six-second request deadlines; standard checks retain
ten seconds. Three rounds and pauses bound the contract journey to 206 seconds
versus the existing 212 seconds. Availability, scanner and publication budgets
remain unchanged, within the eight-minute job. Metadata and writes share a
sixty-second phase; an outage holds safely rather than running indefinitely.

## Verified closure

Retirement requires the original bot issue/criteria and successful source receipt,
validated ledger with a finished genuine same-head Claude review, actual protected
merge and durable receipt, successful main push CI, successful first-attempt
deployment of that exact merge commit using trusted workflow source and producer
jobs, named owner production approval, and fresh healthy signed-in/availability
checks on that release with the required probe mode. No reservation may remain.

The monitor persists close intent, closes only that issue as completed, confirms
its state and records completed retirement before clearing the active pointer.
It edits neither the issue body nor the usage ledger. Lost responses retain intent
and are reconciled after fresh verification. Monitor control shares ledger job
concurrency with admission. The isolated drill keeps its separate retirement.

`recovery_held` means healthy probes were observed but repair/deployment proof or
closure confirmation is unavailable. Manual closure or spontaneous recovery alone
does not prove a deployed repair. This initial path holds such incidents for
investigation. Missing/expired provider evidence, failed parent runs, changed
producer workflow source or exceeded lookup bounds also hold. Preserve history;
do not delete receipts or refund allowance for another attempt.

## Later authorized test, in order

1. Complete setup PR CI and its separately authorized Claude Pro review; merge
   normally. Leave the new check absent/false, the agent switches false, and the
   existing monitoring settings and owner stop unchanged.
2. Preview: Actions Ã¢â€ â€™ Production monitor Ã¢â€ â€™ Run workflow Ã¢â€ â€™ main. Leave preview
   checked; select the pagination-contract preview input. With later authorization,
   expect the real contract failure, healthy controls, no ticket/state write and
   no model invocation. Reassess if production behavior differs.
3. Before a live trial, record settings, limits, counters, release and workflow
   states. Confirm idle queue/ledger/registry and Claude extra usage/auto-reload
   off. Temporarily disable only Dependency maintenance, recording its prior state,
   to isolate pending Dependabot work from this trial's global enablement.
4. When authorized, enable the contract repository flag and run/observe the real
   monitor with preview false while agent switches stay false. Verify one genuine
   `incident_created` issue with `factory-ready`, its receipt and successful source
   run. Do not create a substitute owner ticket or edit its criteria. Repeated
   failures must reuse it.
5. At the separately authorized model-use boundary, explicitly resume and enable
   ordinary scheduled pickup/merging. Resume restores saved flags, not automatic
   modes. Record Europe/Bucharest shutdown date/time and turn the PC off before
   coding/review. GitHub performs regression/coding, CI, fresh independent review,
   protected merge and main CI, then waits for production approval.
6. Return, confirm terminal jobs and restore the false switches/durable stop with
   the established command. Inspect exact-head evidence and approve only the
   current tested repair's Render deployment; never approve a stale candidate.
7. Leave monitoring and the contract probe on. Observe healthy same-mode checks
   on the repair release, automatic issue closure/completed retirement and idle
   incident/ledger. Restore Dependency maintenance's prior active state only
   after all three agent switches are false.
8. Archive source receipt and deduplication, RED/GREEN, CI, separate grants,
   reviewed/merged/deployed commits, named approval, recovery and PC-off times
   before artifacts expire.

Expected successful repair usage is one coding session plus one fresh review;
setup review is separate. Existing caps still bound failures/retries. No resets,
API keys, purchased credits or paid fallback are allowed. Schedules are best
effort; record actual times. Physical PC-off times remain owner-reported. This
test does not authorize leaving automatic operation enabled afterward.
