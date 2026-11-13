# Required review-gate reporting: final scope

The owner requested correcting PR #19 and its review findings, keeping both the
issue #11 recovery and native reporting repair in the same PR. The full scope is
[the combined review brief](../../factory/PR-19-REVIEW.md), frozen as issue #20
before admission. Original issue #18 and both of its reviews remain unchanged.

## Final approach

The real pull-request job **Factory review gate** checks out the immutable base
SHA, loads trusted policy and ledger readers, and verifies exact-current-head
independent subscription proof. Its token is read-only; no PR artifacts or model
credentials are used. Missing, stale, fixture, failed or unavailable proof fails.
The actual stdin command is tested for success and failure.

The controller's API check is informational **Factory review evidence**. The
owner/authorized repository manager refreshes only the native failed metadata
job after genuine approval. The proposed automatic rerun helper, extra Actions
write grants and API response-parser change were removed to resolve the permission
finding. All existing workflow/model permissions match main; no paid service or
new secret is added. Existing required checks and their source remain intact.

Alternatives were retaining broader automatic refresh permissions or weakening
the required check. The final design uses one explicit metadata refresh and
preserves the required check. Unattended gate refresh remains later work.

## Recovery and review boundaries

Recovery remains single-use for the existing issue #11 history, preserving both
failed grants, original admission and retries=1. It requires exact configured
coding=2, retries=1, reviews=2 and daily=5; lower values refuse pending recovery.
100 turns, 15 minutes and concurrency=1 remain unchanged. Its historical inputs
must match the live public issue/hash/grants before actual execution.

The owner authorized one additional Claude Pro review against the combined #20
scope, after ordinary CI. #18 stays at two consumed reviews; no ledger reset or
old-approval transfer is allowed. Keep the factory false until ready for that
one run and restore it afterward. No merge, production deployment or actual
issue #11 coding recovery occurs as part of source preparation.
