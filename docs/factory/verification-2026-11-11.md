# Local verification: 2026-11-11

## Source and environment

The application source tested is upstream revision
`0729f68ac220f7cda4ad09c5693dba11d7c532c6`, with the documentation foundation at
`d4f489f7cdb8087c402ae59952b9e29ddb5e7c4d`. Application source, `package.json`, and
`yarn.lock` were not changed to obtain these results.

| Tool               | Version                            |
| ------------------ | ---------------------------------- |
| Operating system   | Windows x64                        |
| Node.js            | 22.20.0, matching `.node-version`  |
| Yarn Classic       | 1.22.22, matching `packageManager` |
| Cypress            | 16.1.1                             |
| End-to-end browser | Electron 146, headless             |

The Node archive was checked against the official distribution's SHA-256
manifest. Tooling was installed alongside the checkout. Git was configured to
trust this exact checkout after its owner changed from the sandbox account to
the desktop user.

## Results

| Check               | Command                                                                           | Result                                     |
| ------------------- | --------------------------------------------------------------------------------- | ------------------------------------------ |
| Locked dependencies | `yarn install --frozen-lockfile --network-timeout 600000 --network-concurrency 4` | Passed                                     |
| TypeScript          | `yarn types`                                                                      | Passed                                     |
| Lint and formatting | `yarn lint`                                                                       | Passed                                     |
| Unit tests          | `yarn test:unit:ci`                                                               | 44 passed, 10 skipped; exit 0              |
| Frontend CI build   | `yarn build:ci`                                                                   | Passed                                     |
| Local app startup   | `yarn start:ci`                                                                   | Frontend on port 3000 and API on port 3001 |
| HTTP readiness      | Requests to both local roots                                                      | HTTP 200                                   |
| Cypress executable  | `yarn cypress verify`                                                             | Passed                                     |
| API and UI tests    | See command below                                                                 | 109 passed, 0 final failures; exit 0       |

The Cypress command was:

```shell
yarn cypress:run --browser electron --spec "cypress/tests/api/*,cypress/tests/ui/*" --reporter junit --reporter-options "mochaFile=../outputs/cypress-junit-[hash].xml,toConsole=false"
```

All nine API specs passed, for 51 tests. All seven UI specs passed, for 58 tests.
The UI coverage included authentication, bank accounts, payments, notifications,
transaction feeds, transaction details, and account settings.

## Limitations and observations

- Ten existing unit tests were skipped; these are not counted as passing.
- The user-search-by-last-name case in `ui/new-transaction.spec.ts` passed after
  a retry. Cypress retained a screenshot from the failed attempt. This is a
  starting maintenance observation, not a claim of first-attempt stability.
- The frontend build emitted non-fatal coverage annotation, browser-module, and
  configuration warnings. It is the existing CI build, not a validated
  production deployment.
- The startup log includes an inherited proxy target of
  `http://localhost:undefined`. The covered flows passed using the direct API
  configuration; production API configuration still needs explicit preparation.
- Cypress warned that Electron is deprecated as a test browser. A future CI
  change should use a supported Chrome setup.
- Component specs, mobile viewports, other browsers, and external authentication
  provider suites were not part of this run.
- These checks ran locally. GitHub required checks, automatic coding and review,
  production hosting, and cost-cap enforcement are still pending.

## Evidence and cleanup

Logs and JUnit XML files were saved outside the repository under the local parent
workspace's `outputs` directory:

```text
C:\Users\haide\Documents\Codex\2026-11-03\c\outputs
```

Evidence filenames include `factory-install-final.log`, `factory-types.log`,
`factory-lint.log`, `factory-test-unit-ci.log`, `factory-build.log`,
`factory-cypress-verify.log`, `factory-cypress.log`, `factory-server.log`, and
`cypress-junit-*.xml`.

The demo data was backed up before the tests. After the tests, the local test
reset endpoint restored the in-memory seed, the result was checked against that
backup, and the original file bytes were restored. Git confirmed that
`data/database.json`, `package.json`, and `yarn.lock` were unchanged. The local
test app remained available at http://localhost:3000.

Starting the local Node server caused a Windows Firewall permission prompt. The
agent did not change firewall settings; local testing uses loopback connections.
No production app or paid API credential was configured during these checks.
