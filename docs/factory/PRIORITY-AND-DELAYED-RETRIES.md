# Priority and delayed retries

When `FACTORY_PRIORITY_RETRY_ENABLED=true`, Automatic factory selects eligible
production incidents and owner-authored issues marked `factory-priority` first.
The issues still need the usual `factory-ready` label and source checks. Within
each tier it selects the oldest eligible issue. Other newly eligible tickets
come next. Due retries come last. Existing ledger limits, active work, and
merge reconciliation take precedence.

A delayed coding retry is available after a verified GitHub 500, 502, 503, or
504 during supported preparation steps for an ordinary ticket's first automatic
coding attempt. GitHub Actions must report a failed gateway hold and a skipped
Claude step. A 500 is eligible only on the initial read of the reserved issue.
Failures during Claude, review, publication, or CI are outside this coding path.

The delay starts when the failure is recorded. The next owner-dispatched or
scheduled pickup at least 30 minutes later can reserve the retry. Automatic
factory verifies that the original run has ended, the issue is open and
unchanged with `factory-ready`, and its agent branch and PR are absent. It
rechecks the ready queue before writing the reservation. An incomplete bounded
queue lookup holds the retry. An active run completes normally before any
pending work can take its slot.

The second coding reservation is on the original issue and counts under the
existing coding and retry limits. The original grant and daily admission are
retained. If the retry cannot finish, the ticket holds for inspection instead
of starting another automatic coding cycle.

## Resume from a verified stage

- **Unpublished harness failure.** The scheduled pickup can recover #109 once
  it verifies the original failed job, the merged harness fix in PR #111, current
  `main` CI, unchanged issue criteria, and the absence of a publication. The
  retry uses the original ticket and counts against its normal limits.
- **Published PR waiting for review.** Automatic factory can resume a verified,
  factory-authored repair at CI and independent review when the original coding
  and CI passed and the review reservation failed before Claude started. It
  reuses saved CI on the same commit. If `main` advanced, it asks GitHub to update
  the original branch, verifies the same patch, then requires fresh CI and review
  on the new commit. The prior CI, coding attempt, and any spent review remain in
  the ledger. If a successful recovery run reserved a review but GitHub skipped
  the review job, pickup can continue once more after verifying the skipped job
  and the saved CI. The next reservation counts under the same review limit. A
  conflict, changed patch, failed check, or exhausted allowance is reported as a
  hold. Recovery does not send an unconfirmed update twice.
- **Dependency preparation ending before Claude.** Factory event wake checks the
  finished dependency attempt and its evidence, then can wake Dependency
  maintenance for a different candidate that already has current passing CI.

## Preview

The setting is off when absent. After review and merge, you can turn on only
`FACTORY_PRIORITY_RETRY_ENABLED` and run **Automatic factory** on `main` with
its preview option checked. Keep the factory and automatic pickup switches off
for this preview. The summary identifies the selected issue or explains a
hold. Preview creates no reservation, invokes no model, and changes no issue.
