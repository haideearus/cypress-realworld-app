# Operations and Evidence Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for this documentation update.

**Goal:** Publish a truthful operating guide and verifiable acceptance index.

**Architecture:** Keep a current entry point and runbook, preserve dated history,
and link sanitized receipts to immutable GitHub runs and artifact digests.

**Tech Stack:** Markdown, JSON, existing read-only GitHub metadata and local archives.

**Spec:** ../specs/2026-11-16-operations-evidence-design.md

## Global constraints

All three switches false; monitoring, workflow states, ledger, counters, limits
and protection unchanged. No Claude, paid AI API, stop/resume, live trial, merge
or deployment. Documentation and sanitized evidence only.

## Review focus

- Observations are dated and do not authorize activation.
- Approval observation time is not invented as the exact click time.
- Physical shutdown, API coverage, quarantine and manual setup limits are explicit.
- Historical failures remain historical; no unsupported success or refund claim.
- Stop preview and resume restore scope are described accurately.

## Task 1: capture and reconcile evidence

- [x] Capture a read-only baseline and verify source runs/archives.
- [x] Build a sanitized receipt bundle and dated acceptance index.

## Task 2: current operating guidance

- [x] Add operations guidance covering normal queues, schedules, caps, deployment,
      stop/resume, held work and remaining acceptance.
- [x] Update current status and obsolete installation/cap statements in the
      main, Claude, monitoring, app-check and dependency guides; retain dated history.

## Task 3: verification and draft PR

- [x] Validate local links/anchors, JSON, formatting, diff and secret scanning.
- [x] Obtain a fresh local review and resolve blockers.
- [ ] Recheck unchanged live controls and prepare the draft PR against main.

No application or factory runtime tests are needed for these documentation-only
edits; native PR CI may run its normal suites after opening.
