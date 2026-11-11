# Neon integration verification — 2026-11-11

User-requested setup and subsequent skill/MCP audit are recorded in
[the Neon setup guide](../NEON.md). This report contains no credentials.

## Observed command evidence

```text
npm i -g neon@latest
added 159 packages in 36s
neon --version
9.3.2

neon config plan
Planned changes
  + bucket assets

neon deploy
Applied changes
  + bucket assets
Utilized services: Postgres, Object Storage
Pulled 9 Neon variables into .env
```

The tracked environment file was immediately restored and all nine generated
variables preserved in ignored `.env.local`. Project and organization reads
verified Frankfurt, PostgreSQL 18, and plan `free`; no plan was upgraded.

```text
npm run build
exit code 0

yarn test:unit:ci
Test Files  8 passed | 1 skipped (9)
Tests       44 passed | 10 skipped (54)

yarn test:production
tests 8
pass 8
fail 0

node --test scripts/tests/neon-avatars.test.cjs
Verified real Neon PostgreSQL profile metadata and private S3 upload/download.
tests 1
pass 1
fail 0

PASS: PostgreSQL profile, login session, and stored image survive server restart.

Cypress Neon browser test (repeated after review fixes)
All specs passed! 1 test, 1 passing

Existing API/UI regressions after review fixes
All specs passed! 110 tests, 110 passing, 16 specs

PASS: 8 browser artifacts contain none of the generated database or S3 credential values.
PASS: existing Codex, Copilot, and Claude configurations are byte-for-byte unchanged across the tooling audit.
```

The live API case checked authentication, rejected invalid signatures and
oversized uploads, saved a relative avatar reference, downloaded identical PNG
bytes, enforced private reads, and rejected another user's profile update.
The browser uploaded through account settings, displayed the real stored image,
and retained it after reload. The separate restart check reused the same login
session after the Node process restarted and rechecked both metadata and bytes.
All cloud fixtures are synthetic; existing Neon data was not reset or deleted.
Verification added four dedicated `factory...` accounts and six PNG objects
totaling 51,486 bytes. Two picture objects came from failing intermediate
reference-format tests and are not attached to a profile; they remain private.
Browser onboarding also added synthetic bank-account records to its test user.
The application initialized `rwa_state` and `rwa_sessions` on the initially empty
database and inserted its upstream synthetic seed once.

## Independent review and fixes

One separate AI reviewer received the requirements and working tree in a fresh
context and reviewed it read-only. No Critical findings were reported. Two
Important findings were reproduced before fixing:

1. A partial upload held the singleton state transaction and blocked concurrent
   API requests. The disposable PostgreSQL test failed with `false !== true` for
   concurrent authentication responsiveness. Identity is now copied under a
   short lease, with body reception and S3 I/O outside it. The full eight-test
   production suite then passed, including the new slow-upload case.
2. Default URL validation rejected the development avatar's `localhost` origin.
   The local API test failed with `422 !== 204`, then passed after allowing only
   the app's valid local avatar endpoint format alongside relative production
   references. Existing remote-avatar URL validation remains intact.

Minor deferred: image signatures are checked without full image decoding. A
valid image is verified in the browser; malformed files that retain valid magic
bytes may still be stored. No additional native imaging dependency was added.

The reviewer did not inspect secrets or independently judge cloud account state,
global installation hashes, final test outcomes, or public deployment. Those
claims rely on the separate direct evidence described here.

## Remaining verification and operational limits

Final post-review local regression and live browser runs passed. The original
local JSON fixture was restored and matches Git; no cloud fixtures were reset.
The preceding production-preparation revision passed GitHub Factory CI; the
new Neon integration revision must receive its own remote CI result.
The public website host, factory dispatcher, protected branch, production
approval environment, spending guard, and kill switch remain separate work.
Skills and MCP configuration alone do not run a software factory.

The first unauthenticated CLI inspection failed; the user then completed browser
login successfully. The web reader could not fetch the requested skill URL, but
a direct HTTPS fetch succeeded. An initial browser harness used removed
`Cypress.env()` and was corrected to `cy.env()`. Build warnings about bundle size
and the PostgreSQL driver's future SSL-mode interpretation are informational;
TLS verification was not disabled.

Sanitized local logs are under the workspace's `outputs`: `neon-init.log`,
`neon-deploy.log`, `neon-env-behavior-red.log`, `neon-env-green.log`,
`neon-review-lock-red.log`, `neon-review-localhost-red.log`,
`neon-review-localhost-green.log`, `neon-review-production-green.log`,
`neon-npm-build.log`, `neon-production-build.log`, `neon-avatars-final.log`,
`neon-restart-proof.log`, `neon-browser-final.log`, and `neon-regression.log`.
The final reviewed restart/browser logs are `neon-reviewed-restart.log` and
`neon-reviewed-browser.log`; the last npm build log is `neon-npm-build-final.log`.
Private environment, session, and raw CLI files are not committed or reproduced.
