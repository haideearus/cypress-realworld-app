# Recovered finding evidence and bounded #96 retry

> **For agentic workers:** Use superpowers:executing-plans, then one fresh-context branch review. Steps use checkbox syntax.

**Goal:** Download the verified recovery artifact from its actual producer and enable one explicit retry of #96 without rewriting history or affecting #97.

**Architecture:** Keep the original discovery source distinct from the recovery artifact producer. Add a manual `retry-finding` input to Automatic factory, selecting #96 directly. A pinned retry receipt binds a new parent and tested main while leaving original automatic/finding proofs intact. The normal reservation consumes the second coding attempt and first retry; sandbox RED/GREEN, CI and independent review remain mandatory.

**Tech stack:** Node 22 CommonJS, node:test, existing GitHub Actions and OAuth-only worker.

**Spec:** Maintenance issue https://github.com/haideearus/cypress-realworld-app/issues/98 and the user's approved fix/retry request.

## Global constraints

- Four switches remain false and five workflows paused during preparation.
- Do not start Claude, live retry, repairs, merges or deployments.
- Do not edit #97, its registry record, or its ledger entry.
- Preserve all grants, criteria, usage counters, daily admissions, caps and review gate.
- Retry is owner-dispatched, preview-default, one-time, #96-only; no queue scan.
- Discovery and automerge must remain off for retry; other pickup/intake workflows must be paused.

## Review focus

- Forged or expired recovery artifacts must fail before model access.
- Repeated, scheduled, event-driven or wrong-ticket retries must fail without writes.
- Terminal failed parent must prove the artifact download failed and Claude was skipped.
- Fresh main changes must not replay forbidden harness diffs as app patches.
- Immutable original provenance must remain valid after retry's new parent and RED baseline.

## Task 1: Evidence resolver

Files: discovery-repair.cjs, factory-discovery-repair.test.cjs and recovered fixtures.

- [x] Add and run failing ordinary/recovered producer regression tests.
- [x] Validate provenance, resolve artifact name and producing run from the candidate's bound artifact metadata, and retain bounded content/RED checks.
- [x] Run evidence, origin, recovery and repair tests.

## Task 2: One explicit safe retry

Files: new finding-retry.cjs and tests; policy.cjs; automation.cjs; factory-automatic.yml; discovery-repair.cjs.

- [x] Add failing tests for exact #96 reservation, immutable history/#97, limits, stop, same-parent replay, foreign/scheduled invocation and bad failed-job evidence.
- [x] Pin original blocked grant, finding identity and criteria. Verify old parent and skipped model step, unchanged issue/provenance, paused workflows, no active/unpublished work, and passing current-main push CI.
- [x] Add a retry marker bound to the new manual parent; consume normal limits and preserve first-source metadata and intake.
- [x] Build a fresh RED baseline on retry's tested main, recheck main before reservation, retain GREEN/CI/review requirements and prohibit automatic merge for this operation.
- [x] Expose preview-default targeted input with no queue pickup and no recovery source mutation.

## Task 3: Validation and delivery

- [x] Document preview/run conditions, preserved counters and future manual actions.
- [x] Run relevant and full factory checks, secret scanning, formatting and diff checks; retain RED/GREEN evidence.
- [x] Request a separate fresh-context local review, address important findings, and open a draft PR against main linked to #98.
- [x] Recheck all four switches false, five workflows paused, #97 unchanged and no new live grants.
