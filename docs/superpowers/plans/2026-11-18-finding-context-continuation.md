# Finding model context and bounded continuation

> **For agentic workers:** Use superpowers:executing-plans, then a fresh-context review. Steps use checkbox syntax.

**Goal:** Remove unnecessary raw machine-proof fields from model context and prepare one explicit #96 continuation, preserving both blocked attempts and existing protections.

**Architecture:** Project the already-validated finding evidence through an allowlist; never alter the raw ledger proof or the secret scanner. Add a separate, pinned continuation receipt and manual `continue-finding` operation. Reuse the existing targeted retry executor and ordinary reservation budgets, with fresh current-main RED and unchanged GREEN/CI/review gates.

**Tech stack:** Node 22/CommonJS, node:test, existing GitHub Actions/OAuth worker.

**Spec:** https://github.com/haideearus/cypress-realworld-app/issues/100 and the user's approved fix request.

## Constraints

- All four switches remain false and five workflows paused during preparation.
- No Claude, live repair/continuation, merge/deployment, paid AI API or #97 mutation.
- No scanner/config exceptions, encoding or suppression of credentials, gate relaxation, counter reset, allowance increase or historical receipt rewrite.
- Coding 2→3 and retries 1→2 consume ordinary limits; the continuation is manual, owner-only, preview-default and #96-only, with no queue selection or automatic merge.

## Review focus

- Full final model context, including the original reproducer and free text, must still reject real secrets.
- Projection must preserve validation-before-projection and leave raw proofs immutable.
- Parent handoff must retain both historical grants and the first retry receipt while rejecting forged/mixed/repeated lineage.
- The exact failed parent must prove RED and preparation succeeded, context scan failed and Claude was skipped.
- Fresh main and disabled pickup/discovery/intake/merge controls must be checked before any reservation.

## Task 1: Project context safely

- [x] Add failing real-scanner tests for legacy finding metadata and the new projection, plus a complete worker.prepare context test.
- [x] Add an explicit allowlist projection in worker.cjs after raw origin validation; retain reproducer, trusted RED, oracle and useful public digests.
- [x] Verify complete-context secret rejection and unchanged raw proofs/scanner boundaries.

## Task 2: Bounded continuation

- [x] Add failing reservation, historical lineage, preview/no-write and original-parent failure tests.
- [x] Pin the second blocked grant and first retry receipt in finding-continuation.cjs; add a separate receipt field without changing historical fields.
- [x] Reuse targeted retry orchestration for owner-only continue-finding; check ordinary budgets, stop/locks, tested main, frozen issue/proofs, absent publication and paused workflows.
- [x] Validate both parent handoffs, select the latest trusted parent/baseline, and forbid automatic merge for continuation.
- [x] Retain existing retry behavior; cover repeat, wrong ticket/actor/source, stale, stopped, exhausted and unpaused rejection.

## Task 3: Validate and deliver

- [x] Document preparation-only and later preview/run/shutdown conditions.
- [x] Run focused/full factory tests, changed-file lint/format, staged source scanning and diff checks; retain RED/GREEN evidence.
- [x] Obtain a fresh local review, address important findings, open a draft PR against main linked to #100.
- [x] Recheck four false switches, five paused workflows, no live grants and unchanged #97/history.
