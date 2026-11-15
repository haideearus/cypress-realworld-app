# Current dependency review facts implementation plan

> **For agentic workers:** Use native execution for this focused correction and
> request a fresh separate-agent review before completing the PR.

**Goal:** Give the read-only dependency reviewer verified current registry and
advisory facts for its reserved base/head, without changing approval policy.

**Architecture:** Preserve the accepted v1 analysis report and all historical
ledger entries. A trusted pre-model helper reconstructs the immutable dependency
diff, checks public registry metadata, refreshes OSV results and normalizes
advisory ranges into a bounded packet. Only dependency reviews receive it.

**Tech stack:** Node 22.20.0, existing private Yarn parser/semver lock, npm registry,
OSV querybatch/vulnerability endpoints, existing GitHub Actions model adapter.

**Scope:** Issue #55. User authorized preparation only; no Claude invocation,
merge, deployment, switch change, new paid API credential or counter reset.

## Constraints and review focus

- All three factory switches stay false. Monitoring stays unchanged.
- Preserve Read/Glob/Grep-only review tools, required gates and configured limits.
- Verify every added identity/integrity, not a hardcoded Axios exception.
- Bound external responses and reject redirects, mismatches and partial results.
- Source facts are evidence; unchanged historical prose cannot approve this head.
- Recheck current main/base/head and the live reservation after public requests.
- Retain exact scanned evidence for audit without changing the review schema.

## One task: prepare and verify the complete correction

- [x] Reproduce missing reviewer facts with failing packet/worker tests.
- [x] Add optional detail output to trusted dependency analysis without changing
      default reports or stored ledger schemas.
- [x] Add bounded public metadata collection and exact registry/checksum checks.
- [x] Connect collection to dependency worker preparation; preserve read-only tools.
- [x] Install only existing private parser tools before candidate checkout, and
      retain the scanned fact packet as an audit artifact.
- [x] Verify fixture tests and real PR #52's immutable versions with public services.
- [x] Run final formatting, workflow validation, factory suite and source scan.
- [x] Request fresh independent local agent review and address findings.

Publication: push the focused branch and create a draft PR against this fork's
main. The PR's metadata records publication; genuine subscription review remains
pending.

## Later, after owner authorization

The PR still needs genuine Claude Pro review and both required native checks.
After merging, obtain a fresh genuine Dependabot head before another PR #52
attempt. Preserve its failed heads and used review; do not reauthorize that old
head or claim a passing review from a successful metadata collection.
