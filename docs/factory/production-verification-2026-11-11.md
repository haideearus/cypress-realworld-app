# Production preparation verification — 2026-11-11

Ticket: [#2](https://github.com/haideearus/cypress-realworld-app/issues/2).
Runtime: pinned Node 22.20.0, Yarn 1.22.22, Windows; real disposable PostgreSQL
17.11 on loopback. No cloud database, paid hosting, or model API key was used.

## Recorded results

| Check                                                          | Observed result                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------- |
| Locked dependency install                                      | Passed; exact pg/session package versions and Yarn lock committed |
| TypeScript                                                     | Passed                                                            |
| ESLint and formatting                                          | Passed                                                            |
| Existing unit tests                                            | 44 passed, 10 skipped; 8 files passed, 1 skipped                  |
| Production frontend + compiled server build                    | Passed, including clean-checkout mock preparation                 |
| Production configuration / artifact / PostgreSQL tests         | 7 passed                                                          |
| Existing CI frontend build                                     | Passed                                                            |
| Render Blueprint against provider JSON schema                  | Valid; no schema errors                                           |
| Production HTTP boundary / HTTPS browser flow                  | 4 HTTP checks and 1 browser test passed                           |
| Existing API and UI regressions                                | 110 passed across 16 specs                                        |
| Public deployment, provider quota settings, hosted persistence | Pending provider connections                                      |

The PostgreSQL checks verify once-only initialization, concurrent writes from two
store instances, rollback and recovery after a forced database failure, login
cookie properties, user-response redaction, profile/payment/session persistence
after process restart, same-origin mutation restrictions, disabled seed routes,
API 404 responses, and logout.

## Failing-before evidence

- At the foundation revision, the HTTP boundary checks failed because the API
  origin did not provide the frontend, health endpoint, or JSON API fallback.
  The reset-route case was run against the existing test-mode server, where
  resetting disposable data is deliberately allowed; it does not allege a
  production reset-route flaw in upstream.
- The new Cypress user-response test failed against the original runtime:
  13 tests passed and the password-hash regression failed. Its passing rerun is
  part of the final API suite.
- The independent-review artifact regression failed with `MODULE_NOT_FOUND`
  without the locally generated Cognito mock, then passed after build preparation.
- Existing bank-transfer and logout cases caught two implementation regressions,
  which were fixed before the final complete rerun.

Initial connection-refused and prerequisite-timeout attempts are setup failures,
not counted as failing-before product evidence.

## Evidence and limits

Local logs are retained outside the repository under the workspace's `outputs`
directory: `security-red.log`, `production-smoke-red.log`,
`review-artifact-red.log`, `review-clean-build-green.log`,
`production-types-final.log`, `production-lint-verified.log`,
`production-unit-green.log`, `production-all-final.log`,
`production-browser-complete.log`, `final-regression.log`, and final regression
JUnit files. They are local records, not uploaded GitHub CI results.

The database connection file and test TLS keys are private temporary tooling and
are not committed. The original application data fixture was restored after the
last regression run and matches Git. Cloud-specific cold starts, proxy behavior, live revision,
free-plan quotas, and persistence across a real hosted restart remain unverified.

See the [independent review](production-review-2026-11-11.md) for its finding and
limitations. This PR prepares deployment; it does not install the unattended
maintenance dispatcher, hard spending guard, kill switch, protected branch, or
human production environment.
