# Saved Discovery Recovery Implementation Plan

> **For agentic workers:** Use test-first inline execution with independent archive/error helper tasks and a fresh final review.

**Goal:** Recover verification of the saved privacy proposals without another model session or weakening ordinary provenance.

**Architecture:** Pinned original source; isolated model-free replay; separate bounded recovery receipts in existing findings imports; normal intake retains all gates.

**Tech stack:** Node 22.20.0, existing Docker image/sandbox, node:test, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-18-discovery-recovery-design.md`.

## Constraints and review focus

- Settings unchanged and discovery off; no model, repair, publication or deployment now.
- Original failed run/grant/artifacts remain immutable; no counter refunds.
- Only the pinned source can use recovery; ordinary failed-source denial is preserved.
- No generated code on the host; ZIP bytes and redirect credentials are bounded.
- Shared replay budgets are consumed before execution; uncertain writes reconcile.
- Latest proposal revision, original RED, independent oracle and fresh main proof stay distinct.

## Tasks

- [x] Add offline RED/GREEN archive and bounded-read retry/diagnostic tests.
- [x] Extract isolated proposal replay and prove latest-revision selection.
- [x] Add pinned recovery proof, receipt validation and shared quota tests.
- [x] Add manual preview/run/reconcile CLI and workflow with no model credential.
- [x] Connect recovered evidence to existing candidate/origin/intake validation,
      preserving legacy source rules and historical imports.
- [x] Run full factory protections, formatting and secret scan; record native
      Docker limitations separately from real CI.
- [x] Obtain fresh local code review; open an unlabelled harness ticket and draft
      PR against this fork/main. Required Claude review remains unstarted.

Local review found and corrected the manual archive redirect boundary and stop-after-replay assessment. Native recovery execution remains intentionally unrun. PR creation is the final preparation step.
