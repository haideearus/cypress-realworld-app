# Synthetic-user API checks

Implementation: [#46](https://github.com/haideearus/cypress-realworld-app/issues/46).
This extension is prepared for review. It is default-off; source code, local tests
and CI do not establish a live rollout. The existing availability monitor remains
separate from enabling agents or clearing an owner emergency stop.

## What it does

Each enabled monitor tick performs this small journey against the fixed demo:

1. Sign in with the dedicated synthetic account (no remembered session).
2. Confirm the session belongs to that same account.
3. Read page 1 of the public transaction feed, limited to five entries. Empty
   feeds are valid; identity, JSON and pagination still must match.
4. Log out and verify the old cookie receives an unauthorized JSON response.

It never creates payments/users, edits profiles, uploads files, resets a database
or follows redirects. Login/logout creates and destroys its own session; a network
failure can prevent cleanup when the cookie was never received. These are API
checks, not rendered-browser/button coverage. Three attempts use ten-second
request deadlines, 64-KiB response limits and 30-second pauses. The existing
eight-minute workflow bound and 30-minute best-effort schedule remain unchanged.
Scanner installation and report scanning share a 30-second deadline; app-check
incident publication has a shared 60-second HTTP budget. Cold downloads or API
outages fail closed rather than consuming unbounded runner time. An uncertain
publication retains its pending receipt for operator recovery, as before.

The account step receives its two account secrets, no GitHub token, Claude
credential, App key or deploy hook. A separate credential-free step scans its
report. The publisher gets a GitHub token but no account secrets. Only strict
run/source/time metadata, four ok/failed outcomes and an attempt count cross that
boundary. Cookies, user/feed data, response bodies and remote exception text are
not logged, uploaded or copied into issues or model context.

## Settings after review and merge

| Kind     | Name                         | Value/source                              |
| -------- | ---------------------------- | ----------------------------------------- |
| Variable | `FACTORY_APP_CHECKS_ENABLED` | Initially `false`; unset also means false |
| Secret   | `FACTORY_MONITOR_USERNAME`   | Dedicated synthetic demo account username |
| Secret   | `FACTORY_MONITOR_PASSWORD`   | That account's password                   |

Keep the three agent switches false. Preserve `FACTORY_MONITOR_ENABLED`, limits
and the current stop marker. No provider API key, extra AI service or paid AI
usage is needed by these HTTP checks. They consume ordinary runner and free
hosting/database resources.

Create the dedicated account using the demo app's signup and fictitious data.
Do not reuse a personal/privileged account or put its password in chat, tickets,
PRs, logs, committed files or workflow inputs. Save both values under Settings →
Secrets and variables → Actions → **Secrets**. The implementation does not create
that production account or save these settings for you.

## Preview without enabling scheduled app checks

After independent review, merge and saving the two secrets:

1. Leave `FACTORY_APP_CHECKS_ENABLED=false` and all three agent switches false.
2. Open Actions → Production monitor → Run workflow; select `main`.
3. Leave the preview checkbox checked (`dry_run=true`).
4. Check **Include signed-in checks in this preview** (`app_checks=true`).
5. Run once. Expect `outcome: preview`, overall `healthy: true`, the existing
   three checks, and `appChecks` with `login/session/feed/logout` all `ok`.

The preview makes the synthetic session requests, but no ticket or monitor-state
write and no model invocation. It does not enable scheduled signed-in checks.
The preview override is ignored when `dry_run=false`; live checks require the
repository variable. Missing credentials, invalid context or unsafe/missing
reports fail closed without publishing an application incident.

## Later explicit rollout

After a passing preview and owner authorization, save
`FACTORY_APP_CHECKS_ENABLED=true`. While the existing monitor is enabled, the
schedule includes the journey. A persistent failure reuses the existing single
active incident, trusted receipt, two-publication-intents-per-UTC-day bound and
`factory-ready` ticket. Repeated failures get no new repair allowance. Legacy
three-check receipts and isolated drill checks remain valid.

A green monitor run means observation/publication succeeded, not necessarily a
healthy app: read its outcome. Provider, quota or credential problems can require
operator attention rather than a code patch. A later healthy observation is not
proof of a particular repair or deployment.

Ticket creation does not start Claude while the agent switches are false or the
owner stop marker is active. Future repairs need separately authorized resume and
rollout, then CI, fresh Claude Pro review, protected merging and named production
approval. Keep provider extra usage off; checks do not inspect billing settings.

To stop only these journeys, set `FACTORY_APP_CHECKS_ENABLED=false`; cancel an
already-active monitor if necessary because variables may be snapshotted. Basic
availability monitoring continues. Preserve receipts and counters.

## Verification

Factory tests cover fixed host/method/origin boundaries, identity, feed pagination,
cookies and old-session logout, retries/cleanup, malicious/oversized/hanging
responses, credential isolation, report provenance/freshness/file safety,
preview, deduplicated tickets and old monitor/drill compatibility. The production
integration test also uses the real compiled app and disposable local `_test` PG.
Only its test transport maps the fixed public origin to localhost; no runtime
destination override is introduced.
