# Rehearsal implementation verification — 2026-11-14

Scope: issue #35, isolated monitor-created ticket → one Claude coding reservation
→ deterministic recovery verification. This record covers implementation tests;
it does not claim a live cloud rehearsal or Claude invocation occurred.

## Local verification

Node `22.20.0`, Yarn Classic `1.22.22`, Windows host with Linux Docker `29.9.2`.

- `FACTORY_DRILL_DOCKER_TEST=true yarn test:factory`: 381 tests, 379 passed,
  zero failures, two Windows-inapplicable filesystem checks skipped. The six
  Docker integration cases ran rather than skipping.
- `yarn types`: passed.
- `yarn lint`: passed.
- Explicit Prettier checks on all new/changed CJS, workflows and documents: passed.
- Actionlint `1.7.12` on the rehearsal and CI workflows: passed.
- Whitespace/diff check: passed.

Factory CI additionally executes the sandbox tests on Linux, where the two
Windows-inapplicable cases can run. Its actual result must be checked on the PR.

## Failure-first evidence

- Shared monitor tests initially failed for the missing drill namespace and
  transition interface; after implementation, the existing production guards
  and new isolated lifecycle tests passed.
- Drill policy tests initially failed for missing origin, repeat/reservation,
  normal admission/publication and broad worker capabilities. New tests verify
  one consumed grant, no reclassification, no approval and cancellation safety.
- Finalizer tests reproduced acceptance of a self-consistent report belonging to
  a different run. The finalizer now builds the expected identity from the actual
  ledger grant and workflow context; the mismatch regression passes.
- A real malicious Git clean-filter test executed a marker before the collector
  fix. Drill collection now uses filesystem reads only, preserves the seeded
  regression, and emits only the fixed implementation file; the marker stays absent.
- Docker tests showed that extra return properties could pass the HTTP oracle
  despite failing the seeded contract. The trusted server now captures its
  operations before candidate loading and validates the exact contract. Extra
  fields and patched globals cannot produce a false passing result.

## Boundaries exercised

The tests cover disabled/preview no-write paths, context/attempt identity, ledger
caps, durable intent before issue creation, failed-publication deduplication,
modified issue/report rejection, still-running worker lock preservation, successful
issue cleanup, retained usage/history, and rejection by production approval paths.

Actual Docker checks cover the seeded readiness failure, a sample valid repair,
unhealthy CLI reports, malicious stdout, read-only source mounts, separate process
identities, denial of access to the oracle's process data/signals, no external
network interface and no inherited host credential canary. Candidate code is never
loaded by the host verifier.

## Review and manual actions

A fresh local reviewer found the seeded-contract mismatch above; it was corrected
and the reviewer reported no remaining substantive findings in the follow-up.
This local review does not replace the required independent Claude Pro review of
the installation PR.

The owner approved the design and preparing a PR. No repository switch, limit,
secret, branch-protection rule, billing setting or production application state
was changed. No model invocation, workflow dispatch, merge or deployment was
started by this implementation work. Ordinary non-AI PR CI is expected on opening
the draft PR.

The remaining proof is deliberately separate: review and install the PR, preview
the workflow, then explicitly authorize and observe the one-attempt cloud trial.
See [operator steps](MONITOR-REPAIR-REHEARSAL.md).
