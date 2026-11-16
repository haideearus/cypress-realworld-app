# Dependency review release and form evidence

Correction ticket: [#70](https://github.com/haideearus/cypress-realworld-app/issues/70).
The #57 trial passed analysis/CI but held on a reviewer claim that no official
4.18.1 release existed, plus a request for form compatibility evidence.

The trusted packet now adds:

- Official stable release identity, publication time and GitHub-verified signed
  annotated tag for updated lodash/lodash-es versions. Only the fixed upstream
  repository lodash/lodash is queried; package-supplied URLs cannot choose a host.
  Other packages retain registry/OSV facts without invented upstream attestation.
- The correlated CI run from the existing ledger, exact candidate head and
  successful verify job/attempt, with unit and API/browser suite step receipts.
- Candidate-local file paths and immutable source links for existing profile,
  sign-up/login, bank-account and settings validation/submission tests. These are
  suite-level receipts plus source definitions, not verified per-test results or
  universal compatibility. The read-only reviewer inspects those files locally.

The signed tag is upstream evidence, not npm provenance or an assertion that the
npm distribution is identical to the tagged source. The published npm gitHead can
belong to the separate built-distribution branch. Remote prose is not copied as
instructions. Current source facts take precedence over remembered release history;
the reviewer still independently decides whether concrete concerns block the PR.

Collection retains the existing two-minute shared deadline, one-MiB response and
256-KiB packet bounds. At most four configured updated package/version pairs add
upstream lookups. Missing/mismatched records, failed/incomplete CI and public API
outages/rate limits hold. No new token scopes, model tools, provider credentials,
workflow permissions or paid service are introduced. Counters and required gates
are untouched.

## Next permitted reviews

1. Keep all three factory switches false while this owner-authored harness PR
   runs ordinary CI. Its separately authorized Claude Pro review uses issue #70
   and the existing owner-PR review path. Do not start a dependency review yet.
2. After that review passes, merge normally through both required checks. Restore
   the stopped state and false switches after the review, as usual.
3. Only after the correction is merged, request `@dependabot rebase` on #57. Check
   that the new bot head includes the corrected main and differs from ecdb52c.
4. Recheck metadata/CI eligibility without changing flags or pretending an offline
   check is an admission. The durable owner stop also applies to workflow previews;
   use read-only inspection until the next explicitly authorized resume.
5. Authorize the next controlled dependency trial separately. Retain #57's first
   attempted head and used review. A genuine new head can consume its next allowed
   review under the unchanged lifetime/daily caps. No refund, reset, same-head
   replay or hand-written approval is permitted.
6. Automatic merging still requires fresh same-head review, fresh premerge facts
   and native branch checks. Production deployment retains named human approval.

## Verification during preparation

The missing adapter regression was observed failing before implementation. The
full factory suite then passed with 538 passing and 10 optional skips (548 total).
Tests cover wrong release/tag/source identities, unsigned or mismatched tag objects,
wrong CI heads/repository/correlation, failed jobs, missing suite steps, partial
job listings and outage holds. The worker integration verifies the packet reaches
the model context with read-only tools and no ledger write.

A credential-free public-data replay for #57 head ecdb52c on 2026-11-16 checked
official release 304304513 (published 2026-04-01), verified annotated tag object
454999199c880707789e941d14e5a62e0c7527fa targeting
cb0b9b9212521c08e3eafe7c8cb0af1b42b6649e, and successful exact-head CI run 43860055419. This local replay is diagnostic evidence, not an independent approval
or a reusable same-run workflow grant. The future workflow collects fresh facts.
