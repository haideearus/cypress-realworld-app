# Finding output proof and bounded recovery implementation plan

> Execute inline using superpowers:executing-plans; obtain a fresh local reviewer before delivery.

**Goal:** Correct the two Postgres health probes, the complete final repair artifact schema, and prepare one bounded output-failure recovery for #96.

**Architecture:** Keep raw finding proofs and historical receipts unchanged. Emit a strict version-2 wire receipt with a public `findingRef`; assemble and scan the entire finalized bundle in the production GREEN path as well as the existing pre-upload scan. Add a separate owner-only output recovery receipt pinned to the third blocked grant, using the existing manual preview and ordinary counters.

**Spec:** User-approved combined scope and maintenance issue #103.

**Global constraints:** All four switches false; five workflows paused; #97 untouched; scanner, grants, receipts, counters, permissions and review protection preserved. No Claude, live recovery, repairs, paid AI APIs, merge or deployment during preparation.

**Review focus:** Forged historic lineage; mixed/replayed handoffs; source/evidence secrets concealed by metadata handling; post-publication/review/cycle2 lineage; failure classification and preview writes.

- [x] Capture read-only settings, complete usage state, #97 and third blocked grant.
- [x] Add failing tests for final receipt/bundle scanning and consistent service probe identities.
- [x] Add failing real-policy tests for owner-only recovery, immutable old lineage, ordinary caps and zero-write preview.
- [x] Record RED at main 23252aeb493185e78fc92c587db3491c4f5164ed.
- [x] Implement schema v2, full finalization scan and both explicit health probe identities.
- [x] Implement output recovery: preserve first retry/continuation, add findingOutputRecovery, bind new parent/main CI and ordinary coding4/retry3; exclude merge.
- [x] Run focused and full factory checks, changed-file formatting/lint and unchanged source scanner.
- [x] Obtain fresh local review, document boundaries/evidence, and verify live controls/history unchanged.
- [ ] Commit, push and open a draft PR against this fork main linked to #103. No model review starts now.
