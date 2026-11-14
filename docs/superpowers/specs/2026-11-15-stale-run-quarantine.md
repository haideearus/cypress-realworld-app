# Guarded stale-run quarantine

Owner decision: attempt real GitHub recovery, then use quarantine if it fails.
Cancellation and force cancellation returned 409. The one guarded rerun returned
403 with no new attempt. GitHub's original record remains queued and is retained.

## Approach

Actual provider cancellation is preferred but rejected by GitHub. Deletion and
fabricated status would violate history preservation. An unverified ignore list
could hide a live agent. The selected fallback is one protected-code exception
for run 43467058965, pinned to its old source and pre-job identity, with live
revalidation on every use. It does not purport to repair GitHub's displayed state.

The record has no jobs or model reservation. Its immutable controller validates
the current ledger before admission; the completed drill origin on ticket #38
is rejected by that old policy. Preserve the source hashes and an offline test
of the exact legacy policy. Current code also rejects that run ID at admission.

## Runtime conditions

Exact run/attempt/source/workflow/check-suite/timestamps must match. Its status
must still be queued with no conclusion. Job/check-run/pending-deployment/artifact
collections must be empty, with no active reservation or grant for the run. The
current ledger must retain the valid completed drill record and grant that the
old policy cannot accept. Missing API evidence fails closed.

Stop and resume revalidate the case. Any changed fact restores ordinary handling;
running or unproven records are cancelled normally or leave the operation
incomplete. Real active runs retain the existing bounded cancellation and
conservative cleanup. Quarantined IDs and their actual queued state are reported
separately from terminal IDs and recorded in audit. No old record is rewritten.

## Scope and rollout

Add a small pinned contract/helper and integrate only stop/resume and current
admission/preflight defense. Keep budgets, roles, branch protection, monitoring,
and the three false agent switches intact. Prepare a draft PR with offline tests
and local independent review; start no Claude session and perform no live stop or
resume. Installation remains subject to the normal genuine review gate. The
one-minute live-agent demonstration remains pending after installation.
