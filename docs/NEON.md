# Neon setup and service verification

This app uses the existing Express server with `pg` for Lakebase Postgres and
the native AWS S3 SDK for private profile pictures. Neon provisions these backend
services; the public website still needs its separate application host.

## Provisioned target

- Organization: `org-summer-mouse-60284532` (verified Free plan).
- Project: `purple-flower-40328107`, `software-factory-rwa`.
- Region: `aws-eu-central-1` (Frankfurt), PostgreSQL 18.
- Branch: `production`, `br-gentle-meadow-b97a88gn` (default branch).
- `neon.ts`: retains the generated policy and declares one private `assets`
  bucket, with Auth disabled. No Functions or AI Gateway were deployed.

The requested `npm i -g neon@latest` installed CLI 9.3.2 in the workstation's
Node 22 tooling prefix. It ran the requested `neon init -y --org-id ...
--project-id ... --branch production --services postgres,object-storage`.
Initialization generated local configuration and tooling before CLI sign-in.
The user completed `neon login` in the browser, then the existing project was
linked with `--no-env-pull` to preserve configuration. `neon config plan`
reported only `+ bucket assets`; `neon deploy` applied it successfully.

## Credentials and environment

`.neon` and `.env.local` are ignored. The CLI's nine generated Postgres, branch,
and storage variables were moved into `.env.local`; the original tracked `.env`
defaults were restored unchanged. Neither file's private values are printed in
the verification report. `NEON_FUNCTION_HOST_SUFFIX` is metadata, not evidence of
a deployed function.

The server loads `.env.local` before `.env`, while explicit process variables
take precedence. Production still requires a private `SESSION_SECRET` of at
least 32 characters and the exact HTTPS `APP_ORIGIN` (or Render's external URL).
The database URL is pooled for application requests. Added dependency versions
are exact and recorded in `yarn.lock`: `@neon/config` 1.14.0, `@neon/env` 2.1.3,
`@aws-sdk/client-s3` 3.1166.0, and `@aws-sdk/s3-request-presigner` 3.1166.0.

Copy the Neon values privately into the application host's environment when
deploying. Never prefix credentials with `VITE_`, commit them, or paste them into
chat. `AVATAR_BUCKET` defaults to `assets`. The existing local JSON development
mode remains available; `yarn dev` must never be used as production startup.

## Agent tooling audit

The exact requested [Neon skill](https://neon.com/.well-known/agent-skills/neon/SKILL.md)
was fetched and read, alongside the installed Postgres and Object Storage skills.
The web reader could not open the skill endpoint; an HTTPS download of that same
URL succeeded. The downloaded copy is in local `outputs/neon-requested-SKILL.md`.

The initial CLI setup reported user-level Neon plugin installation for Codex,
Claude Code, and VS Code, plus a Copilot MCP configuration. Seven user-level
skills are installed and all reported **up to date**: `neon`, `neon-postgres`,
`neon-object-storage`, `neon-auth`, `neon-functions`, `neon-ai-gateway`, and
`neon-realtime`. Installed instructions do not enable those cloud services or
start autonomous maintenance agents.

The verified Codex plugin is `neon-postgres@plugins-cli`, version 3.0.6, enabled
in the user's configuration. Its manifest includes the HTTP MCP server
`https://mcp.neon.tech/mcp`, with no embedded authorization headers. The skill
explicitly says not to duplicate manual skills/MCP installs when the plugin is
already installed, so no duplicate project installation was added.

During the explicit tooling audit, SHA-256 checks confirmed that existing Codex,
Copilot, and Claude configuration files remained unchanged. No existing
integration was removed. Current-chat Neon MCP tools were not exposed, so service
verification used the authenticated CLI and application. Codex may need a reload
to load its plugin, and MCP can require its own OAuth sign-in.

## Application changes

- `backend/environment.ts` supplies safe environment precedence.
- `backend/avatar-storage.ts` uses branch-scoped AWS environment credentials,
  mandatory path-style S3 addressing, bounded storage requests, and 60-second
  presigned download URLs. Storage credentials remain on the server.
- Avatar requests resolve and copy session identity under a short transaction,
  then release the database lease before receiving bytes or contacting S3.
  Other application requests can continue while an upload is incomplete.
- `POST /api/avatars` accepts authenticated PNG/JPEG/WebP uploads up to 2 MB and
  uses unique keys. `GET /api/avatars/:userId/:object` authenticates before
  redirecting to a temporary private download URL.
- The account settings UI uploads the picture and saves its relative reference
  through a separate profile PATCH. Profile PATCH requires the account owner.
  Development `localhost` avatar URLs are also accepted.
- Signature checks identify supported file types; they do not fully decode and
  validate every possible image. That minor review finding is deferred. Browser
  coverage verifies that an uploaded valid PNG actually displays.

## Verification commands

```shell
npm run build
yarn build:production
yarn types
yarn lint
yarn test:unit:ci
```

`yarn test:production` additionally requires `TEST_DATABASE_URL` pointing to a
disposable database ending in `_test`. That suite drops test tables and must
never target this production Neon database.

`npm run test:neon:services` instead tests the running production app at
`NEON_TEST_APP_URL` (default `http://127.0.0.1:8082`), with its expected origin in
`NEON_TEST_APP_ORIGIN`. It creates a dedicated synthetic account and image; it
does not reset existing data. The optional private `NEON_TEST_EVIDENCE` file can
record its session for a restart check. The browser test uses
`scripts/cypress.neon.config.cjs`, `CYPRESS_NEON_TEST_USERNAME` for that dedicated
`factory...` account, and an HTTPS app URL. It creates one synthetic bank account
to complete onboarding before testing account settings.

Local HTTPS proxies and disposable test tooling are kept outside the repository
under the workspace's `outputs`; they are not a public deployment.

See [the dated verification report](factory/neon-verification-2026-11-11.md) for
actual outcomes, command output, review fixes, and remaining work.
