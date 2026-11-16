# Dependency review status refresh

Ticket: [#74](https://github.com/haideearus/cypress-realworld-app/issues/74).

Dependency assessment currently saves its review but leaves the earlier
`Factory review evidence` check unchanged. Refresh that informational check after
the assessment commits, using the existing `Controller.gate` ledger validation.
Publish a passing check only when genuine proof covers the current PR head.
Blocked reviews publish failure; invalid artifacts never reach publication.

## Approach

Reuse the same checker already called by owner PR assessment. A separate workflow
dispatch would add another asynchronous dependency; replacing the check with a
constant success would discard its proof. The existing checker needs only
`checks: write` on the trusted dependency assessment job. Model permissions and
credentials remain read-only and subscription-only.

If publication fails, propagate the failure and retain the completed assessment,
approval or blocked verdict, grant and counters. Existing metadata-only gate
dispatch can recover publication without another review. Native required checks,
clean mergeability, merge confirmation and named deployment approval remain in
force. No live ledger migration, counter reset, new variable or secret is needed.

During preparation all three factory switches remain false and the durable stop
stays active. Do not run Claude, the dependency trial, a merge or deployment.
