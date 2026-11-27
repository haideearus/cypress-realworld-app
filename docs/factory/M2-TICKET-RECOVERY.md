# M2: one Settings failure through repair and queue handoff

The acceptance case uses the disposable Settings app and its existing
`form-validation / settings-email-invalid` check. The initial issue contains
the failing assertion, tested commit, and Actions run. A later confirmed sighting
updates one bot-owned evidence comment on that issue. The original issue body
remains the input to the factory's admission and review checks.

## What survives interruption

After the factory has published its repair PR, a cancelled or timed-out
Automatic factory parent can leave the review incomplete. A completion event
asks the controller to reconcile that particular ticket. It verifies the
terminal run and jobs, the original functional incident, the factory-owned PR
and its patch, and the current base. It can then resume CI and independent
review under the same issue and PR. A running parent keeps its slot. A stop
command takes precedence over recovery.

`FACTORY_MAX_AI_SESSIONS_PER_TICKET` optionally sets the combined allowance for
automatic app coding and review reservations (default **6**, range **0–15**).
The ticket pins its ceiling on admission. Older tickets retain all prior
coding and review counts when the rule first applies to them. Lower live caps
apply immediately. Increasing a cap cannot raise a ticket's pinned ceiling.
Coding requires room for a subsequent independent review. An interrupted or
failed reservation still counts. CI, duplicate sightings, branch checks, and
merge reconciliation do not consume a model reservation. Per-invocation turns
and timeouts, per-role counts, the daily limit, and the kill switch also apply.

For example, a ticket with a ceiling of three can reserve one coding session,
one interrupted review, and one fresh review. After those three, another model
call is held. Model-free checks can still verify a merge. Discovery and weekly
planning have their own reservations. Session counts measure authorized
invocations, not tokens or monetary charges.

The completion of a factory parent with a confirmed app merge wakes the
queue. The receiver checks the ledger and GitHub's merged PR and commit before
considering another ticket. Duplicate events share a receipt. A busy slot,
disabled automation, exhausted allowance, or an ineligible candidate can
still delay admission. Human approval of the Render production release and
production-verified issue closure are separate subsequent operations.

## Model-free check

From the repository root, run:

```sh
node --test scripts/tests/factory-m2-lifecycle.test.cjs
```

The test uses the real publication, reservation, assessment, merge and queue
controllers with synthetic browser results, model artifacts and GitHub
responses. It checks the original PR and grant history, both required checks,
and admission of the next ticket while the first issue awaits release
verification. A live subscription review or deployment requires separate
evidence.

## Later disposable rehearsal

1. After review and merge, export the approved **full merge SHA** using
   `node scripts/rehearsal/prepare-settings.cjs --m2-source <full-merge-sha> ../m2-settings-bundle`.
   The exporter creates local files only. The original Settings rehearsal
   command continues to export its historical pinned snapshot. Use the
   [sandbox setup](SETTINGS-REHEARSAL.md) for the repository-scoped identity,
   synthetic app, and required checks.
2. Before a separately authorized trial, confirm the sandbox permits one active
   repair, at least two admissions for that day, and enough review and combined
   allowance for the intended interruption. Keep both protected checks. Apply
   the bundled one-line seed only to the disposable app.
3. Exercise the Settings check and repeat the same failure. Save the original
   issue, its `factory-ready` label, the repeat evidence, and the single repair PR.
   While it owns the slot, queue a second eligible, harmless sandbox ticket.
4. To demonstrate recovery, cancel only the first Automatic factory parent
   after publication, while its initial independent review is running. Leave
   automatic pickup enabled for this demonstration. Record the original
   reservation, the completion-triggered pickup, the same PR number, and the
   later successful assessment.
5. Capture both protected checks on the final head, the confirmed merge, and
   the next automatic admission. Compare the ticket's coding and review
   counters before and after the interruption. The sandbox has no Render
   deployment. In the main repository the named human approves the release.
