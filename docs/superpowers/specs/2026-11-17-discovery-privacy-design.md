# Trusted verification of privacy discoveries

## Scope and intent

The owner requested inspection of two held discovery findings and a PR adding
trusted verification. Settings remain unchanged, discovery stays off, and no
Claude session, paid AI API, repair, publication or deployment is started.

Run 44179920739 inspected main `0cfd0fda127cdde9067394779424790366408cc8`.
Its two findings reference the same failing API proposal. Both original proposal
replays failed twice, but both findings had `oracle: null` and correctly remained
held. The bank-account detail route is documented as user-scoped; private
transactions are distinct from public and contacts transactions. Both detail
routes currently fetch by ID without checking the current user.

## Approach

Extend the existing fixed catalog with authenticated, empty-query contracts
`bank-account-isolation` at `/bankAccounts/:other` and
`private-transaction-isolation` at `/transactions/:private`. Model-defined URLs,
record IDs, account identities, expected statuses and arbitrary predicates remain
unsupported. Trusting model assertions would bypass the independent verifier;
a generic authorization policy engine would exceed this bounded change.

Each probe uses the immutable image's synthetic seed and a fresh app. Select a
nondeleted bank account with its owner and a different reader, or a private
transaction with its two distinct participants and an unrelated reader. Log in
as each identity with a distinct session, check its authenticated identity before
and after reads, and require successful legitimate reads of the exact record and
its data fields before testing the unrelated reader.
Retain typed, bounded observations without session cookies or credentials.
Matching cross-user disclosure is RED. A denial (401/403/404) with no resource
payload and passing legitimate controls is GREEN. Denials must be error-only
JSON with a canonical `Unauthorized`, `Forbidden`, `Not Found` or `denied` message,
or exact canonical plain text; unknown/extra payloads hold. Broken controls, missing
fixtures, unrelated/malformed records, redirects, timeouts and server errors
remain held. Public/contact visibility is outside these contracts.
Each supported privacy finding must reference a separate proposal file so a
sibling's failure cannot mask the individual repair's GREEN.

The existing two independent oracle replays, original proposal RED, artifact
provenance, current-main replay, ordinary repair RED/GREEN, deduplication,
counters, review gate and deployment approval remain required. No workflow or
permission expansion is needed.

## Historical evidence and rollout

The old report/artifact is immutable. This PR must not replace `oracle: null`,
backfill a verified status, rewrite receipts or manufacture source provenance.
Future separately authorized discovery reports can select the supported
contracts. A qualifying finding can then use the existing verified intake and
repair pipeline. Reusing the two historical candidates without another model
session would require a separately designed, provenance-checked supplemental
replay path; that path is not silently added here.

## Verification

Run offline catalog/probe tests and existing finding-intake/repair tests. Exercise
the real API routes locally with synthetic in-memory state and no live account.
Extend native CI's existing isolated-image smoke test to check both oracle
contracts without a model; accept either a valid disclosure or a valid denial,
so later app fixes do not make the verifier's own smoke test fail. Preserve
failure-before evidence for the unsupported catalog and report local Docker
availability honestly.
