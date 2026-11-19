# Saved-CI review recovery for issue #112

The automatic run published PR #113 and dispatched CI. Its controller failed
before attaching the CI result or reserving independent review. The successful
run and its original request ID are now recorded in the ledger. The recovery
workflow checks that record, the original bot publication and terminal
workflow, and the unchanged ticket criteria before reserving one review.

## Sequence

1. Review and merge the recovery PR through the existing required checks.
   If the terminal run for #112 still holds the sole slot, an owner must
   approve parking it before the recovery PR can have its own review. Verify
   that #112 is the only active ticket and that original run 44431933780 is
   completed. With new work paused, use **Factory agents → Run workflow →
   cancel** on `main`. This releases the old slot and marks the ticket blocked
   while preserving the finished coding grant, passing CI, and counters.
2. Before reviewing #113, update its branch with the default **Update with
   merge commit** option if GitHub requires it. Wait for **Factory CI / verify**
   on the new commit. Use that workflow run number from the URL. The recovery
   accepts only a direct merge of current main into the original PR commit with
   the original two-file patch intact. On the original head and original base,
   leave the updated CI field empty.
3. Open **Actions → Saved CI independent review recovery → Run workflow** on
   `main`. Leave **preview** checked. Enter the updated CI run ID when step 2
   produced a new head. The preview job has read-only permissions and the
   reservation, model, and assessment jobs are skipped.
4. After separate authorization for the live review, keep automatic merging
   off and confirm Claude Pro Extra Usage is off. Enable the main factory
   switch if needed. Run a fresh dispatch with the same CI input and preview
   unchecked. This consumes one review reservation for #112 and uses the
   existing subscription-only reviewer. It has no coding, retry, merge or
   deployment job.
5. After the review passes and assessment saves the proof, refresh the existing
   **Factory review status** check if required. Merge #113 only when both
   required checks are green. If the head moves again or the review fails, the
   current approval cannot be used for that new revision.

The original CI stays in `ticket.ci`. The exact-head CI used by the reviewer
is recorded separately and tied to the new review grant. Emergency stop
includes the recovery workflow. A failed or consumed review does not refund a
counter or trigger a coding attempt.
