# Dependency Review Status Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for this focused change.

**Goal:** Refresh dependency review evidence after committing the assessment.

**Architecture:** Reuse `Controller.gate` after the existing ledger update in
`DependencyCoordinator.assess`. Give only the trusted assessment job checks write
permission. Keep status publication separate from the durable review outcome.

**Tech Stack:** Node.js CommonJS, node:test, GitHub Actions.

**Spec:** ../specs/2026-11-16-dependency-review-status-design.md

## Global constraints

All three factory switches stay false. Preserve live ledger, counters, limits,
branch protection, model permissions and subscription-only authentication. No
Claude session, paid AI API, merge or deployment during preparation.

## Review focus

- Genuine approval is committed before a status is published.
- Blocked, invalid or changed-head proof never publishes success.
- A failed publication retains the original assessment and consumed review.
- Only assessment gains checks write; candidate/model jobs remain isolated.

## Task: assessment publication and regression evidence

- [x] Refactor the existing test preparation helper so tests can inspect the
      reserved grant and bundle before assessment. Extend the in-memory GitHub
      fixture to capture check publication and the ledger at publication.
- [x] Add regressions for pass, changes-requested, invalid artifact, changed PR
      head and publication failure. Assert counters and proof are retained. Add exact
      workflow permission assertions. Run focused tests and record expected failures.
- [x] Add `await this.controller.gate(number)` after the assessment ledger update.
      Add `checks: write` only to `factory-dependencies.yml` assessment permissions.
- [x] Run focused tests, factory tests, lint/format and secret scan. Record output
      in the verification document and update operating guidance for failed status
      publication without consuming another review.
- [ ] Obtain a fresh local code review, fix blockers, verify unchanged live
      switches/protection/ledger and open a draft PR against this fork's main.

Ruling: reuse the clean existing checkout on a dedicated branch, preserving its
installed tools. No additional worktree or dependency installation is necessary.
