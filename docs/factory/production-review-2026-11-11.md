# Independent production review — 2026-11-11

Ticket: [#2](https://github.com/haideearus/cypress-realworld-app/issues/2).
Base: `6ba5a837eb01a59a902e3fe225e224ccc745abd9`.

A separate AI reviewer received the requirements, plan, checkout, and base
revision in a fresh context. It inspected the working-tree implementation
read-only and did not receive the implementer's conversation history.

## Finding and resolution

The reviewer found one Important startup blocker and no Critical or Minor
findings: a clean checkout lacked the ignored optional Cognito configuration,
while the compiled backend imported it unconditionally. Local generated files
had hidden this dependency.

The implementer reproduced it by moving the local mock files and their compiled
copy aside, then running the compiled-backend import regression. It failed with
`MODULE_NOT_FOUND`. The production build now creates upstream's mock files when
absent, preserving locally configured files. CI also prepares mocks before its
unit checks. The complete build and production suite then passed, including the
new artifact check. This was a single review followed by tested fixes, not a
second approval or a claim that a GitHub required-review rule is configured.

## Review boundaries and rulings

- Public deployment, quotas, and approval enforcement require connected accounts
  and an actual public endpoint. They remain pending; local results do not prove
  them.
- Final lint, unit, and browser outcomes are reported separately in the production
  verification record, not inferred from the review.
- Future asynchronous business handlers and optional external identity providers
  need additional abort/concurrency validation. Current deployment uses local
  authentication. Extending those handlers without that work risks stale state
  after an aborted request.
- Existing upstream authorization weaknesses and GraphQL partial-error semantics
  were outside this production-startup ticket. This remains a synthetic teaching
  demo, and is not suitable for real payment data or real credentials.

Two additional implementation mistakes were caught by regression tests: the
bank-transfer router was omitted during the app split, and logout incorrectly
waited for a callback unsupported by Passport 0.5. Both were corrected using
the existing failing API/UI cases; production coverage also verifies logout.
