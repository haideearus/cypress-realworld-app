# Factory Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement the linked plans task by task. This document is a plan, not authorization to run models or alter live controls.

**Goal:** Deliver the approved event pickup, full activity notifications, bounded proactive testing and two-active-ticket design.

**Architecture:** Ship four focused, protected PRs. First add backward-compatible active-ticket isolation, then event/activity infrastructure, discovery execution, and verified finding intake. New capabilities remain opt-in until explicit rollout; existing operation can continue during development.

**Tech Stack:** Existing Node 22.20.0/CommonJS, Yarn 1.22.22, GitHub Actions/App/OAuth, Vitest, Cypress and disposable Docker test services.

**Spec:** [Approved combined design](../specs/2026-11-17-event-pickup-and-notifications-design.md).

## Global Constraints

- Claude Pro OAuth only; no paid AI APIs, provider fallback, Cypress Cloud or new hosted/email service.
- Existing daily cap 20 tickets, coding cap 5, review cap 10, retries 4, session ceiling 200 turns/30 minutes remain unchanged.
- Approved new limits: two active tickets; discovery two sessions and four newly published bug tickets per Bucharest day, at most two findings per sweep.
- Discovery source sweeps and subsequently admitted repairs share the twenty-ticket cap; two sweeps plus four admitted repairs use six tickets, not six extra tickets.
- Preserve grants/counters/approvals/audit/quarantine. No resets, fake reviews, fixture production passes, direct main writes or deployment-approval bypass.
- Live operation currently has all three switches true and concurrency one. Planning/development changes none of them. A later stopped/idle owner migration is required before concurrency two.
- Each ticket has isolated execution. Metadata, protected merging and production deployment remain serialized where required. Parallel tickets never share mutable workspaces or live data.
- New event/activity/discovery flags default false. No Claude review, discovery run, live experiment, merge or deployment starts merely because this plan exists.

## Review Focus

- A wake arriving before producer acknowledgment must bind once, not authorize a forged or duplicate receiver; covered in plan 2 task 1.
- Cancel/finish for ticket A must not release ticket B or conceal an unresolved parent; covered in plan 1 tasks 1 and 3.
- A test failure can be a bad oracle/environment rather than an app bug; covered in plan 3 task 3.
- Stop, midnight rollover and an uncertain GitHub write cannot reset allowances or duplicate publication; covered in plan 4 task 1.
- GitHub can be silent, and a journal comment is not proof of inbox delivery; covered in plan 2 task 3 and final acceptance.

## Ordered implementation PRs

| PR  | Working deliverable                                                                                                                  | Detailed plan                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 1   | Dual-version ledger, two-ticket isolation, shared merge ownership, stop/recovery and guarded migration; live concurrency remains one | [Concurrency foundation](2026-11-17-factory-concurrency.md)       |
| 2   | Receipt-backed event wake and full activity journal with safe actor validation; new flags false                                      | [Events and notifications](2026-11-17-factory-events-activity.md) |
| 3   | Metered discovery role and isolated test executor, producing verified candidate reports only; discovery false                        | [Discovery execution](2026-11-17-factory-discovery.md)            |
| 4   | Deduplicated finding publication, current-main replay and normal repair intake/closure                                               | [Finding intake](2026-11-17-factory-finding-intake.md)            |

Every PR gets appropriate offline tests, native CI and genuine fresh review under a dedicated owner harness ticket. Do not label those harness tickets factory-ready. Changed reviewed commits need fresh proof; do not bypass protection to keep a promised PR count.

## Owner actions and rollout

- [ ] Review these plans and choose execution: native implementation here with a fresh whole-branch reviewer, or subagent-driven tasks with per-task reviewers. Native is recommended for lower context cost and tightly coupled policy changes.
- [ ] Prepare PR 1 first, recording RED/GREEN tests and a clean design baseline from current main. Keep the approved design with the implementation.
- [ ] Obtain separately authorized Claude Pro review before each protected merge. Do not reuse approval from this design as a model-run grant.
- [ ] After compatible code is merged, obtain a stopped/idle window and preview migration; migrate the usage ledger and set concurrency two only after exact before/after evidence passes.
- [ ] Initialize wake/activity metadata and the owner-approved activity issue, then exercise non-model previews and one owner-confirmed inbox delivery.
- [ ] Enable event pickup/activity after authorization, preserving current stop/protection and duplicate-receiver tests. Cron remains best effort.
- [ ] Authorize the first sandbox discovery acceptance separately; prove metering, raw RED evidence, finding deduplication, repair/review and stop with two active parents.
- [ ] Enable the two-session/four-finding discovery profile only after acceptance. Retain required phone production approvals and observe actual scheduled/event activity with the PC off.

No runtime or live acceptance result is claimed by this plan.
