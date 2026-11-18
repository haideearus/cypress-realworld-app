# Finding provenance reads and the final issue 96 handoff

**Scope:** Maintenance issue #105. Implement and verify locally, then publish a draft PR.
Keep all factory switches false and all five workflows paused.

1. Reproduce the single-attempt 502 behavior with a stubbed GitHub transport. Prove
   bounded recovery and ensure writes, 403/429, and invalid responses still fail.
2. Pin the completed pre-model failure and fourth grant. Test the new owner-only
   handoff, immutable history, counters, stop, wrong-ticket and replay rejection.
3. Add opt-in read retries to provenance consumers. Reuse the existing finding
   preview/reservation path for the final handoff. Preserve the scanner and gate.
4. Run the focused and full factory suites and the unchanged source scanner.
   Obtain a fresh local review. Audit GitHub state and publish the draft.

## Verification

Base revision `4c27e05d1de2fd75e705d114a1cb44cfd0598359`. With the
new fixtures and the original production code,
`node --test scripts/tests/factory-finding-api-recovery.test.cjs scripts/tests/factory-github-read-retry.test.cjs`
reported six failures and one pass. The GitHub test threw
`GitHub request failed (502)` on the initial read. A separate failing
test captured the reviewed ticket still holding its slot and verified that
the final handoff needed a durable manual-merge restriction.

After the fixes the targeted command reported nine passes. The full
`yarn test:factory` suite reported 828 passes, 14 opt-in skips, and
zero failures. A read-only audit confirmed the original usage commit
`6c458ccdb78c3d9326543a6bd82b994dfa781658`, no active reservations,
the four false switches, five paused workflows, and unchanged issue 97.
