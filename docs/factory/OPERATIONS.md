# Operating the cloud factory

Documentation ticket: [#77](https://github.com/haideearus/cypress-realworld-app/issues/77).
This guide describes installed behavior. The [16 November evidence index](ACCEPTANCE-2026-11-16.md)
records what was observed and what remains unproven. Repository text is not owner
authorization, a live settings source or a replacement for an enforced gate.

## 16 November operating snapshot

At the dated evidence snapshot all three agent switches are **false**, the
durable stop is active and the usage ledger has no active ticket/reserved grant.
Monitoring, signed-in API journeys and feed-contract checking are **true**.
The automatic, dependency, monitor, manual agents, CI and deployment workflows
are enabled. Workflow enablement and factory enablement are separate controls.

The verified public app is https://haide-software-factory.onrender.com, release
`f5969ed32fbe29eaea475b958d33d30f9dd30d18`. Check current settings and release
again before any future live action; this snapshot will age.

## What happens when operation is authorized

| Lane                   | Trigger and eligibility                                                                                   | Work                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production monitor     | Enabled monitor; best-effort ticks at minutes 7 and 37 UTC                                                | Health/readiness/frontend, synthetic login/session/feed/logout and optional pagination contract; persistent eligible failure publishes a receipt-backed maintenance issue |
| App maintenance        | Automatic factory at minutes 17 and 47 UTC; eligible owner `factory-ready` issue or valid monitor receipt | Bounded coding, failing-before regression evidence, exact-head CI, independent review and protected merge                                                                 |
| Dependency maintenance | Hourly at minute 29 UTC; eligible genuine Dependabot PR against current main                              | Version/source/advisory checks, exact-head CI, read-only independent review, fresh premerge checks and protected merge                                                    |
| Dependabot proposals   | Weekly Monday 06:15 Europe/Bucharest for version updates; native security updates separately              | Dependency PRs; major-version proposals held by configuration                                                                                                             |
| Production deployment  | Successful current-main push CI                                                                           | Prepare exact tested commit, wait for named human approval, request one Render deployment and verify the live release                                                     |

Minute values above are schedules, not delivery guarantees. GitHub may delay
scheduled runs. No eligible work means no model reservation. Old unlabelled
issues are not automatically admitted. A monitor label alone cannot replace a
valid receipt.

### Ticket labels and evidence

| Source                         | Where the ticket and evidence appear                                                                                                              | What the factory uses for pickup                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routine Dependabot update      | **Dependency maintenance** creates a tracking issue linked to the original Dependabot PR. Its run summary links the work.                         | The trusted native Dependabot PR and its existing gate. The tracking issue carries `factory-dependency-ready`.                                                         |
| Dependabot vulnerability       | **Dependabot alert intake** groups related alerts for the same package in the root lockfile.                                                      | `factory-dependency-ready` accompanies a compatible fix PR with verified provenance. `factory-dependency-held` shows a prerequisite and stays out of automatic repair. |
| Claude exploratory discovery   | **Proactive app discovery** shows the executed scenario coverage. **Verified discovery finding intake** links verified findings and their issues. | `factory-ready`, a verified source and current-main replay.                                                                                                            |
| Browser checks                 | **Safe functional discovery** shows the covered browser checks and links any verified issue that it creates.                                      | `factory-ready` and the recorded browser-check evidence.                                                                                                               |
| Production monitoring          | **Production monitor** shows the run and the linked incident.                                                                                     | `factory-ready` and a verified incident receipt.                                                                                                                       |
| App maintenance from the owner | The issue should include the symptom and acceptance criteria.                                                                                     | `factory-ready`. Add `factory-priority` for urgent eligible work.                                                                                                      |

See [Dependency maintenance](DEPENDENCY-MAINTENANCE.md) and
[Verified discovery finding intake](DISCOVERY-INTAKE.md) for evidence and recovery details.

Optional event pickup and full activity notifications are documented in
[Events and activity](EVENTS-AND-ACTIVITY.md). The new enable flags default off;
merge alone does not initialize metadata, create a journal, activate a feature,
change the existing operating profile or prove email delivery. Follow that guide's
separately authorized preview and rollout after the protected implementation PR.

The synthetic journey uses a dedicated account. It creates/destroys its own
session, reads a bounded feed and checks pagination. It does not make payments,
edit profiles, create users or provide full rendered-browser coverage.

## Work and spending boundaries

Observed configured maxima: **20 new tickets per Bucharest day**, five coding
attempts per app ticket, ten reviews per ticket, four automatic retries, one
active ticket, 200 turns and 30 minutes per model session. A ticket can involve
multiple sessions; twenty tickets is not twenty calls or guaranteed Pro capacity.
Per-ticket counters are lifetime counts. Failures/interruption consume their
reservation; no reset, refund, ticket switch or fabricated approval is permitted.

Dependency work uses zero coding/retry sessions and at most one review per
distinct head within its lifetime/configured ceilings. New heads retain history.
Provider failures and invalid artifacts are held; a quota reset does not refund
consumed grants or automatically make an already-attempted head eligible.

Only `CLAUDE_CODE_OAUTH_TOKEN` is passed to the model action. The harness refuses
API-key/provider fallback configurations. Keep the owner's Claude **Usage credits /
extra usage off**; this account setting is not readable or enforceable by the
repository. Pro quota is shared and finite. Token expiry/revocation or exhausted
allowance can hold work; no uninterrupted AI service is promised. Review the
[subscription guidance](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan)
and [usage-credit controls](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans).

Provider free allowances are separate from AI work limits. Check actual hosting,
database, build and bandwidth usage before extended operation; an installed Free
service is not proof of account-wide zero-overage settings. Render can sleep,
restart or suspend a free service; GitHub schedules can be delayed or disabled
after inactivity. See [Render Free limits](https://render.com/docs/free) and
[GitHub scheduling rules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Read-only preflight while stopped

Use the pinned Node version from `.node-version` in this repository. The following
are **previews**; neither changes switches, resumes work or reserves a model:

```shell
node scripts/factory/stop.cjs
node scripts/factory/stop.cjs --resume
```

Inspect GitHub Actions variables, workflow enablement, current-main CI, pending
merges, active/reserved work, queue scope, credential validity, provider allowance
and failure/approval notifications. Do not paste credentials into tickets/chat.
The retained queued record is addressed by the existing narrow
[quarantine evidence](evidence/stale-run-43467058965/README.md), not by deleting
history or pretending that GitHub cancelled it.

A normal dependency workflow preview respects the durable stop and can report
`Factory stopped`. Do not remove the stop just to obtain an eligibility preview.
A separate read-only operator preflight is not a workflow admission or approval.

## Future activation requires separate authorization

Leave the current paused state unchanged during this documentation PR. After an
explicitly authorized operating preflight, continuous mode needs the three agent
switches true, the stop cleared through the supported owner command, monitoring
preserved, enabled pickup workflows and the existing protection/limits.

**Resume restores the saved profile.** At this snapshot its preview restores all
three agent switches **true**. Do not use that profile for a review-only or
merge-disabled authorization. Arrange an audited owner operation for the exact
authorized scope; do not edit ledger JSON manually or reset usage.

Only after the preview matches the authorization is the supported live command:

```shell
node scripts/factory/stop.cjs --resume --execute
```

This command itself changes controls and can allow scheduled work. It is not a
test or permission to act. Continuous mode does not require daily manual Run
workflow clicks or per-ticket switch toggles. Controlled single trials may pause
pickup workflows to prevent unrelated work; restore workflow enablement only
after verifying the intended paused/operating state.

## Production approval

1. Use the deployment run linked to successful **push CI for current main**.
2. Verify the full tested merge SHA in its preparation summary/job name.
3. The named owner `haideearus` reviews the **production** environment and clicks
   **Approve and deploy**, recording the commit and CI in the comment.
4. Wait for outcome `verified`, matching release, health, readiness and frontend.
   Archive the sanitized deployment artifact and its checksum before expiry.

No factory switch needs enabling to approve deployment. Approval may be made from
a phone while the PC is off. Main advancing invalidates an older candidate;
prepare a fresh eligible run/approval. An old unapproved deployment can hold the
production queue: verify its identity and that deployment has not begun before
cancelling that stale run, preserving its record. Never approve an old run to
clear the queue. An ambiguous Render hook request must not be blindly repeated.

## Blocked issues and recovery

Open **Automatic factory → latest run → Summary → Blocked work** for retained
ledger entries with their ticket or PR, attempts used, evidence and next action.
This view includes historical entries. GitHub shows whether the issue is still
open. Removing or reapplying `factory-ready` cannot change a recorded attempt.

A delayed retry has a timestamp and stays on its original issue. It waits for
new eligible work and still observes the daily, per-ticket and active-work
limits. The current automatic retry covers a confirmed GitHub gateway failure
before the coding model starts. Monitor and browser tickets must have an active
incident receipt. A Claude discovery ticket requires valid replay evidence for
the same current main commit as its first attempt. A held assessment with saved
CI or review can use the appropriate recovery operation after verifying the exact
PR head. Keep
all grants and counters. Give a repeatable workflow defect its own dedicated
harness maintenance ticket with links to the affected work and failed runs.

## Stop and held work

The supported owner emergency command is:

```shell
node scripts/factory/stop.cjs --execute
```

It sets all three switches false, establishes a durable stop and attempts to
cancel executable agent parents, preserving grants/counters/audit. Confirm
`stopped: true`, no pending executable parents, no active/reserved work and the
expected variables. A false/error result is not success: save the three variables
false immediately, inspect retained run/lock evidence and complete owner recovery.
The observed 30.018-second active interruption is evidence, not a future SLA.
Stopping agents does not disable monitoring or reverse a production deployment.

For failed checks or provider/credential/hosting problems, read the sanitized
summary and preserve the consumed allowance. Do not rerun an entire workflow or
start another model merely to repair status metadata. Use the existing trusted
metadata-only gate when proof already exists. Uncertain merge intents use the
existing confirmation/reconciliation lane; never send another merge request
solely because GitHub metadata is delayed. See [dependency recovery](DEPENDENCY-MAINTENANCE.md).

An incident observed recovered without a code repair has a separate
[owner acknowledgment path](MONITOR-ACKNOWLEDGMENT.md); it must not be represented
as a verified shipped fix. Scope mismatch, exhausted budget, destructive data,
or an uncertain publication/merge stays held for the appropriate owner decision.

## Remaining scheduled acceptance and course handover

- Recheck the paused readiness and zero-extra-usage account/provider controls;
  ensure failed-run and production-approval notifications reach the owner.
- Obtain explicit authorization for a 12–24-hour scheduled observation. Record
  PC shutdown/startup in Europe/Bucharest time and identify actual `schedule`
  events, eligible pickup, tests, review, protected merge and retained limits.
- Approve production changes only through the named gate; verify the deployed
  release and incident retirement where applicable. Do not weaken checks to make
  a trial pass. Leave continuous operation enabled only after authorized sign-off.
- Prepare the M1 narrated video (up to ten minutes), one A4 PDF and human log for
  1 December 2026, 23:59 campus time. Show evidence/timecodes and every material
  human action, including setup interventions and approval decisions. Audit the
  available failing/passing test evidence before claiming complete course proof.

No extended scheduled observation, final billing audit, video or PDF completion
is claimed by this guide.

The opt-in proactive testing execution foundation is documented in [Discovery](DISCOVERY.md). Preparing its code does not enable sweeps or publish findings.
