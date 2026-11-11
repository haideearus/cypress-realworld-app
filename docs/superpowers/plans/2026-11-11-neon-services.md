# Neon Services Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline; maintain a ledger and obtain one final fresh-context review.

**Goal:** Wire the existing Express app to the requested Neon production Postgres branch and private Object Storage, with build and real service evidence.

**Architecture:** Preserve the pg pool, add private server-side object storage for profile pictures, and save avatar metadata in a separate synchronous transaction. Load private local environment before tracked defaults.

**Tech Stack:** Node 22.20.0, Yarn Classic, Express/React, pg, Neon CLI/config and the SDK recommended by installed Neon skills.

**Spec:** `docs/superpowers/specs/2026-11-11-neon-services-design.md`

## Global constraints

- Organization `org-summer-mouse-60284532`; project `purple-flower-40328107`; branch `production`.
- Additional spend USD 0; no paid upgrade, model API key, destructive database reset, or branch expiry on production.
- Generated credentials stay in ignored `.env.local` and server process variables.
- Retain existing development and CI defaults and the Yarn lockfile.

## Review focus

- Credentials must not be printed or bundled into frontend assets.
- Aborted remote storage requests must not mutate another request's database state.
- Uploads require authentication, bounded bytes, validated image content, and safe unique keys.
- Production initialization must preserve existing state and sessions.
- Public-host deployment and backend provisioning are distinct verified outcomes.

### Task 1: Neon linking and safe environment loading

**Files:** generated `neon.ts`, `.gitignore`, `package.json`, `yarn.lock`, `backend/environment.ts`, `backend/main.ts`, `scripts/tests/environment.test.cjs`.

**Interface:** `loadEnvironment()` loads local private variables before defaults, preserving explicit process values.

- [ ] Complete requested init, install/read Neon skills, inspect target/free-plan settings and config plan.
- [ ] Provision requested services, preserving tracked defaults and private env values.
- [ ] Add/run environment-precedence regression, implement loader, build server, verify passing regression.

### Task 2: Real object storage through the app

**Files:** `backend/avatar-storage.ts`, `backend/avatar-routes.ts`, `backend/app.ts`, `src/components/UserSettingsForm.tsx`, API/browser tests and deployment documentation.

**Interface:** storage reads server-only AWS environment variables; authenticated upload returns a unique avatar URL, and the existing user update persists it in a separate request. Authenticated download returns the stored bytes.

- [ ] Write/run focused failing API tests for auth, images/size, upload/read, and profile persistence.
- [ ] Implement storage adapter, bounded routes, ownership checks, and profile upload UI.
- [ ] Verify real cloud bytes and restart persistence with synthetic data, without production resets.

### Task 3: Build, final review, and evidence

**Files:** service verification report, deployment guide, PR evidence.

- [ ] Run `npm run build`, production build, types/lint, and relevant unit/API/browser regressions.
- [ ] Obtain one independent fresh-context review; fix important findings with regression evidence.
- [ ] Publish the reviewable branch/PR and report successful command output, failures, and any authentication/public-host work still required.
