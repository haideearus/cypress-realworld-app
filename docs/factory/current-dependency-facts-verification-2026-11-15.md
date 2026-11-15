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

After implementation:

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

All three factory switches remained false during preparation. Monitoring stayed
unchanged. No Claude run, paid AI API, merge, deployment, counter reset or branch
protection change was performed. A fresh local agent review and final checks are
recorded in the PR. Genuine Claude Pro review and the required native checks
remain necessary before merge. Retrying PR #52 later requires a fresh genuine
Dependabot commit; this PR grants no same-head retry exemption.
