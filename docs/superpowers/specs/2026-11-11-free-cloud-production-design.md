# Free cloud production design

The owner selected free cloud hosting, persistent demo data, and existing Codex
subscription usage, and explicitly asked us to proceed without more setup
questions. Step one is merged as PR #1. This change makes the full app deployable.

## Deployment contract

One Render Free Node service serves the built React frontend and an `/api`
namespace. Neon Free PostgreSQL stores the application state and login sessions.
The service reads `PORT`, `DATABASE_URL`, `SESSION_SECRET`, and `APP_ORIGIN`
(falling back to Render's external URL). Startup fails with a sanitized error
when production configuration is incomplete. No API key or paid plan is added.

Build a separate `dist/client` and compiled `dist/server`; keep the existing
development and Cypress build paths working. Production uses compiled Node code
to keep memory and cold-start overhead below the development TypeScript runner.

## Persistence choice

A full rewrite of every synchronous lowdb business function into asynchronous
SQL would increase the change and regression surface. Instead retain the
business logic and back its state with one PostgreSQL JSONB document, appropriate
for this small, single-instance teaching demo. Development keeps its local file.

Each production API request gets an exclusive local state lease and a PostgreSQL
row lock on one client transaction. Refresh the in-memory state if its revision
has changed. Commit changed state before sending a successful response. Roll
back failed requests and invalidate cached state after database errors. Buffered
API responses prevent acknowledgement before durable commit. Sessions use a
standard PostgreSQL Express session store. This is a deliberate small-app
architecture; high-volume service would need a relational data model.

## Security and availability

Use a generated server-only session secret, secure HttpOnly SameSite cookies,
trusted hosting proxy configuration, and a same-origin mutation check. Strip
password hashes from all REST user responses. Disable development reset routes
in production. A cheap `/healthz` does not wake the database; `/readyz` verifies
database connectivity. Unknown API paths return JSON 404, not the SPA page.

Neon provides persistence across Render restarts. Free hosting may sleep and
both services have quotas. Keep auto-deployment off; the production deployment
workflow must require a named GitHub environment reviewer before using its hook.
Agent cost controls are separate work and stay marked pending.

## Acceptance evidence

- A test fails on the existing password-hash response leak before the fix.
- Production HTTP tests fail against the old local backend's missing health,
  frontend, and API namespace before implementation.
- Real PostgreSQL integration verifies restart persistence, sessions, rollback,
  and concurrent requests without lost changes.
- A browser signs in and loads the production app under one origin.
- Existing types, lint, unit, and API/UI checks remain green.
- A free service is only called deployed after its public URL is verified;
  missing account connections are reported as an access requirement.
