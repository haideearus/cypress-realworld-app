# Dependency release and form-test evidence (#70)

Repair the missing reviewer context behind #57's held trial. Keep the existing
independent verdict, scopes, subscription authentication, limits, one-review-per-head
rule and audit history. Use the current checkout on a dedicated branch.

The trusted collector supplies credential-free, bounded GitHub release and signed
tag records for updated lodash/lodash-es versions, using a fixed lodash/lodash
allowlist. It never follows a repository URL from package metadata. Other packages
retain registry/OSV facts without invented upstream attestation. A signed upstream
tag is not npm provenance or proof that the registry artifact is that source tree.

Supply the ledger's exact-head correlated CI run, its successful verify job and
unit/browser suite steps, plus immutable links to existing Formik/Yup form tests.
Report suite receipts and test-source references honestly, not per-test results or
universal compatibility. Fetch public metadata without expanding model token scopes.
Remote source text remains untrusted. Preserve the 120-second collection budget and
existing size/response limits. Missing or inconsistent configured evidence holds.

Current #57 has used its one allowed review for ecdb52c. Do not rerun it or reset
counters. Review/merge this dedicated owner PR under #70 first; then a genuine bot
rebase onto the new trusted main supplies a new counted dependency head.

Alternative considered: manually annotate #57. Rejected because comments are not
the trusted exact-head context and would leave future dependency reviews exposed.

No Claude, deployment, merge, switch edit or bot rebase is authorized by preparation.
