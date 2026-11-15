# Unchanged prerelease baseline fix — November 15, 2026

Maintenance ticket: [#53](https://github.com/haideearus/cypress-realworld-app/issues/53).
Failed controlled trial: [run 43713470670](https://github.com/haideearus/cypress-realworld-app/actions/runs/43713470670).
Base revision: `8363e411eb9e766f777f26031f2765e2e4cbe223`.

## Cause and change

PR #52 updates axios from 0.28.1 to 0.35.0. The existing root dependency
`@mui/lab` remains at range `^5.0.0-alpha.167`, resolved to `5.0.0-alpha.175` in
both snapshots. The root compatibility check treated that unchanged prerelease
baseline as a newly proposed unsupported version and threw
`Unsupported dependency version` before CI or model reservation.

Compare root versions only when their resolved versions differ. Root lock
completeness and range satisfaction are still checked. New or changed entries
still pass the existing registry/integrity/stable-version validation, while
changed root resolutions still pass the full major/downgrade/prerelease gate.
No quota, permission, origin, report, OSV, CI, review or merge rule changes.

## Failing-before and passing-after

Before the fix, `node --test scripts/tests/factory-dependency-analysis.test.cjs`
finished with 13 passed and two failures, both reporting
`Unsupported dependency version`:

- An unrelated stable update with an unchanged prerelease root dependency.
- The actual checked-in application manifest and lock analyzed against themselves.

After the fix, all 16 analyzer tests passed. The explicit regression rejecting
an upgrade of the existing alpha dependency still passes, along with the prior
new-prerelease, root-edge downgrade, major, registry, OSV and report guards. A
table-driven guard also rejects source, integrity and dependency-edge changes
to an existing prerelease entry even when its version string stays identical.

`yarn test:factory`: 464 passed, 10 skipped, zero failed (474 total).
Explicit Prettier and staged-source secret scanning also pass.

A fresh separate read-only local review found no Critical or Important findings.
Its minor suggestion to preserve the same-version metadata boundary as a committed
regression was addressed by the table above. This is not a genuine cloud
subscription review and supplies no authorization for a new live trial.

## Read-only real proposal check

Using immutable GitHub contents from base
`8363e411eb9e766f777f26031f2765e2e4cbe223` and PR #52 head
`660dbd10925a7907098534842bd6e26f700c55bc`, the fixed pure analyzer identified
six added/removed package/version identities. The public unauthenticated OSV
batch check completed without reporting an affected added version and recorded
30 advisory identifiers associated with removed versions. This describes only
the changed inventory; it does not certify the entire app as vulnerability-free.

This local diagnostic executed no candidate dependency code, wrote no ledger
state, invoked no model and started no GitHub workflow. It is not a replacement
for the cloud analysis, correlated CI and genuine subscription review.

## Controlled-trial state and recovery

The failed cloud trial completed its finalizer: PR #52 is blocked, its admission
and attempted head are retained, the global lock is free, and coding/review counts
are both zero with no model grant for the ticket. Both temporarily enabled
switches were restored to false after verifying the parent workflow terminal.
Automatic merging remains false. The daily admission is not refunded.

This fix does not exempt that failed head from the one-attempt rule. After the
fix has its required review and is merged, obtain a genuine updated bot head
through Dependabot's normal rebase/update path before a separately authorized
trial. Preserve all counters and old run history. No new Claude run, paid AI API,
dependency upgrade, merge or deployment is authorized by preparing this fix.
