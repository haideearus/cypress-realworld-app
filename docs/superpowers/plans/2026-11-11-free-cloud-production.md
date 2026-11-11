# Free Cloud Production Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. Steps use checkbox tracking.

**Goal:** Deploy the full demo under one HTTPS URL with durable PostgreSQL data and no added paid usage.

**Architecture:** Keep the existing synchronous business logic, with production state serialized through PostgreSQL transactions. Compile server code, serve the built frontend alongside `/api`, and use PostgreSQL sessions.

**Tech Stack:** Node 22.20.0, Yarn 1.22.22, React/Vite, Express, lowdb, pg, connect-pg-simple, Render Free and Neon Free.

**Spec:** `docs/superpowers/specs/2026-11-11-free-cloud-production-design.md`

## Global Constraints

- Existing fork, license, tests, and local development behavior are preserved.
- `DATABASE_URL` and `SESSION_SECRET` are server-only secrets.
- Additional hosting and API spend is USD 0; no paid upgrade or model API key.
- Production database reset routes are disabled and seed initialization is once-only.
- Public deployment is verified before claiming it exists.

## Review Focus

- Database failure must not acknowledge uncommitted writes or leak credentials.
- Concurrent requests and a second process must not overwrite newer state.
- Login sessions must survive restart with secure cookies and no password hashes in responses.
- Missing environment variables, invalid ports, and startup failures must fail clearly.
- SPA fallback must not mask API failures or expose seed/reset endpoints.

### Task 1: Production HTTP and frontend boundary

**Files:** `src/utils/asyncUtils.ts`, `src/machines/*.ts`, `backend/app.ts`, `backend/main.ts`, `backend/config.ts`, `backend/public-user.ts`, auth and user routes; regression tests under `scripts/tests` and `cypress/tests/api`.

**Interfaces:** `createApp(config, persistence?)` returns an Express app; config exposes production, port, origin, sessionSecret, databaseUrl, and release. Frontend requests use Axios baseURL with production `/api`.

- [ ] Write/run old-backend HTTP and password-redaction regressions; preserve RED logs.
- [ ] Implement production config, shared API routing, frontend base URL, and redacted user output.
- [ ] Check focused tests, types, and existing unit tests; commit the tested change.

### Task 2: Durable state, sessions, and production artifact

**Files:** `backend/database.ts`, `backend/postgres-state.ts`, `backend/persistence-middleware.ts`, `tsconfig.production.json`, `scripts/build-production.cjs`, `scripts/tests/production-integration.test.cjs`, `package.json`, `yarn.lock`.

**Interfaces:** PostgreSQL state store accepts a Pool and state access (`read`, `replace`); `begin()` returns one request transaction with `commit`/`rollback`; middleware buffers responses until it completes. `build:production` emits `dist/client` and `dist/server`; `start:production` runs the compiled entrypoint.

- [ ] Write integration tests for durable restart, session reuse, concurrent mutation, failed mutation rollback, and database errors.
- [ ] Implement the transaction-backed store and production initialization using one client per transaction.
- [ ] Build and run against a disposable real PostgreSQL database, verify tests and a production browser flow.
- [ ] Run existing types, lint, unit, and API/UI suite; commit green results.

### Task 3: Reviewable cloud configuration and deployment

**Files:** `render.yaml`, deployment docs, GitHub workflow configuration as needed for a tested release.

**Interfaces:** Render Free builds with `yarn build:production` and runs `yarn start:production`; Neon supplies a secret connection URI. `/healthz` reports the deployed revision.

- [ ] Add the free service configuration and exact setup commands; validate its schema against current provider docs.
- [ ] Obtain one independent fresh-context whole-branch review, fix important findings with regression evidence, and publish a PR.
- [ ] Verify provider connections, create only free resources, preserve secrets in provider settings, and deploy after the required named approval.
- [ ] Verify the public frontend, API, persistence across restart, and release revision; report actual completion or the specific remaining access action.
