# Saved privacy discovery recovery

The owner authorized a recovery PR using saved Claude output, with settings
unchanged, discovery off, counters and review gates preserved, and no model or
repair execution during preparation. This implements the previously described
separate recovery receipt, not a rewrite of the failed source.

## Narrow source and trust

Only discovery run `44197159640`, grant
`d25c438f-35df-449e-9fe0-ec20d87738f5`, issue #92 and original source
`822b51fb2bb3eaa59d60a109097cc3575e6373d3` are recoverable. Pin the actual saved
artifact ID, ZIP digest and parsed-bundle digest. Preserve the original failed
run, blocked consumed grant, audit issue, report, proposals and raw RED evidence.
An ordinary blocked/cancelled source still cannot enter intake.

The recovery is owner-only, manual on trusted main, attempt 1, preview by default.
It has no model credential, model action, repair/merge/deploy capability or switch
mutation. A live recovery requires the master on, automatic pickup and merging
off, discovery off, no durable stop and no active work. It requires genuine
current-main push CI for its trusted helpers, and original push CI/model-job
provenance for the saved app revision. No production app/credentials are used.

## Verification and receipts

Digest-check and bounded-decode the original ZIP before parsing its sole JSON
member. Build only the original source into the existing isolated synthetic
image. Proposed tests execute only in fresh disposable Docker containers. For
each finding use the latest executed proposal revision, require real RED, replay
it twice and independently probe the fixed trusted oracle twice. A later passing,
timed-out or broken proposal cannot borrow an older failing revision. This is
important here: the first private-transaction test failed fixture setup; the
last revision reached the actual forbidden-read assertion.

The findings metadata retains at most two recovery attempts for this original
grant, consumed before execution. Recovery attempts share the existing eight
daily model-free replay slots with ordinary intake; ordinary per-finding limits
and the four-publication/two-findings-per-source caps remain intact. No AI
reservation or counter is created/refunded. No metadata namespace is initialized
implicitly. Existing registry schema remains readable; optional recovery data
is bounded and validated.

Recovered evidence has a separate artifact and typed producer receipt. The old
source proof stays original; its optional recovery receipt points to a real
successful credential-free replay job and successful finalization/reconciliation
on protected main. Intake verifies both histories, exact artifact metadata,
hashes, current-main replay and ordinary repair admission. Assessment completion
does not imply either finding is a verified bug.

A metadata-only `reconcile` can finish a retained intention after a successful
replay artifact upload and a failed finalizer, without another replay/model or
another permit. A failed/missing replay is retained as held, never promoted.
Stop/cancellation and ambiguous identities fail closed. Original blocked status
is never converted into `discovery_complete`.

## Rate limits and diagnostics

Opt discovery/recovery clients into at most three GET attempts and twenty
seconds total waiting, only with explicit GitHub rate-limit evidence. Unknown
403s and all writes are never retried automatically. Mutation uncertainty uses
retained intentions and later reconciliation. Emit only allowlisted phase,
category and HTTP status, never raw error text, tokens or signed URLs. Long
resets stay visibly held.

## Scope boundary

Preparing/merging this PR runs no recovery and changes no settings. Later owner
authorization controls recovery and publication. Recovery itself only creates
verification metadata/artifacts; normal intake creates at most two qualifying
privacy tickets under existing gates. No repair, automatic merge or deployment
is authorized. Required independent Claude Pro review of this PR is separate
and is not started during preparation.
