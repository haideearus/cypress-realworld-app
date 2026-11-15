# Current dependency review facts: verification

Issue: [#55](https://github.com/haideearus/cypress-realworld-app/issues/55).
Baseline: `a013f61ba98c733025d3eed06daa31a2add20639`.

## Problem and change

PR #52's read-only reviewer lacked current registry records and affected-version
ranges. Its findings included release-existence and legacy-fix assertions that
conflicted with current primary sources. This correction supplies fresh facts;
it does not approve PR #52 or discard its review history.

Only the dependency role receives an additional packet. Trusted helpers read the
immutable dependency files, validate public registry identity/checksums, repeat
OSV queries and fetch current advisory ranges. Missing or mismatched data holds
preparation. The read-only model tools, review schema, v1 stored analysis report,
premerge checks, native gate, subscription authentication and AI limits are unchanged.

## Regression and fixture evidence

With tests added before implementation, the collector test failed because the
trusted collector did not exist. The real worker integration test then failed
against the baseline with `reviewer is missing current registry facts`: expected
`1.0.1`, received `undefined`. Both logs were preserved outside the source tree as
`dependency-evidence-red.log` and `dependency-worker-evidence-red.log`.

Initial implementation at `b6eb56e`:

```text
node --test scripts/tests/factory-*.test.cjs
# tests 484
# pass 474
# fail 0
# skipped 10
```

The ten skipped tests require optional Docker/scanner integration environments;
they are not reported as executed. The suite exercises registry identity and
integrity mismatches, OSV candidate vulnerabilities, advisory identity/package/
modification mismatches, withdrawn records, malformed ranges, outages, redirects,
oversized/partial responses, explicit affected versions (alone or with ranges),
metadata URL isolation, collection freshness, exact
worker commit binding, base/main movement and unchanged ledger state/tool scope.

`yarn lint`, explicit Prettier checks for all changed files, and
`actionlint -shellcheck= .github/workflows/factory-model.yml` exited 0. Shellcheck
was disabled explicitly; the changed install command is a plain `npm ci` in the
trusted tools directory. The application manifest, Yarn lock and private parser
lock are unchanged. Native PR CI remains responsible for the full app/runtime
suite; this local verification does not claim to run Docker or production tests.

## Actual public-service read-only check

The collector was run against the immutable files of PR #52:

- Base: `a013f61ba98c733025d3eed06daa31a2add20639`.
- Head: `5b3d4c0a7580d93ef148996e0dacf30fbfe2e5fa`.
- Observed: `2026-11-15T14:53:34.423Z`.
- Added registry identities: `axios@0.35.0`, `follow-redirects@1.16.3`.
- Both registry records matched the candidate lock integrity and URL hashes.
- Six changed package/version identities; 30 advisory detail records.
- Compact packet: 16,654 bytes; no affected added version reported by OSV.
- Model calls: 0. Ledger writes: 0.

The fresh local reviewer caught an initial omission of explicit affected-version
lists. Two new regressions failed before the correction and passed afterward;
the normalized packet now retains both ranges and bounded explicit version lists,
including versions-only records. The RED log is `dependency-evidence-versions-red.log`.
The same reviewer rechecked the correction, independently ran 21 targeted tests
successfully, and reported no unresolved Critical, Important or Minor findings.
The complete staged source snapshot (417 files) and the saved live packet passed
the checksum-pinned secret scanner.

The packet includes the actual advisory event ranges; for example, the Axios
absolute-URL advisory records the legacy `0.30.0` fix. This is an observation for
these exact versions, not a certification that the app has no vulnerabilities.
The saved live packet is local verification evidence, not reused input for a
later model session; every future dependency preparation fetches fresh facts.

Primary source contracts:
[npm registry API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md),
[OSV batch queries](https://google.github.io/osv.dev/post-v1-querybatch/),
[OSV advisory detail API](https://google.github.io/osv.dev/get-v1-vulns/).

## Operational boundary

All three factory switches remained false during initial preparation. Monitoring stayed
unchanged. No Claude run, paid AI API, merge, deployment, counter reset or branch
protection change was performed. A fresh local agent review and final checks are
recorded in the PR. Genuine Claude Pro review and the required native checks
remain necessary before merge. Retrying PR #52 later requires a fresh genuine
Dependabot commit; this PR grants no same-head retry exemption.

## Follow-up to the first Claude Pro review

The owner authorized and ran [review 43729011956](https://github.com/haideearus/cypress-realworld-app/actions/runs/43729011956)
under issue #55 for head `b6eb56e`. The workflow completed, but the verdict was
`changes_requested`: the new workflow path needed structural regression coverage.
One review remains consumed; its verdict and ledger history are preserved. All
three switches were confirmed false afterward, the ledger was idle, and no
further Claude run was started while addressing the findings.

The follow-up tests now check trusted parser installation before candidate
checkout, dependency-only guards, credential isolation, preparation and both
scans before the exact-file upload, fail-closed behavior, artifact path and
seven-day retention. The new workflow test failed on the omitted
`include-hidden-files` input. The pinned upload action excludes files inside
dot-directories, so the workflow now enables this input for the single scanned
`.factory-input/dependency-facts.json` file. It does not upload the directory or
broaden the artifact's contents. See the pinned action's
[hidden-file rules](https://github.com/actions/upload-artifact/blob/ea165f8d65b6e75b540449e92b4886f43607fa02/README.md#uploading-hidden-files).

Eight isolated, in-memory workflow mutations were rejected by the new regression:
upload before scan, parser install after candidate checkout, weaker role guard,
ignored scan failure, broader upload path, omitted hidden-file input, longer
retention and missing-file warning. These checks did not modify the repository
workflow or contact GitHub. Three additional collector tests exercise the actual
holds at 51 added versions, 101 advisory IDs, and a packet over 256 KiB built from
individually valid bounded responses. No production collector limit changed.

```text
node --test scripts/tests/factory-workflows.test.cjs scripts/tests/factory-dependency-evidence.test.cjs
# tests 25
# pass 25
# fail 0

node --test scripts/tests/factory-*.test.cjs
# tests 488
# pass 478
# fail 0
# skipped 10
```

Logs are retained locally as `dependency-review-workflow-red.log`,
`dependency-workflow-mutations.log`, `dependency-review-followup-targeted.log` and
`dependency-review-followup-factory.log`. The original PR head's complete
[native CI 43727062749](https://github.com/haideearus/cypress-realworld-app/actions/runs/43727062749)
passed, including app/runtime checks. Those results belong to the original head;
the pushed follow-up requires fresh native CI and another genuine Claude Pro
review before merging.

A fresh separate local agent independently reran all 25 targeted tests with Node
22.20.0, actionlint and the diff check, and found no blocking findings in the
follow-up. A live runner upload was not exercised by these local checks; the
actual dependency workflow remains a later authorized trial.
