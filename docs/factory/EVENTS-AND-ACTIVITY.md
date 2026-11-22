# Event pickup and activity notifications

Implementation for [harness issue #82](https://github.com/haideearus/cypress-realworld-app/issues/82),
following the approved [event/activity plan](../superpowers/plans/2026-11-17-factory-events-activity.md).
This document describes installed code after merge, not live acceptance or email delivery.

## What changes

`Factory event wake` checks GitHub metadata when an owner marks an app issue ready,
the production monitor completes, native CI passes on a genuine current-head
Dependabot proposal, or a genuinely admitted parent releases its execution slot.
It explicitly dispatches the existing automatic/dependency workflow on `main`.
The existing cron paths remain available. Owner harness PR CI never requests an
automatic Claude review.

The receiver must be a real `github-actions[bot]` dispatch, verified against its
GitHub run, workflow identity, main SHA, first attempt and a durable wake receipt.
An arbitrary input string, label, public issue or bot username is insufficient.
The actual actor is retained; no controller impersonates the owner. Normal current
head, criteria, scope, capacity, budget, stop and independent review checks remain.

`Factory activity` observes allowlisted run/job/step metadata and reads typed
controller results from a separate registry. It posts scanned entries to an
approved journal issue for native GitHub notifications. Healthy monitoring and
idle queue checks are included. It distinguishes role preparation (`starting`)
from an actual model step (`started`) and a genuine assessed review (`passed`).
Approval, deployment and merge observations do not approve, deploy or merge work.

The observer has no Claude token, App private key, account credentials, database
credential or Render hook. It never checks out or executes candidate PR code.
Notification failure cannot change work results, approval or usage counters.
Discovery event types are reserved for the later discovery stage: this PR does
not install a discovery agent, exploration tests or finding publication.

## New opt-ins; existing settings are unchanged

| Actions variable                | Default / requirement                                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `FACTORY_EVENT_PICKUP_ENABLED`  | Absent or `false` disables event dispatch.                                                                                   |
| `FACTORY_ACTIVITY_LOG_ENABLED`  | Absent or `false` disables journal publication and result enqueueing.                                                        |
| `FACTORY_ACTIVITY_ISSUE_NUMBER` | Positive number of the explicitly approved, open, unlabelled owner journal issue; required when activity logging is enabled. |

Neither workflow initializes its registry on an ordinary event. The separate
`factory/wakes` and `factory/activity` branches require an explicit owner setup
operation. They never alias `factory/state`, monitor incident state or grant
counters. The journal must never be labelled `factory-ready`; pickup also excludes
its configured number if it is accidentally labelled.

This implementation does not change the three live factory switches, the daily
20-ticket cap, model limits, current concurrency of one, or the usage-ledger
version. The separate stopped/idle migration is still needed before concurrency
two can be enabled.

## Later rollout, after CI and a separately authorized Claude Pro review

1. Merge only after the required native CI and genuine current-head review pass.
   Keep this harness ticket unlabelled. Do not run the steps below merely because
   the PR exists.
2. Create one owner journal issue with an operational description. Apply no labels;
   subscribe to it. Save its number as `FACTORY_ACTIVITY_ISSUE_NUMBER`, leaving the
   two new enable flags absent/false and the existing switches unchanged.
3. Actions → **Factory event wake** → **Run workflow**, branch `main`, operation
   `initialize`, preview checked. This is an initialization preview, not a model
   run. Repeat with preview unchecked only when registry creation is authorized.
4. Actions → **Factory activity** → **Run workflow**, branch `main`, operation
   `initialize`, preview checked; then separately authorize the same initialization
   with preview unchecked. It validates the journal against the usage ledger.
5. Preview **Factory event wake**, operation `preview`, preview checked, issue set
   to a bounded owner app issue. No receipt, reservation or dispatch is created.
   Preview **Factory activity**, operation `preview`, preview checked, with an
   allowlisted completed source run ID. Neither preview posts a comment.
6. Configure native notifications, then separately authorize activity logging.
   Confirm one harmless real journal entry arrives in the owner's email/inbox.
   Offline tests and a successful comment API response do not prove delivery.
7. Separately authorize event pickup and its first controlled eligible-ticket
   trial. Verify actual bot actor/ID, receipt producer, receiver run/attempt and
   current-head source proof. Keep genuine review, protected merging and named
   production approval. Do not reset a failed attempt to force this trial through.
8. For a busy-queue trial, show that a waiting signal consumes no model grant and
   one genuine completion drains the queue once. An empty/idle run must not start
   another idle run. A later two-slot trial requires the separately approved
   ledger migration; this PR does not perform it.

## Native email and mobile settings

In personal **Settings → Notifications**, enable **Email** and **On GitHub** for
watching/participating, and enable your own activity emails if wanted. Under
**System → Actions**, enable Email and leave **Only notify for failed workflows**
unchecked. On this repository select **Watch → All Activity** and subscribe to the
journal. GitHub Mobile's notification list may be called **Inbox**.

Expect healthy/idle messages as well as work and failure messages. Native GitHub
and mail providers may group, delay, filter or suppress email. A journal entry
proves publication only. For deployment approval, open the production review
notification or the exact deployment run in a phone browser and use **Review
deployments → production → Approve and deploy**. Production approval remains human.

Sources: [Actions notifications](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications),
[personal notification settings](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications),
[workflow notification ownership](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs).

## Receipts, uncertainty and bounds

Wake intent is saved before the single dispatch request. An early receiver can
bind the intent before acknowledgment, but only one first-attempt receiver can
claim it. If the response is lost, keep the intent. A matching genuine receiver
can bind/reconcile it; never blindly resend the POST. A failed/cancelled producer
cannot grant a later new reservation. Existing cron can still inspect the queue
under ordinary limits; no counter or receipt is erased to manufacture a retry.

Activity publication uses a compare-and-swap intent, a deterministic comment
marker and an acknowledged comment ID. After an ambiguous POST, the publisher
looks for the same marker and verified bot author. It narrows the search to the
source run's lifetime and reads up to 20 pages. An incomplete search leaves the
receipt open for reconciliation and other events can still be published.

The next activity write upgrades a legacy registry in place. It keeps queued and
unresolved receipts in `activity.json` and moves each acknowledged event ID and
comment ID to its own file in the same `factory/activity` commit. Later writes
preserve those files. Older Git commits and journal comments retain full event
history. A replay checks one event's archive path at the same commit used to
claim publication.

The activity hot file retains its one-megabyte bound and its 1,400 unresolved
receipt limit. The wake registry retains its separate 1,200-receipt bound.
If unresolved activity fills the hot file, inspect the retained receipts and
journal before recovering publication. Keep the registry branch and its history.

The activity observer polls actual job/step metadata every 20 seconds during a
bounded 80-minute window on an in-progress source event. A separate completion
observer captures later final results. Entries may therefore lag by a poll or by
GitHub delivery. Only allowlisted source workflows are observed: neither the wake
nor activity workflow is a `workflow_run` source, and issue comments are never a
wake source. Explicit dispatch separates repeated handoffs from observer chaining.

An early observer waits for receiver binding without binding or authorizing it.
A receiver that finishes before binding is reported as held, never as a model or
review result. Stale dependency candidates produce typed refresh holds with PR
links rather than an idle-queue claim.

Stop request, result and resume notifications come from the retained owner-command
audit, keyed by command identity. They remain reportable after resume and are not
repeated per subsequently observed run. Ancestral ledger snapshots verify those
entries; unresolved runs remain explicit holds. This adds no network requests to
the time-critical stop command. The logger starts with an initialization watermark
so enabling it does not send the entire historical stop backlog. GitHub must still
deliver an observer before a journal entry can appear.

A last verified monitor completion older than 90 minutes produces one warning per
unchanged stale interval; a newer verified completion reports recovery only if
it is actually fresh. This does not claim the application is healthy. With no
delivered GitHub event/timer, no GitHub-only observer can send an immediate silence
warning. An independent watchdog is outside this approved stage.

## Rollback and emergency stop

Disable only the two new opt-ins to stop new event dispatch/publication while
retaining ordinary scheduled operation, all registries and historical counters.
Do not delete the journal or metadata. An in-flight event run may hold at its next
reservation; use the existing `node scripts/factory/stop.cjs --execute` when actual
interruption is required. That command still controls the three master switches
and durable stop and preserves the exact quarantined historical run. Event
dispatches cannot bypass the stop, and notification observers cannot invoke a model.
