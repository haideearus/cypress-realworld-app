# Permission Diagnostics Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. No additional agent run is authorized for this task.

**Goal:** Prepare a diagnostic-only draft PR that preserves a bounded, sanitized report after a failed Claude step.

**Architecture:** A standalone Node reporter reads the pinned action's fixed temporary execution filename. It constructs a new report from fixed enums, counts and booleans. Failure-only workflow steps upload this single report under a separate diagnostic artifact name. It never publishes a code bundle or approval.

**Tech Stack:** Node 22.20.0 CommonJS, node:test, existing pinned GitHub Actions.

**Spec:** Owner-approved scope and [maintenance issue #12](https://github.com/haideearus/cypress-realworld-app/issues/12).

## Global Constraints

- Keep FACTORY_ENABLED=false; no factory/Claude/other agent run, inference request, API key or paid fallback.
- Preserve permissions, the 20-turn ceiling, all other limits, reservations and deployment behavior.
- Never retain raw commands, arguments, paths, prompts, transcripts, IDs, credentials or raw exceptions.
- Only fixed tool names, command categories/forms, stop reasons and bounded numeric metadata may leave the reporter.
- Missing, symlinked, oversized, malformed or incomplete execution data must be explicit; missing denial information must not become a zero count.
- A diagnostic failure or artifact must not change the failed job to success or create review evidence.
- No merge, protection bypass or review-gate approval. Independent AI review remains outstanding under the owner's no-new-runs instruction.

## Review Focus

- Untrusted names/arguments/errors containing credentials must never be copied into the report or console.
- Oversized files, symlinks and existing output paths must not redirect reads/writes or upload preexisting content.
- Absent denial arrays must stay unknown; record truncation explicitly.
- Workflow failure conditions must handle failed model steps while skipping failed preflight and cancelled jobs.
- The report artifact must stay separate from code/review artifacts and retain the original job failure.

## Tasks

- [x] Write synthetic reporter/CLI and workflow regressions; observe failures before implementation.
- [x] Implement scripts/factory/diagnostics.cjs with an 8 MiB input bound and at most 100 sanitized denial entries.
- [x] Add failure-only report and upload steps to factory-model.yml; upload one fixed JSON file for seven days.
- [x] Run all factory tests and actionlint; inspect the diff for unchanged permissions/limits/credentials.
- [x] Document the evidence and unavailable historical details; perform an author review without starting a reviewer agent.
- [ ] Push the feature branch and open a draft PR. Follow ordinary CI; leave the genuine AI gate unsatisfied and the PR unmerged.

## Evidence and decisions

Base: `4f0eb6eca04cd603a5401439d0fdcd83d8c2c4d5`.
The new reporter/workflow regressions first had 11 failures, 9 passes and one
Windows symlink skip. After implementation the full factory suite had 74 passes,
zero failures and that one skip. Linux CI is expected to exercise the symlink
case; its actual result belongs in the PR description. Local evidence is saved
outside the repository as `../outputs/factory-diagnostics-{red,green}.log`.

The pinned upstream SDK logs only a denial count when full output is disabled:
[sanitizer source](https://github.com/anthropics/claude-code-action/blob/4fa93a88de49bbef68b10eb15aabedf28ca0e1ed/base-action/src/run-claude-sdk.ts#L139).
Its [execution-file writer](https://github.com/anthropics/claude-code-action/blob/4fa93a88de49bbef68b10eb15aabedf28ca0e1ed/base-action/src/execution-file.ts)
defines the fixed temporary filename. These sources establish compatibility with
the existing pin, not a reason to enable full transcript logging.

Owner constraints take precedence over the normal fresh-agent review workflow:
no additional agent/model reviewer is started for this PR. Author review and
ordinary CI can be completed while disabled; the required genuine AI review
remains outstanding. Nothing in this PR weakens or bypasses that check.

Author review covered the data whitelist, bounded reads, missing versus zero
counts, exclusive output creation, generic errors, failure-only workflow
conditions, and separation from code/review artifacts. A regression added during
that review caught PowerShell being mislabeled as a non-shell tool; it failed
before correction and then passed. The public CLI output is also asserted to
equal the sanitized artifact exactly. Final local suite: 74 passed, zero failed,
one Windows-only symlink skip. Actionlint passed for all six workflows. Policy,
worker arguments, dependencies and the other workflows have an empty diff.

The final PR URL, Linux CI result and outstanding genuine-review status are
recorded in the PR description after this planning checkpoint.
