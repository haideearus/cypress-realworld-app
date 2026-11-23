# Held dependency upgrade implementation plan

[Maintenance issue #215](https://github.com/haideearus/cypress-realworld-app/issues/215)

The held queue can try a small set of split-version, direct-major and parent-package upgrades from trusted npm registry metadata. Preparation executes no package code, and every candidate must clear the targeted advisories and pass existing CI, independent review and branch protection.

- [ ] Add tests for held packages requiring different version lines or changes in a parent. Build a bounded candidate from the existing root manifest and Yarn v1 lockfile.
- [ ] Validate reachable graph changes and exact sources under a separate policy for wider alert receipts. Keep existing policy for native and ordinary dependency PRs.
- [ ] Bind the exact modified files to the original tracked issue, base and candidate head. Follow the existing verified GitHub App handoff, with replay-safe publication, stale refresh and merge confirmation.
- [ ] Count at most four held merges per Bucharest day under the protected merge writer. Preserve existing priority, counters, and manual production approval.
- [ ] Check invalid metadata, unavailable patches, external errors, changed bases, unauthorized bot input and lost receipts. Run the factory suite and open a draft PR.

The target of two cleared tickets per day depends on verified candidates and available review and merge capacity. The four-merge limit governs automatic repairs that began as held alerts.
