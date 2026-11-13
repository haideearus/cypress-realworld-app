## Owner decision and complete scope

This existing reporting-maintenance issue now supplies the complete, self-contained review criteria for the final combined PR #19. It includes BOTH the issue #11 recovery originally specified by #18 AND the review-status repair subsequently requested by the owner under #20. Review the entire current main-to-head PR diff against this combined scope.

The owner requested keeping both changes in PR #19 and, on 2026-11-13, authorized correcting the scope/permission findings and additional review allowance to finish setup. The implementer bounds the next action to ONE additional Claude Pro subscription review after ordinary CI, with no paid API or fallback. Preserve both consumed #18 reviews, including changes_requested; do not reset/refund counters, reuse an old approval or weaken branch protection. This is an explicit additional owner-authorized review under the corrected combined scope, not a claim that the earlier reviews did not occur.

Issue #20 has not been admitted before this scope is saved. At admission its criteria hash must be frozen normally. Ticket #18 remains exhausted at two reviews; its body/history must remain unchanged. Standard per-ticket caps, 100 turns, 15 minutes, five daily ticket admissions and one active ticket stay unchanged. Enable only for this one review and restore FACTORY_ENABLED=false afterward.

## Part A: authorized recovery and command guidance

The original #18 brief is reproduced below so this review does not depend on fetching linked pages. Its preparation-only restrictions concern implementation; this later review is separately owner-authorized.

Prepare one combined, disabled-by-default recovery PR for issue #11, as requested after the owner saved FACTORY_ENABLED=false.

Evidence: controlled runs 43203237182 and 43391969547 failed at 20 and 50 turns. The second retained 11 permission denials (10 Bash, 1 Glob); raw denied inputs were intentionally not retained, so exact blocked commands and the Glob path are unknown. The current coding prompt does not enumerate the five existing preapproved Bash commands. Native CLI help confirms --restricted still permits tools explicitly named by --tools; do not remove restricted/safe mode or infer that Bash is categorically disabled.

Required behavior:

- Keep existing tool permissions, OAuth-only Claude Pro authentication, no paid AI APIs, 100-turn ceiling, 15-minute timeout, daily admissions 5, normal coding attempts 2, reviews 2, normal retry allowance 1 and concurrency 1.
- Add trusted prompt/context guidance listing the existing commands, using Read/Glob/Grep for repository inspection, repository-relative paths, one simple approved command per call, and honest stopping after an approved action remains blocked. Do not claim the historical raw denials have been recovered or that guidance guarantees success.
- Add an explicit owner-only manual recovery operation. It may reserve exactly one extra coding session for existing issue #11 only, with the current fixed criterion hash and the two exact finished failed grants from its ledger.
- Preserve both old grants, original admission and all counters. Record the new third coding attempt separately as a consumed recovery grant; normal retry count stays 1 and no fourth attempt or automatic recovery retry is possible.
- Start recovery from then-current trusted main, not the old failed checkout. Preserve the existing publication, exact-head CI and independent review gates.
- Fail closed for other issues, changed criteria/history, wrong actors, wrong dispatch source, active/pending work, duplicate/replayed use, lower configured budgets and disabled factory.
- Verify with real local policy/controller/worker code and synthetic GitHub fixtures, then ordinary CI; no model session, reviewer, live ledger mutation, merge or deployment during preparation.

Any actual recovery remains a later explicit owner dispatch after genuine independent review and merge. Do not reset the ledger or create replacement admissions to evade issue #11's history.

Additional clarification resolving the earlier minor finding: the single-use recovery requires the exact configured coding=2, retries=1, reviews=2 and daily=5 values. Lowering any of these refuses the recovery/resumed coding invocation. Ordinary tickets retain their normal configured budget enforcement.

Before publication, the implementer must verify the current open issue #11 title/body criterion hash and the two failed code grants against the live public ledger, record exact evidence, and leave that history intact. Raw denied commands were not retained and must not be invented.

## Part B: authorized read-only review-status repair

Observed defect: the custom Factory review gate check API reported success for the previous reviewed head, yet GitHub's merge decision remained blocked with Expected. The native status repair belongs in this same PR by the owner's explicit request; it is not outside this combined scope.

Required final behavior:

- Add Factory review status, triggered by pull_request, with an actual required job named Factory review gate.
- Check out the immutable trusted base SHA, not PR source. Use only read-only repository metadata and the trusted policy/ledger reader, with no model or production secret.
- Verify the current PR repository, base and exact event head, then genuine independent subscription approval for that exact PR/head. Missing, stale, fixture, failed, malformed or unavailable proof must fail the real job. The actual stdin entry must execute verification, not merely define a function.
- Keep the controller's custom API report as informational Factory review evidence, avoiding confusion with the required native job.
- Remove the proposed automatic rerun implementation entirely: no gate-report.cjs, no controller rerun-failed-jobs call, no empty-HTTP-201 parsing change added only for that API, and NO added Actions write permissions in the three metadata jobs. Their permissions must match existing main. The new native job is read-only.
- After genuine approval, the owner or an explicitly authorized repository-management action reruns ONLY the lightweight Factory review status pull-request job. This is metadata verification, not another AI session. This rollout intentionally keeps that one manual gate refresh; automatic scheduling/merge/deploy are outside this PR.
- Preserve all branch-protection requirements and expected source, existing model roles/tool permissions, limits, history and license. Do not claim a pass until current-head genuine proof and actual merge eligibility are verified.

## Read-only recovery provenance verification, 2026-11-13

The current open issue #11 title/body exactly matched the frozen public fixture.
Its SHA-256 criterion hash matched both the live ledger and recovery constant:
`d295d714446efad9eaa6b3bd3c0c25706756dcc2d26160a191f0253438279387`.
Every stored field of both original failed grants matched the live ledger:

- Grant `503b7bc1-d82f-4bd2-84e8-fae30886f23a`, run `43203237182`.
- Grant `2b3030da-263c-432e-9069-3f38d0778248`, run `43391969547`.
- Both are finished/blocked code grants, cycle1, runAttempt=1, with head
  `4f0eb6eca04cd603a5401439d0fdcd83d8c2c4d5`.
- Issue #11 remains coding=2/retries=1/reviews=0, with no recovery marker.

These were read-only checks. No recovery was reserved or grant edited. Recheck
the same preconditions immediately before the eventual real dispatch.

## Review and evidence requirements

Evaluate correctness, regression coverage, trust boundaries, serialization/ledger provenance and the full final diff independently. A prior pass for 40eb635 cannot approve a later commit. A green workflow run does not mean the review verdict is pass. Return changes_requested for actual remaining blockers; owner urgency is not grounds to waive findings.

Regression tests must cover native stdin success/failure with synthetic proof, absent/stale/forged/failed/corrupt proof, changed/closed/outside PRs, disabled read-only verification, unchanged metadata permissions, no Actions requests from the controller gate, exact lower-budget refusal, and preserved counters/history.

Ordinary CI must pass app/factory checks. Documentation and plans must describe the final no-extra-permission implementation, not the removed automatic rerun proposal. Keep Render Auto-Deploy off. This issue does not authorize production deployment or bypassing a required review. A real issue #11 recovery comes only after genuine current-head approval, human merge and its explicit one-time recover dispatch.
