# Synthetic-user app checks

Owner selected bounded API checks and asked to proceed without further design
questions. Implementation ticket: #46. Keep the three agent switches false, the
existing monitor setting and durable stop marker unchanged. No live authenticated
production check, Claude session, merge, deployment or paid API is part of this PR.

## Intent and approaches

The existing monitor already detects availability failures and creates trusted,
deduplicated tickets. Extend it to detect broken sign-in/session/feed/logout
behavior. The selected API journey is lighter than a browser runner and needs no
new dependency. Browser rendering/click coverage remains a later extension;
unauthenticated probes alone would miss signed-in functionality.

## Contract

The new `FACTORY_APP_CHECKS_ENABLED` is false when unset. Credentials later come
from `FACTORY_MONITOR_USERNAME` and `FACTORY_MONITOR_PASSWORD` GitHub Secrets for a
dedicated synthetic account. The owner creates that account separately. Checks
never create users/payments, edit profiles, seed data or alter production setup.
Signing in and out creates/destroys only the check's own session.

Every scheduled monitor tick (existing 30-minute cron) may run this fixed journey:
POST /api/login; GET /api/checkAuth; GET /api/transactions/public?page=1&limit=5;
POST /api/logout; GET /api/checkAuth with the old session, expecting JSON 401.
Only `https://haide-software-factory.onrender.com` is reachable by these helpers.
No redirect is followed. POSTs carry the fixed Origin required by the app.
Verify user identity and bounded pagination, allowing an empty feed. Cleanup is
attempted whenever a cookie is available, including earlier failures.

At most three attempts, ten seconds per request, 64 KiB per response, two
30-second retry pauses. Each attempt has at most five calls, including cleanup
and logout verification. With timeout guards the journey is bounded by 212
seconds; existing availability probes by 152. Scanner install plus scan share
one 30-second subprocess deadline. In app-check mode, all incident-publication
HTTP calls share 60 seconds, leaving 26 seconds of the unchanged eight-minute
job budget for setup. Provider/setup overruns still fail closed; they are not
an uptime guarantee. The legacy availability-only transport is unchanged. Runtime
validators may lower these limits in tests but cannot raise them.

Owner manual preview may set `app_checks=true` while `dry_run=true` without
enabling the global flag. That override never applies to scheduled or live runs.

The credentialed checker receives no GitHub token, provider credential, App key
or deploy hook. A later scanner step and publisher receive no account secrets.
The checker writes an exclusive, bounded regular JSON file in RUNNER_TEMP with
only strict run/source/time metadata and enum outcomes. The publisher accepts
only the current repository/run/first attempt/source and a report at most ten
minutes old, rejecting future timestamps beyond five seconds. Extra fields,
symlinks/hardlinks, oversized or missing reports fail closed. Scan before use.

Missing configuration fails before network or ticket writes. HTTP/application
failures produce only login/session/feed/logout ok/failed outcomes and an attempt
count; no cookies, credentials, response data, usernames or exception text enter
reports, issues or model context. Existing availability observations stay valid.
An optional strict appChecks object is combined into overall health. Existing
three-check observations, old receipts and isolated drill behavior remain valid.

Persistent failures reuse the same monitor incident/receipt, creation caps and
fixed diagnostic acceptance criteria. No extra repair budget or arbitrary issue
trust is introduced. Healthy status alone does not assert that an agent repair
or deployment occurred. Monitor issue creation uses no AI; coding stays disabled.

## Delivery and proof

Failure-first tests cover endpoint/method/origin/cookie boundaries, broken auth,
feed/session/logout contracts, malicious/oversized/never-ending responses,
cleanup/retries, report provenance/file safety, credential isolation, old monitor
compatibility and trusted ticket admission. Add a journey test against the real
compiled app with disposable PostgreSQL, not production. Prepare a draft PR,
fresh local review and normal CI. Genuine Claude Pro review, secret entry,
preview and live rollout are separate later owner actions. Document API-only
coverage, session effects, free-host cold starts and provider scheduling limits.
