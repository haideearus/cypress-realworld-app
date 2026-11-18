# Saved privacy discovery recovery

Owner harness ticket: [#93](https://github.com/haideearus/cypress-realworld-app/issues/93).

This manual workflow can recheck the saved Claude output from
[run 44197159640](https://github.com/haideearus/cypress-realworld-app/actions/runs/44197159640).
It does not start Claude, repair the app, publish tickets, merge or deploy.
Preparing or merging its code does not activate recovery or change settings.

The original model job succeeded, replay failed without a specific diagnostic,
and finalization reported a GitHub API rate limit. The replay failure's exact
cause remains unproven. The consumed original grant stays blocked and the
workflow stays failed. No attempt or daily counter is refunded.

## Before a later authorized recovery

1. Merge this harness change only after ordinary CI and the independent review
   gate pass. Wait for successful push CI on the resulting `main` revision.
2. Record current settings. Pause event wake, automatic factory and dependency
   maintenance workflows before changing live controls. Keep discovery off.
3. A live recovery requires `FACTORY_ENABLED=true`,
   `FACTORY_AUTOMATION_ENABLED=false`, `FACTORY_AUTOMERGE_ENABLED=false` and
   `FACTORY_DISCOVERY_ENABLED=false`. It also requires no durable stop, active
   work or uncertain merge intent. Do not resume a stop or change these controls
   merely to prepare the PR; obtain the owner's later run authorization.
4. Open **Actions → Saved privacy discovery recovery → Run workflow** on `main`.
   Keep operation **preview** and **Preview only checked**. Expect
   `recovery_preview`, `ready=false`, `modelCalls=0`. `eligible` reflects controls
   and idleness, not a successful replay or verified bug. Reservation also
   enforces retained attempt and daily replay limits.

## Run and assess

After separate authorization, choose operation **run** and uncheck **Preview
only** for one new manual run. Do not re-run old jobs: only attempt 1 qualifies.
This consumes a durable replay permit before execution. At most two permits
exist for this pinned source, sharing the existing eight daily model-free replay
slots with ordinary intake. An assessed source cannot reserve another recovery.

The workflow digest-checks the original ZIP and JSON, builds the original app
revision and selects proposal batches **1 and 3**. Batch 2 was an earlier
transaction-test setup failure. Each selected proposal must reproduce twice;
the trusted privacy probe must independently reproduce twice. All generated
tests stay inside the existing credential-free Docker sandbox. Each finding
shares a five-minute deadline across its checks.

An `assessed` receipt means the checks finished. Inspect `evidence.json` for each
finding's `verified` or `held` status. It is not a claim that both bugs exist,
that tickets were created or that production was repaired. Missing artifacts,
changed identities, failed replays and a stop hold the evidence.

If replay and upload succeeded but finalization failed, use a **new** manual run
with operation **reconcile**, Preview only unchecked. Reconciliation checks the
real prior job/artifact and writes only a confirmation; it spends no extra model
session or replay permit. Failed or missing replay becomes held, not approved.
Cancellation is not a recoverable proof. Do not reset receipts or counters.

## Finish without starting repairs

Restore the recorded settings, keeping discovery off, then restore paused
workflow states. Confirm restoration before any further authorization. Recovery
itself never changes switches. Publishing up to two genuinely verified privacy
tickets is a separate authorized finding-intake step. Existing source proof,
deduplication, publication caps, fresh current-main replay and ordinary repair
admission still apply. Leave discovery off to keep these tickets ineligible for
automatic repair.

The recovery workflow has no subscription or paid API credential. Existing
subscription-only guards remain, including rejection of provider API keys.
Recovery-only bounded GET retries apply only to explicit GitHub rate limits; uncertain writes
are never retried automatically. Diagnostics expose phase, category and optional
HTTP status, without raw response text or signed URLs.

The existing discovery runner and worker keep their ordinary GitHub client.
Only this saved-output recovery entrypoint constructs the retry client.

## Validation status

Offline tests cover the real saved JSON as inert synthetic fixture data, latest
revision selection, artifact bounds/redirects, quota retention, stop handling,
producer provenance, reconciliation and ordinary intake compatibility. The
fixture is never used as a substitute for the live artifact or producer proof.
The actual recovery replay remains unrun; its Docker execution and live result
must be checked after merge and explicit run authorization.

Preparation evidence: [verification record](evidence/discovery-recovery/verification.json).
