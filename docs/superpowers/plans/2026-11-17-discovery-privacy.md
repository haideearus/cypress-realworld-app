# Discovery Privacy Verification Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan inline, with test-first verification.

**Goal:** Add independently executable privacy checks to the existing discovery
catalog, without promoting historical held evidence or changing settings.

**Architecture:** Fixed synthetic seed fixtures and legitimate-read controls
produce typed observations. Existing discovery and intake replay enforce RED,
GREEN, provenance and limits. No new workflow, model or provider is introduced.

**Tech Stack:** Node 22.20.0, node:test, existing Express API, existing Docker CI.

**Spec:** `docs/superpowers/specs/2026-11-17-discovery-privacy-design.md`.

## Global constraints

- Preserve all runtime settings and discovery off; no Claude or paid AI APIs.
- Preserve original artifacts, counters, branch protection and named deployment approval.
- No production probing, real credentials or source application repair in this PR.

## Review focus

- Positive controls must distinguish a real fix from globally denied/broken routes.
- A stranger must actually authenticate as a different, nonparticipant identity.
- Missing, deleted, public or contacts fixtures must not prove a private-record bug.
- Wrong-resource success and denial with resource payload must stay held.
- The original null-oracle artifact cannot become a verified finding retroactively.

## Task 1: Fixed privacy probes and typed observations

Files: `scripts/factory/discovery-oracles.cjs`,
`scripts/factory/discovery-evidence.cjs`, `scripts/factory/discovery-intake.cjs`,
`scripts/tests/factory-discovery-privacy.test.cjs`.

- [x] Write tests for exact contracts, authenticated identities, legitimate controls,
      two matching disclosures, 401/403/404 fixes and broken/ambiguous evidence.
- [x] Run the new tests before implementation and preserve the unsupported-catalog RED.
- [x] Extend `validateOracle`, `probe`, `observe`, observation validation and healthy
      classification. Use only fixed `http://app:3001` targets at runtime; test-only
      injected transport/seed exercise the same code offline.
- [x] Run new tests with existing evidence, intake, repair and origin suites.

## Task 2: Execution integration and operator evidence

Files: `scripts/factory/discovery-worker.cjs`,
`scripts/tests/factory-discovery-image.test.cjs`,
`docs/factory/DISCOVERY.md`, `docs/factory/DISCOVERY-INTAKE.md`,
`docs/factory/evidence/discovery-privacy/verification.json`.

- [x] Describe the two exact catalog entries in the existing discovery prompt.
- [x] Add model-free image smoke probes accepting valid RED or valid GREEN.
- [x] Inspect real routes with disposable local in-memory data; preserve result
      summary separately from oracle-unit and native-Docker evidence.
- [x] Document immutable old holds and separately authorized future rollout.
- [x] Run factory protections, formatting and secret scan; check settings read-only.
- [x] Create an unlabelled owner harness ticket and draft PR against this fork/main.
      Do not dispatch a model, mark ready, merge, publish findings or deploy.

Execution evidence: `docs/factory/evidence/discovery-privacy/verification.json`. Local Docker is blocked; native CI remains pending. Draft publication is the final preparation step. Required Claude Pro review is not started.
