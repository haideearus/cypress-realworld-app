# Required review-gate reporting

Repair [#20](https://github.com/haideearus/cypress-realworld-app/issues/20) in existing PR #19.
The owner authorized implementation, keeping the factory disabled, protection
unchanged and all model sessions prohibited during this repair.

## Evidence and approach

The genuine review of `40eb635` is saved, and the custom check API reports
success, while GitHub's PR merge decision remains blocked/Expected. The report
attaches to a different workflow suite than the working PR #17. This association
is evidence, not a claim to know GitHub's entire internal evaluation.

Use a real `pull_request` job named **Factory review gate**. Its inline verifier
loads policy and ledger readers from the immutable trusted base SHA, never the
PR checkout. It reads the current PR and ledger, checks the event's exact head,
and fails unless genuine independent subscription proof covers that head.
The inline entry is necessary before this repair exists on main; it contains
only metadata checks and has a read-only token and no model/production secrets.

Keep the custom API report as **Factory review evidence**, an informational
record rather than the required gate. A real successful review may refresh the
matching failed native gate run once. Only the fixed gate workflow, original
pull-request event, exact head and PR may be rerun. Do not rerun cancelled work,
another workflow, a second run attempt, or anything without valid proof.

The alternatives were continuing the unrecognized custom check (does not solve
the observed failure) or changing required protection/source (outside the
owner's request). A native required job preserves the protection's exact name
and GitHub Actions source without adding credentials or paid services.

## Boundaries and rollout

Keep FACTORY_ENABLED=false, 100 turns, five daily tickets, two coding attempts,
two reviews, one automatic coding retry and one active ticket. The gate has no
AI credential and does not reserve or refund usage. Only trusted assessment/gate
jobs gain Actions write to refresh that fixed workflow; model roles stay read-only.

The changed PR head must fail the gate until separately authorized fresh review.
Its old approval must never be rebound. During bootstrap, main still has the
old controller, so after that later review the owner reruns only the new gate's
failed pull-request job. After merge the updated controller refreshes it.
No merge, deployment, protection edit, ledger write or model run is authorized
by this repair. Verify native failure reporting live, rather than claiming
merge readiness from a custom check's green API record.
