# Reserved intake turns for held dependency repairs

## Goal

Give due held dependency tickets a path to verified repair that is independent of the scan position for new alerts. Aim for three held-origin fixes merged per Bucharest day when three compatible fixes and review capacity are available. Report proposals prepared, PRs merged, and GitHub alerts cleared as distinct outcomes.

## Approach

Use the existing **Dependabot alert intake** workflow with two queues. The new-alert queue keeps the paginated vulnerability scan. The held queue starts from existing registry records, orders them by advisory severity, runtime exposure, and wait time, and continues from saved recheck evidence. Two separate workflows would isolate execution but would duplicate wake and quota coordination. Both queues use the existing serialized ledger, preparation budget, and handoff to **Dependency maintenance**.

## Selection and scheduling

- Reserve the first three eligible held proposal opportunities each day when due held work exists. The new-alert queue can use a turn when held work is ineligible. Fresh critical runtime alerts can take a turn first, then the next eligible turn returns to held work. Existing production incident and app work priority still applies.
- Read one bounded advisory snapshot per intake. Reuse #188's candidate checks, hold reasons, evidence fingerprint, batch progress, and cooldown. A stalled or ineligible held record must allow the next due record to be considered within the run's read budget. Retain the original issue and update its linked proposal idempotently.
- Use the existing post-merge CI wake and scheduled intake. Record a deferred check when trusted work occupies the factory slot, and allow one deduplicated retry when a trusted completion frees it. Expire a stale wake if its main or registry state has changed. An empty queue or repeated blocked state does not dispatch a follow-up.
- Keep the existing ceilings, stop logic, exact-head CI, independent Claude Pro review, protected merge, and alert-confirmed closure. Use model-free intake and the existing subscription review path. Parent-package and major upgrades remain governed by the current compatibility policy. Render deployment approval remains a human decision.

## Verification

Use model-free fixtures to show that a held issue is considered when the new-alert cursor points to a different page, that available held work receives its reserved turns without overruling incident priority, and that stale or repeated wake events cannot duplicate a proposal, consume a review, or bypass a limit. Verify recovery across partial outages and preservation of counters. After the PR passes review, merges, and passes CI on main, observe the first automatic intake and check whether the original lodash issue #162 advances to a verified 4.18.1 proposal.
