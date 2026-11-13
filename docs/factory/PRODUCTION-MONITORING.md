# Production monitoring and maintenance tickets

Implementation ticket: [#33](https://github.com/haideearus/cypress-realworld-app/issues/33).
Keep the three existing factory switches false during installation. The new
monitor is also disabled unless `FACTORY_MONITOR_ENABLED=true`.

## What runs in the cloud

`Production monitor` checks `/healthz`, `/readyz` and the frontend HTML on the
fixed production URL every 30 minutes. Three bounded rounds, separated by
30-second pauses, allow a sleeping free service to wake. It never logs in, writes
production data, seeds a database or calls an AI model. These are availability
checks, not a full browser test of every payment flow.

The monitor accepts a healthy deployed SHA even when main is newer: a newer
commit may still be awaiting human deployment approval. A green Actions run
means the observation succeeded; read its summary to see whether the app was
healthy. A reported outage can produce a green monitor run.

After a persistent failure it creates one `factory-ready` diagnostic issue with
fixed acceptance criteria. No response body, headers, credentials or external
instructions are copied into the ticket. The diagnostic must stop if it finds a
hosting quota, credentials or provider problem instead of a reproducible code bug.
It must not upgrade a service, change credentials or invent a patch.

Repeated failures keep the same incident. The monitor cannot give an exhausted
ticket a fresh daily budget. There is at most one active incident, two publication
intents per UTC date, and 180 retained incident records before owner maintenance.
The separate AI admission allowance uses **Europe/Bucharest** and is not consumed
by monitoring or by creating an issue.

## Why a monitor ticket can enter the factory

The issue must match a durable receipt in `factory/monitor:monitor.json`: issue
number, criteria hash, incident ID, workflow commit, source run and first attempt.
The source must be a successful main `Production monitor` run with its actual
publication step successful. A label or `github-actions[bot]` author alone does
not qualify. Edited criteria, forged receipts and failed runs are rejected.

Pickup and admission check the active receipt. The admission ledger keeps its
immutable proof; merge verifies it again, allowing a later healthy observation
without changing the approved task. Owner-created `factory-ready` issues retain
their existing behavior. Historical issues without eligibility remain untouched.

The monitor uses its own GitHub Actions token to write issues and the monitor
registry. It has no Claude secret, App private key, deploy hook or paid API key.
The GitHub App keeps its existing permissions, including Issues **read**. The
automatic preview gains Actions **read** to verify a monitor's source run.

## Setup after independent review and merge

1. Keep `FACTORY_ENABLED`, `FACTORY_AUTOMATION_ENABLED` and
   `FACTORY_AUTOMERGE_ENABLED` set to `false`.
2. Under **Settings → Secrets and variables → Actions → Variables**, add
   `FACTORY_MONITOR_ENABLED=false`. No new secret or provider account is needed.
3. Only after this PR is merged, change `FACTORY_MAX_TICKETS_PER_DAY` to `20`.
   Current main's previous ceiling of 10 still controls this PR's review before
   merge. If today's budget is exhausted, use the next Bucharest daily window;
   do not reset history, reuse another review ticket or bypass required review.
4. Open **Actions → Production monitor → Run workflow**. Select **main** and
   leave the preview checkbox checked. Click **Run workflow** once.
5. Open its summary. Expect `outcome: preview`, `healthy: true`, three `ok`
   checks and no new issue or registry write. All factory switches stay false.
6. In a separately authorized controlled trial, set only
   `FACTORY_MONITOR_ENABLED=true`, run with preview unchecked, and inspect the
   summary. A healthy run creates no ticket. Do not break production to test it.
   Restore the monitor switch to false afterward if the trial is complete.
7. Separately enable ongoing monitoring when ready. Turning the monitor on does
   not turn coding, pickup or merging on. Automatic repairs need the existing
   factory switches and limits; production deployment still requires the named
   owner's approval. Keep Claude usage credits/extra usage off.

No real failure was injected during implementation. Local transport fixtures
prove deduplication and provenance; the cloud preview and later full incident
trial must still be observed before claiming unattended end-to-end operation.

## Limits, costs and operator recovery

For a controlled cloud demonstration without breaking Render, use the separately
reviewed [monitor repair rehearsal](MONITOR-REPAIR-REHEARSAL.md). Its temporary
fixture, ticket origin and registry are isolated; drill recovery never supplies
production admission or approval evidence. A live rehearsal must be demonstrated
before claiming it passed.

The higher daily ceiling permits 20 **new tickets**, not 20 model calls. Existing
ceilings remain: five coding sessions, five review sessions, four automatic
retries, 200 turns per session, 30 minutes and one simultaneous ticket. A larger
allowance can consume included Claude Pro usage sooner. It adds no API-key
fallback or purchased capacity and cannot enforce provider billing settings.

Monitoring uses standard GitHub runners and ordinary public HTTP requests. Free
hosting/database usage still counts toward the providers' quotas. A 30-minute
probe can wake a sleeping service. GitHub schedules are best effort and public
repository schedules can stop after inactivity; this is not an uptime guarantee.
See [GitHub scheduling rules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
and [Render Free behavior](https://render.com/docs/free).

An issue-create intent is written before a single POST. A timeout, cancellation
or failure afterward can leave `publication_needs_owner_recovery`: inspect the
real issue and source run before repairing state in an owner-reviewed operation.
The monitor deliberately does not retry an uncertain publication or trust a
receipt from a failed source run. Do not delete the registry or reset counters.

A healthy observation records recovery without claiming a particular PR fixed
the outage. The issue stays open for the owner to assess the evidence. Once it is
closed and a healthy check is observed, the monitor can create a future incident.
Closing it during a continuing outage cannot immediately create another ticket.
Automatic resolution tied to deployed repair evidence and generic stale-run
recovery remain a later stage.

To stop new monitoring work, save `FACTORY_MONITOR_ENABLED=false`; also cancel an
active monitor run if needed because GitHub can snapshot variables. To stop agent
work, save the three factory switches false and cancel any active factory run.
Previously admitted ticket history and outstanding incident evidence remain.
