# Retained dependency and form-data verification

Issue: [#60](https://github.com/haideearus/cypress-realworld-app/issues/60).
Baseline: `ce4322b6548efab5433f7b4fa22b0e210bb46996`.

## Problem and resulting behavior

The [PR #52 trial](https://github.com/haideearus/cypress-realworld-app/actions/runs/43742253061)
completed with a blocking review. Its candidate retained `form-data@4.0.4`, but
the old identity-difference analysis reported a removed version's advisory as
fixed. This repair checks retained versions selected by changed paths, including
reused descendants, and verifies their registry identity/integrity.

All resulting versions of affected names are queried. Newly selected or retargeted
vulnerable versions are held. Advisories on unchanged baseline copies are reported
as remaining, not cleared; incremental updates do not require unrelated bulk
dependency upgrades. The summary is explicitly limited to affected package names,
not the entire app. New report v2 is required at admission and premerge; historical
v1 reports and all lifetime counters remain readable and unchanged.

## Failing-before evidence

New regressions were run against the baseline before implementation. Five failed:
retained deduplication, existing root selection, remaining affected copies,
vulnerable retained candidate rejection and stronger proof schema. An additional
edge-retarget regression failed before its correction.

The actual old `form-data` multipart encoder also failed a functional test: CRLF
in an untrusted field name injected an extra multipart header. The lock inventory
test failed because affected 4.x versions remained. These were local synthetic
payloads and did not make any request to production.

A fresh local reviewer found two path-classification defects in the first repair:
missing reused descendants and treating unrelated historical parent versions as
actual predecessors. Both new regressions failed before correction. The corrected
worklist compares actual path transitions recursively; a visited-pair set stops
cycles, comparison/pending bounds hold oversized graphs, and unattributable new
selectors are held. Root and nested major/downgrade protections remain enforced.

RED logs are retained outside the source tree: `retained-advisory-red.log`,
`retained-edge-red.log`, `retained-descendant-red.log`,
`retained-path-baseline-red.log`, `form-data-lock-red.log` and
`form-data-encoding-red.log`.

## Minimal application dependency patch

All three existing form-data selectors (`^4.0.0`, `^4.0.4`, `~4.0.4`) resolve to
4.0.6. The lock adds its required `hasown@2.0.4`; existing `hasown@2.0.2` copies
remain. The new mime-types selector reuses existing 2.1.35. No other package
versions, app manifest/resolutions or private parser-tool lock changed.

In an isolated copy containing only the public manifest and Yarn lock, the old
form-data lock blocks were removed and Yarn Classic regenerated compatible
resolutions with lifecycle scripts disabled. The resulting minimal lock was
installed with `yarn install --frozen-lockfile --ignore-scripts --non-interactive`.
The existing react-virtualized patch was then applied successfully with
`node node_modules/patch-package/index.js --error-on-fail`.

Registry integrity and URL SHA-1 values for 4.0.6 match the
[npm version record](https://registry.npmjs.org/form-data/4.0.6).
[GHSA-hmw2-7cc7-3qxx](https://github.com/advisories/GHSA-hmw2-7cc7-3qxx) identifies
4.0.6 as the patched 4.x release. The functional encoder test now escapes the
synthetic field/filename CRLF instead of adding multipart headers.

## Local app verification

The following commands exited 0 with Node 22.20.0 and Yarn 1.22.22:

- `yarn types`.
- `yarn lint`.
- `yarn test:unit:ci`: 78 passed, 10 skipped; 11 test files passed, one skipped.
- `yarn build:production`: frontend and server compilation passed.

The frontend still emits the existing large-bundle warning. Local production
database/browser integration was not run: those checks need a disposable `_test`
database. Native PR CI must validate the final commit; no production database was
used for local testing.

`yarn test:factory` passed after the code corrections: 503 tests, 493 passed,
zero failed, ten optional integration tests skipped. The suite includes malformed/partial OSV evidence,
baseline-vs-cleared classification, retained integrity mismatches, v1 replay
rejection, reused nested paths, graph cycles/bounds and the actual encoder test.

The separate local reviewer rechecked both corrections and independently ran
74 targeted tests successfully, with no unresolved actionable findings. This
local agent review does not replace the required genuine Claude Pro review.

## Public-service check of the final dependency inventory

A read-only working-tree verification at `2026-11-15T18:22:48.953Z` compared the
baseline above with the proposed manifest/lock. It queried two removed form-data
versions and 19 resulting versions of affected names, including the reused
es-set-tostringtag subtree. Registry name/version/integrity and lock URL hashes
matched for all 19 resulting versions. OSV reported the two removed-version IDs
`GHSA-fjxv-7rqg-78g4` and `GHSA-hmw2-7cc7-3qxx` as cleared within this scope;
`remainingBaseline` was empty. Unchanged manifest contents were verified.

The same code held PR #52's immutable old head
`c89871f643c936d958a861d738ebca623f3963c9`, which still selected affected
form-data 4.0.4. The saved local record is
`retained-advisory-live-verification.json`: zero model calls and zero ledger
writes. This precommit working-tree observation is not reused as immutable
review/merge proof; the workflow must fetch fresh evidence for its own exact head.

## Operational boundary and next trial

All three factory switches remain false; monitoring stays unchanged. This repair
starts no Claude session, paid AI API, merge or deployment. PR #52's blocked heads,
reviews and admissions are preserved. No limits, permissions, branch protections,
gates or counters change.

After genuine Claude Pro review and protected merge of this combined repair,
request a fresh Dependabot rebase/recreation of PR #52, wait for native CI, and
run dependency preview before authorizing another live trial. The new head must
include the patched lock; history does not grant a same-head retry. Production
deployment still requires its named human approval.
