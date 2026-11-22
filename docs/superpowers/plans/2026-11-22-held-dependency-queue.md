# Held Dependency Queue Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for native implementation with a fresh whole-branch reviewer. Steps use checkbox syntax for tracking.

**Goal:** Reserve intake opportunities for held dependency repairs, independent of the rotating new-alert scan.

**Architecture:** Reuse the existing alert registry, lockfile verification, and publication path. One bounded alert snapshot feeds both queues. A deferred slot check can be consumed by one matching trusted completion.

**Tech Stack:** Node.js 22, GitHub Actions, existing CAS metadata store and model-free Node tests.

**Spec:** [Reserved intake turns](../specs/2026-11-22-held-dependency-queue-design.md)

## Constraints

Preserve the existing one-publication run, factory limits, exact-head CI and review, protected merge, stop controls and alert-confirmed closure. Use the original held ticket and the existing compatible lockfile policy.

## Selection and reporting

- [ ] Add model-free pipeline tests for a held candidate outside the new-alert cursor, reserved turns, urgent rotation, and held fallthrough when an earlier probe is inconclusive.
- [ ] Run the tests before implementation and verify the expected failures.
- [ ] Split alert snapshot grouping from candidate planning in `dependency-alerts.cjs`. Select one bounded set of probes across both queues in `dependency-alert-repair.cjs`, preserve registry compatibility, and record the queue and daily proposal/merge/clearance counts.
- [ ] Run dependency alert tests, verify the old promotion/recovery tests still pass, and update the maintenance guide.

## Slot-release wake

- [ ] Add tests for registering deferred held work while a trusted parent owns the slot, consuming one matching terminal event, ignoring duplicates and unrelated runs, and refusing stale state.
- [ ] Run the new tests before implementation.
- [ ] Extend `factory-dependency-alerts.yml` and the existing trigger verifier to admit only an authenticated, current-main completion tied to the deferred registry receipt. Consume the receipt before candidate selection after capacity is rechecked.
- [ ] Run the complete factory suite, request independent code review, and open a draft PR with the verified evidence.

## Review focus

Check the oldest historical registry, multi-slot release ordering, a candidate paused during verification, a push racing a wake, and failures between a persisted proposal and its GitHub response. Check that repeated events are read-only after the first receipt consumption.
