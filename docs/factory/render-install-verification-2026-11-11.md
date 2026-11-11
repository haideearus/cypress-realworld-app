# Render build dependency fix — 2026-11-11

Ticket: [#4](https://github.com/haideearus/cypress-realworld-app/issues/4).
The first Render Free deployment of `d9bb41d` failed because the root install
script could not find Husky. Its `postinstall-postinstall` dependency invoked
`husky install && patch-package`; production-only dependency installation had
omitted these development tools.

The fix declares `YARN_PRODUCTION="false"` for all Yarn install phases while
retaining `NODE_ENV=production`, the frozen lockfile, install scripts, and Free
compute. Existing manually created services must add the variable through the
Render Environment page; changing a repository Blueprint does not configure
those services automatically. The private local import file was updated with
that additional variable, preserving all nine existing values and session secret.

An isolated reproduction used pinned Node 22.20.0 and Yarn 1.22.22, the existing
root postinstall script and exact existing dependency versions. Two fresh fixture
directories shared the same package manifest and patch; the only tested
environment difference was `YARN_PRODUCTION=false`:

```text
RED: NODE_ENV=production omits Husky; the unchanged postinstall fails.
GREEN: YARN_PRODUCTION=false installs Husky and successfully applies the dependency patch.
Both cases used the same package manifest, install script, and production NODE_ENV.
```

The successful case verified the patched file's actual content. This does not
skip lifecycle scripts or remove patch-package. Local logs are
`outputs/render-install-proof.log`, `render-install-red.log`, and
`render-install-green.log`, outside this repository. This is a targeted
installation reproduction, not a successful hosted redeployment.

The updated Blueprint passed Render's JSON schema and explicit assertions for
Free compute, manual deployment, the string `false`, and production NODE_ENV.
Formatting and Git whitespace checks passed. No application source, dependency
version, or lockfile changed; repeating the app runtime suite locally was not
needed for this environment-only change. A fresh-context read-only review and
the new PR's GitHub checks accompany the fix.

Hosted verification still requires adding the variable to the existing service
and a named human choosing **Clear build cache & deploy**, then checking the
actual deploy log and public application. No hosting upgrade is required.
