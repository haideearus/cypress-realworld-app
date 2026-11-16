# Dependency review context implementation plan

Goal: supply verified release and exact-head form-suite context without changing gates.
Spec: ../specs/2026-11-16-dependency-review-context.md
Architecture: bounded public metadata adapter, integrated with existing fact collector
and worker; no model capabilities, token permissions or ledger schema changes.

- [ ] Add failing tests for official release/tag identity and exact-head CI suites.
- [ ] Implement bounded adapter; reject wrong versions, tags, repositories, heads,
      correlation IDs, incomplete jobs and missing required suite steps.
- [ ] Integrate collector and worker, keeping context truthful about provenance and
      suite-level coverage. Preserve read-only capabilities and unchanged ledger tests.
- [ ] Verify targeted and full factory tests, lint, scanner and meaningful live
      public-data preflight. Review full diff without invoking Claude.
- [ ] Prepare owner-authored PR under #70 and the permitted future review sequence.

Review focus: untrusted URLs, release/npm mismatch claims, missing CI coverage,
outage/timeout bounds and stale or changed reservation identity.
