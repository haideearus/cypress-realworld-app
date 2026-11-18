# Independent review content

Combined owner acceptance: [#95](https://github.com/haideearus/cypress-realworld-app/issues/95), covering PR #94 recovery plus this review-output correction. Original #93 remains frozen with both consumed reviews.

## Observed failure

[Run 44296391691](https://github.com/haideearus/cypress-realworld-app/actions/runs/44296391691) finished successfully and its original digest-verified artifact contained verdict `pass`, summary `test` and one minor finding `test`. The SDK output, collected artifact and retained feedback agreed. The model used 38 turns and reported no permission denials. Its full transcript was not uploaded, so why it chose that text is not established.

The collector checked shape, head and severity but accepted any nonempty text. The gate then trusted the approval fields without checking retained review content. Green execution therefore did not establish substantive review.

## Correction

The existing JSON shape stays `head`, `verdict`, `summary`, `findings`. Summaries need at least 60 characters and findings need at least 30; normalized repeated filler and explicit sample-only responses are refused. Several distinct explanatory words are required. Real blockers remain representable, and a passing review may correctly have no findings. Critical/important findings still forbid pass.

The read-only prompt requires actual repository paths, acceptance-criteria reasoning, supplied evidence and limits. It forbids copying example review objects from fixtures and forbids inventing minor findings. Read/Glob/Grep permissions remain unchanged; it cannot write, run shells, access production or call another model.

The collector and assessments share validation. The gate also validates retained review content, its verdict and exact head before treating an existing approval as usable. Missing, malformed, stale, failed or placeholder content holds approval without changing ledger records, grants, counters or audit history. Ledger reading still accepts historical data. No invalid approval is converted into a new passing review.

These deterministic checks reject obvious non-evidence; they do not prove an arbitrary long answer is truthful or exhaustive. Operator inspection of the actual fresh artifact remains necessary during this rollout.

## Full combined review checklist for issue #95

Review the entire PR diff from its current `main` base to the final PR head.
Recovery files introduced in earlier commits remain part of this review. An
encoding-only latest commit does not reduce the combined scope. Issue #95's
criteria remain frozen; this checklist maps those existing criteria to code.

| Area                                   | Inspect                                                                                                                                                                                                                             | Explain in the actual assessment                                                                                                                                                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recovery provenance and archive bounds | `scripts/factory/discovery-recovery-origin.cjs`, `discovery-recovery-contract.cjs`, `discovery-archive.cjs`                                                                                                                         | How the original run/grant/head, ZIP/report/proposal hashes and trusted producer are bound; how changed, oversized or ambiguous artifacts and unsafe redirects are rejected.                                                                                  |
| Retry scope                            | `scripts/factory/recovery-github.cjs`, `discovery-recovery-run.cjs`, `discovery-run.cjs`, `discovery-worker.cjs`                                                                                                                    | Why bounded retries apply only to explicit rate-limited GETs in recovery, while ordinary discovery keeps the normal client and uncertain writes are not retried.                                                                                              |
| Permits and retained history           | `scripts/factory/discovery-recovery-contract.cjs`, `discovery-recovery-run.cjs`                                                                                                                                                     | How reservation happens before execution, two source permits share the eight daily replay slots, and source ticket #92 and its grant stay consumed/blocked without counter refunds.                                                                           |
| Isolated verification and intake       | `scripts/factory/discovery-recovery-evidence.cjs`, `discovery-intake.cjs`, `discovery-finding-run.cjs`                                                                                                                              | How the selected saved proposals, repeated sandbox replays and trusted privacy probes produce separate verified/held receipts, and ordinary publication/current-main replay/repair admission remain required.                                                 |
| Reconciliation and workflow authority  | `.github/workflows/factory-discovery-recovery.yml`, `scripts/factory/discovery-recovery-run.cjs`, `discovery-recovery-origin.cjs`                                                                                                   | Why owner/main/attempt-1 and trusted CI are required; why reconciliation needs successful real replay/job/artifact proof, spends no new model/replay permit, and cannot approve missing, failed or cancelled proof. Check stop behavior and preview defaults. |
| Review collection and gate             | `scripts/factory/artifacts.cjs`, `review-quality.cjs`, `policy.cjs`, `worker.cjs`                                                                                                                                                   | Why placeholders cannot pass collection or satisfy retained approval; how exact head/verdict/source and feedback are checked without rewriting history, and read-only permissions remain unchanged.                                                           |
| Regression evidence and limits         | `scripts/tests/factory-discovery-recovery-*.test.cjs`, `factory-discovery-archive.test.cjs`, `factory-discovery-intake.test.cjs`, `factory-review-quality.test.cjs`, `factory-controller.test.cjs`, `factory-dependencies.test.cjs` | Which negative and positive cases support each area, what supplied CI actually proves, and what remains untested live. Check the repaired Unicode contraction input as an actual U+2019 character at runtime.                                                 |

Within the existing four-field result, use separate **Recovery** and **Review
guard** paragraphs in `summary`, with concrete paths, acceptance reasoning and
inspection limits for each. These are topics to investigate, not approval text
to copy. Keep findings factual; an empty list is valid when none exist. A
read-only reviewer must not claim to have executed commands or live recovery.
If an area could not be assessed, say so rather than implying combined coverage.

The first #95 review, [run 44307561939](https://github.com/haideearus/cypress-realworld-app/actions/runs/44307561939),
recorded a passing guard analysis with one confirmed encoding finding. Its saved
summary did not clearly document recovery-path reasoning. Preserve that review,
artifact and consumed count; after this correction its approval covers its old
head only. The next review must cover the complete new head. No transcript was
retained that could establish additional inspection beyond the saved report.

## Prepare a fresh review

1. Keep PR #94 as a draft, settings unchanged and discovery off. Do not reuse an old-head approval or reset #93's two used reviews or #95's first used review.
2. Wait for current-head CI. After separate owner authorization, use a new Factory agents run on `main`, operation `review`, ticket `95`, PR `94`. Creating #95 reserves no model grant. A later reservation uses normal existing limits; #93's history remains preserved.
3. Inspect the full fresh result: it must discuss the actual recovery and review-quality code and criteria, identify real findings or use an empty findings list, and distinguish supplied CI evidence from commands the read-only reviewer could not execute.
4. Verify assessment, head binding and both required checks before merging. Production deployment still requires its named approval.

Trusted main controls this PR's own review until merge. Candidate guard code must not be substituted into the trusted gate to approve itself. The old main validator may still accept placeholders during bootstrap, so a green run alone remains insufficient; hold the PR unless the newly saved review is substantive. No Claude, repairs, recovery, publication or deployment is started by this setup.
