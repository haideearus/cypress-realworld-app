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

## Prepare a fresh review

1. Keep PR #94 as a draft, settings unchanged and discovery off. Do not reuse its placeholder approval or reset #93's two used reviews.
2. Wait for current-head CI. After separate owner authorization, use a new Factory agents run on `main`, operation `review`, ticket `95`, PR `94`. Creating #95 reserves no model grant. A later reservation uses normal existing limits; #93's history remains preserved.
3. Inspect the full fresh result: it must discuss the actual recovery and review-quality code and criteria, identify real findings or use an empty findings list, and distinguish supplied CI evidence from commands the read-only reviewer could not execute.
4. Verify assessment, head binding and both required checks before merging. Production deployment still requires its named approval.

Trusted main controls this PR's own review until merge. Candidate guard code must not be substituted into the trusted gate to approve itself. The old main validator may still accept placeholders during bootstrap, so a green run alone remains insufficient; hold the PR unless the newly saved review is substantive. No Claude, repairs, recovery, publication or deployment is started by this setup.
