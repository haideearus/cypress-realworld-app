# Output isolation and budget extension

Owner scope: issue #21. Fix the reproduced unit-data/collector collision and
increase bounded work limits in one reviewed PR. Keep the factory false until
ready; preserve subscription-only authentication, history and branch protection.

Use Vitest's own `VITEST=true` marker for in-memory unit data, preserving other
runtime modes. Validate artifact paths before reads and identify rejected output
without exposing content, secrets or absolute paths. Keep publication boundaries.

Raise ceilings to daily10/coding5/reviews5/retries4/turns200/minutes30, concurrency1.
Validate ledger counters against absolute maxima; retain the one legacy recovery
offset in retry accounting and all marker/grant identity checks. Existing issue11
can use ordinary fourth/fifth attempts without a migration or reset; sixth and
repeat recovery are refused. Lower configured limits still stop pending calls.

Extend the existing serial entry workflow to five cycles. Derive the next slot
from its current cycle and refuse invalid slots. A terminal failure must release
the lock without leaving a future reservation. An unpublished blocked retry uses
current main; a published retry retains its PR head and orphan checks.

Alternatives were raising the artifact byte boundary (would still publish a
forbidden data path), resetting counts (loses the audit trail), or adding another
bespoke recovery exception (unnecessary after the owner's general budget change).
The chosen approach fixes the failure mechanism and uses normal counted retries.

Regression evidence covers unchanged disk bytes across real unit mutations,
collector path/size/redaction errors, budget boundaries, legacy history, all five
cycles and terminal lock release. Normal CI and a genuine independent review
must pass before merge/configuration. No production deployment is part of this
harness repair. Operating values and run instructions are in
[the guide](../../factory/ARTIFACTS-AND-LIMITS.md).
