# Preserved stale-run evidence

Owner maintenance decision: [issue #42](https://github.com/haideearus/cypress-realworld-app/issues/42).
Observation: `2026-11-14T22:26:22.958Z` (15 November in Bucharest).

`evidence.json` contains public provider observations, the failed one-use rerun,
source hashes and the genuine completed drill #38 record. The original run
remains queued; no attempt, grant, counter, issue history or provider status was
rewritten. Earlier cancel and force-cancel requests returned 409. The rerun
returned 403 with request ID `E7A5:17DCB2:97811EC:E5B294A:6AF8E010`.

The `.txt` files preserve the actual frozen source at
`421553c2c108dc2704ef6cec7864582b8c63ead6`, rather than a reconstructed predicate.
SHA-256 pins apply to UTF-8 source with LF line endings. CI checks those pins and
executes the archived policy/recovery modules in a temporary, credential-free
Node permission sandbox. A valid ordinary baseline passes; the valid current
ledger containing the completed drill is rejected. The other archived source
shows that pickup reads/validates this ledger before admitting work, and the
model cycle depends on successful pickup. Archived code is evidence only and is
never imported by the running factory.

This static snapshot authorizes no runtime omission by itself. Protected code
rechecks live identity, empty execution collections, absence of reservations and
the retained completed drill each time. New jobs, attempts, source, reservations,
changed containment or missing API evidence remove the exception. No arbitrary
zero-job run receives this treatment. The quarantine code denies replay under
current admission/preflight as a separate defense.

Provider observations are not transactional: an API snapshot cannot guarantee
that GitHub's display never changes immediately afterward. Containment therefore
also depends on the immutable old controller's refusal, rather than empty jobs
alone. If history must later be migrated, stop first and revisit this exception
under a new reviewed maintenance change; do not silently remove drill #38.

The implementation PR performs no live stop/resume, Claude invocation, deployment
or switch mutation. The original record is preserved and remains visibly queued.
