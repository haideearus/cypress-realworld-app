# Dependency evidence recovery

[Maintenance issue #211](https://github.com/haideearus/cypress-realworld-app/issues/211)

- Require successful CI and a scanned, digest-bound public evidence packet before reserving the reviewer.
- Retain both evidence checks when a confirmed gateway failure needs one retry after 60 seconds.
- Publish known blockers on the linked tracking issue. Request one Dependabot rebase per confirmed stale native PR head using the optional repository-owner credential.
- Test the recovery paths locally, verify workflow wiring, and open a draft PR. Preserve live settings and past attempts.

The reviewer receives the same fact format and still requires exact-head CI, independent review and protected merge. Production approval stays manual.
