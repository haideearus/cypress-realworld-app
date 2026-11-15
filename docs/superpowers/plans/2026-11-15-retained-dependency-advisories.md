# Retained dependency advisory repair

Issue: [#60](https://github.com/haideearus/cypress-realworld-app/issues/60).
Baseline: `ce4322b6548efab5433f7b4fa22b0e210bb46996`.
The owner approved preparation, including the minimal `form-data@4.0.6` lock patch.

1. Preserve failing regressions for retained package selection and misleading
   advisory reporting. Compare actual dependency paths, including nested reused
   entries, rather than only globally added/removed identities or all historical
   versions of a package. Hold ambiguous transitions and bound cyclic traversal.
2. Query all resulting copies of affected names. Hold known-vulnerable new or
   retargeted selections; identify unchanged baseline advisories separately.
   Only call an advisory cleared when absent from all resulting affected copies.
3. Bind the stronger result to report v2. Require it for new reservations and
   premerge writes. Retain v1 history and usage counters. Supply the same scope,
   registry verification and current advisory detail records to the reviewer.
4. Regenerate only existing form-data lock resolutions to 4.0.6, plus necessary
   supporting dependency changes. Keep the app manifest and private tools lock
   unchanged. Prove the actual multipart-header regression fails before and passes
   afterward; run frozen install, app checks, full factory tests and source scan.
5. Obtain a fresh separate local review, resolve findings, and prepare a draft PR
   into this fork's `main`. Genuine Claude Pro review and protected merge remain
   later owner-controlled steps. Do not start Claude, paid AI APIs, deployment or
   another dependency trial. Keep all three factory switches false and monitoring
   unchanged; do not change privileges, limits, history or branch protection.

See the [verification record](../../factory/retained-advisory-fix-verification-2026-11-15.md)
for evidence and remaining deployment/trial boundaries.
