# Weekly AI features

The feature workflow starts off. `FACTORY_FEATURE_MODE` is unset or `off` by
default. The feature switch governs publication and new feature model steps.
Main CI, independent review, protected merge, and named human Render approval
apply to every implementation PR.

## Rollout

1. Dispatch **Weekly AI features** on `main` with **preview**. This job has
   read-only permissions and receives no model credential. It shows the pilot
   candidate and the current Bucharest week's planned, merged, and deployed
   counts. Merge counts come from the usage ledger. Deployment counts reflect
   completed bot closures from the approved production release path.
2. When the usual factory controls are on and current main CI is green, set
   `FACTORY_FEATURE_MODE=pilot` and dispatch **pilot**. This can publish one
   minor amount-filter accessibility feature from a checked repository
   observation. If a job is active, the pilot waits for its slot to clear.
   The pilot uses no model to plan the issue. Automatic factory pickup uses
   the existing metered coding and review jobs for implementation.
3. Follow the pilot through the exact-head review, protected merge, named Render
   approval and verified issue closure. Check the Claude Pro account Usage page
   across the five-hour and weekly windows with Usage Credits off. Review GitHub
   job-token headroom during busy windows before switching to `live`.
4. Switch to `live` to let the planner choose across ordinary demo-app features.
   Each proposed user problem needs a matching excerpt from the tested app source
   or a maintainer-authored issue. Validate the pilot and provider action end to
   end before enabling live planning.

## Scheduling and limits

In `live` mode the workflow requests a turn at 11:04 and 17:04 Europe/Bucharest.
Each Monday-to-Sunday Bucharest week permits one Claude Pro planning reservation,
including failed, cancelled, and empty runs. The planner has one constrained
structured-output turn and no tools. Its reservation consumes the shared
daily budget and one model slot until settled. Scheduled pickup can release an
abandoned reservation after confirming the exact producing attempt is terminal.
The direct stop cancels the planner alongside the existing model workflows and
keeps the metering record.

A scheduled request or an explicit pilot is recorded in the usage ledger
without reserving Claude. One turn can wait at a time, and any active job and
pending merge reconciliation can finish. If a production incident is active,
its verified repair can take the next slot. The feature turn stays waiting.
Otherwise new automatic app repairs, dependency admissions and discovery sweeps
yield to the feature turn. Verified completion events recheck it on the current
`main`, and the next schedule provides a fallback. A turn expires after 24
hours if no run can handle it.

A turn can reserve the weekly planner, advance one publication, or select an
already-ready feature issue. When an issue is ready, Automatic factory gives it
the next eligible pickup. The existing daily limit and current-main CI still
apply. If GitHub headroom is too low, the turn records a later eligibility time
and routine work can proceed. The controller retains a quarter of observed
GitHub quota and defers within a minute of reset. If a selector stops during
verification, its five-minute priority claim expires while the turn stays
recorded for a later check.

Switching feature mode off pauses new feature steps and fresh feature merges.
Already-admitted feature code and review retain their normal slot and exact
evidence checks. Recorded merge intents still reconcile through the existing
read-and-confirm path.

## Issue and stage lifecycle

A plan can contain up to one major and five minor improvements. Duplicates
against durable planned titles, matching evidence, or open issue titles are
held. A major has an unqueued tracking parent and up to five native GitHub
sub-issues. Those stages count toward the single major and become ready in
order, one at a time, after the preceding stage merges. A stage already in
progress can carry across weeks. Unstarted proposed work ages out after its
planning week.

The publication registry lives on `factory/features`. Each issue create has
a durable intent before the GitHub call. If the response is lost, the next
run will adopt an exact matching bot issue and leave the intent held when the
result cannot be established. A feature receives `factory-ready` only after
the saved issue identity and, for majors, the parent relationship have been
verified. If an issue event gets ahead of the final ready receipt, the normal
Automatic factory schedule checks it again. Leave the immutable issue title,
criteria and origin marker intact.

Production closure checks both the reviewed merge and the approved healthy
live release. A major parent closes only after all linked stages have trusted
completion evidence and the same live release still covers them. A later edit
affecting a prior stage's verified paths can hold automatic parent closure for
review. Recorded queue and rollout summaries make the planned, merged and
deployed outcomes independently visible.
