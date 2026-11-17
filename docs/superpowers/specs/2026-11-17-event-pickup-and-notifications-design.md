# Event pickup and complete factory activity notifications

Status: proposed design; implementation and live rollout are not approved by this
document. Requested by the owner on 17 November 2026. The owner selected option 1:
GitHub events with cron fallback, without another service or paid AI APIs.

## Intent and observed problem

The owner wants maintenance to proceed with the PC off and wants emails about
new issues, checks, blocked work, coding, review, merging and deployment. They
also need a clear explanation of who finds problems and who repairs them.

Continuous mode was enabled on 16 November at 20:40 Bucharest. At the overnight
inspection, all three agent switches were true, the durable stop was absent,
workflows were enabled and the usage ledger was idle. Only three scheduled runs
appeared in 13.85 hours against 69 nominal cron opportunities. The app pickup was
idle, dependency PRs #59/#76 needed current main and the monitor reported healthy
availability and signed-in checks. No change merged, so no deployment was due.
The missing timer deliveries have no proven GitHub-internal cause. Current
default branch, workflow enablement and repository Actions policies did not
explain the gap. Do not claim that this design repairs GitHub's scheduler.

The two dependency branches were subsequently refreshed using expected-head
branch updates, and native CI passed for both. This operational action is not a
replacement for independent reviews or evidence that event pickup is installed.

## Who finds and solves issues

| Component              | Existing responsibility                                                                                    | Boundary                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Production monitor     | Health, readiness, frontend response, synthetic login/session/feed/logout and pagination contract          | Fixed API checks; not autonomous exploration of every page or discovery of every possible bug                                |
| Dependabot             | Scheduled version proposals and native vulnerability/security update proposals                             | Updates are candidates; advisory/version checks, tests and review still apply                                                |
| Owner                  | Describes other observed bugs and explicitly marks a bounded app ticket ready                              | Old unlabelled issues are not automatically coding instructions                                                              |
| CI                     | Unit, API, browser and production regression tests when relevant workflows run                             | Not a continuously running exploratory tester; a failing candidate need not indicate a deployed incident                     |
| Coding agent           | Investigates an admitted app ticket, preserves a failing regression, repairs and retests                   | Runs only under a durable grant, scope and limits; may hold provider/configuration failures rather than invent a code change |
| Independent reviewer   | Reviews the final commit with fresh context; dependencies are read-only reviews                            | A check/notification cannot substitute for genuine review                                                                    |
| Controllers and merger | Verify provenance, enforce budgets/locks, require current-head CI/review and perform protected publication | No model decides to bypass protection or refund counters                                                                     |
| Named owner            | Approves each production deployment and handles exceptional/destructive/spend decisions                    | Remains a human gate, usable from a phone                                                                                    |

This change improves pickup and visibility. Expanding browser exploration, adding
more production journeys or having an AI continuously search for unknown bugs is
outside its scope.

## Approaches considered

1. **Selected: GitHub events plus existing cron.** React to eligible issue changes,
   verified monitor completions and genuine Dependabot CI completions. Reuse the
   current workers and add GitHub activity reporting. No new hosted service,
   email provider, personal access token or paid AI API is needed. Periodic
   monitoring and completely quiet periods remain subject to cron delivery.
2. **Independent free timer/watchdog.** A separate service can trigger/check when
   GitHub cron is silent. It adds an account, trigger credentials and its own
   availability/security limits. This was not selected and is not installed here.
3. **Keep cron and manual recovery only.** Smallest code surface, but it leaves
   pickup delays and the visibility gap that prompted the request.

## Event architecture

Add a trusted default-branch workflow, provisionally `factory-wake.yml`, which
observes metadata and dispatches the existing automatic/dependency workflows on
`main`. It does not check out PR code, install PR dependencies, run tests or
invoke a model. It reads only trusted helper source from its own workflow SHA.

| Signal                                                      | Required validation before a wake request                                                                                                                            |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner issue opened, labelled, reopened or edited            | Current open issue in this repository, owner identity, `factory-ready`, bounded secret-scanned content and existing candidate/criteria rules                         |
| Production monitor completed                                | Exact allowlisted workflow identity, repository, default-branch source, run/attempt and completion; read the existing monitor registry and receipt-backed live issue |
| Factory CI completed for a dependency PR                    | Real CI workflow/run/job identity; associated same-repository genuine Dependabot PR and current head; allowed dependency file scope; successful exact-head native CI |
| A real admitted factory run completed and released the lock | Verify its ledger-linked admission/grant and terminal state; scan the live queue once to service work that arrived while busy                                        |

Owner-authored harness PR CI does not initiate a review or app coding run.
Arbitrary public issues, labels, comments, edited issue text after admission,
fork PRs and unexpected actors do not acquire a reservation. Notification
comments are never wake signals. Failed/cancelled CI does not authorize a model;
it creates a visible hold or activity result.

The monitor currently creates issues with `GITHUB_TOKEN`. Its issue event cannot
be assumed to start another workflow. Use its verified `workflow_run` completion
to recover the open incident from trusted state. Do not replace receipt checks
with label or title matching.

### Dispatch identity and permissions

Use the existing job-scoped `GITHUB_TOKEN` for explicit `workflow_dispatch`
requests; GitHub supports those dispatches even when the triggering operation
uses that token. No new long-lived trigger token or broader GitHub App
installation is proposed. The wake job needs only repository contents write for
its metadata registry, issues/pull requests read, and actions write. All other
jobs retain minimum required permissions.

This requires a **narrow new admission path**: current `policy.authorize`,
automatic/dependency context checks, parent-run checks and worker validation
currently accept owner-started schedule/manual invocations. Simply adding `on`
events or replacing the actor with the owner's name is incorrect.

The new path must validate the actual GitHub-produced dispatch actor identity
(the fixed `github-actions[bot]` account), exact receiver workflow on `main`, the
producer wake workflow's ID/path/SHA/repository/run/attempt, a typed receipt and
current source eligibility. Bind the receipt to the receiver's first run and
attempt before any reservation. Retain actual producer and source actors in
audit; never impersonate `haideearus`. Preserve the existing owner-only manual
and scheduled paths and reject a bot dispatch without this complete proof.

Workers, CI provenance, merge context and dependency ticket validation must
recognize the same verified parent identity throughout the run. A trusted wake
does not relax current-main ancestry, exact-head CI/review, content restrictions,
daily/lifetime limits, stop checks or the one-ticket lock.

### Receipts, duplicate events and queue draining

Use a separate bounded metadata branch, provisionally `factory/wakes`, with a
validated versioned registry. It is separate from ticket/grant counters. A
receipt identifies source kind, source run/event identity, source attempt,
target lane, issue/PR number, observed head, producer workflow SHA and dispatch
state. Its producer identity and immutable source snapshot must be verifiable
against GitHub APIs, not only trusted because JSON exists.

Record intent before dispatch, send at most one request for that receipt, then
record acknowledgment. An uncertain response is held and reconciled against
matching receiver runs; never repeat an uncertain dispatch blindly. A second
receiver cannot claim an already-bound receipt. Revalidate the candidate and
all controls at admission; a changed head, edited frozen criteria or closed
issue invalidates that wake without refunding any existing reservation.

Collapse duplicate events for the same source revision. A busy lock preserves a
pending signal; it does not consume a model attempt. After a real admitted run
finishes and releases the lock, one bounded drain wake checks the current queue.
Idle/skipped runs cannot trigger another idle run. Registry retention must keep
unresolved intents and replay-prevention identities for at least the same window
as source events can be replayed; reaching its approved bound holds work visibly
rather than dropping unresolved identities or resetting usage.

Explicit dispatch handoffs avoid an unbounded `workflow_run` chain. Keep every
observer chain below GitHub's three-level limit; exclude the wake and notification
workflows themselves from observer allowlists. Test multiple queued tickets,
duplicate deliveries, cancellation and a stale completion event.

### Dependencies and stale branches

Keep the current dependency ancestry guard. The 17 November owner-requested
refresh of #59/#76 is already recorded separately. Automatic branch mutation is
not added silently to this event design. An outdated dependency PR produces a
specific `held: current-main refresh required` activity entry, with a PR link.
It does not get approved or consume a model session merely to make progress.

Future Dependabot refreshes and CI completions can wake reevaluation. This path
does not promise that all future stale branches repair themselves; automatic
branch synchronization would need its own bounded design and authorization.

## Email and activity design

The owner's request is **full activity**, not a failure-only digest. Use GitHub's
existing notification delivery plus explicit sanitized activity entries. Do not
introduce SMTP, Resend, a mailing list or a paid email API.

### Account/repository settings

The owner must choose Email for Actions without the failed-only filter, enable
email for watching/participating and own activity as desired, and watch this
repository's All Activity. Keep Dependabot alerts and phone deployment approvals
enabled. These settings can also produce unrelated account workflow emails;
repository watching scopes issue/PR notifications. They are personal settings,
not enforceable or secret-readable by repository code. They have not been
changed by this design. Browser automation was blocked by URL identification,
so provide the owner the exact manual steps and verify by owner confirmation.

### Semantic activity records

Create one owner-approved `Factory activity` issue, never labelled factory-ready.
Store its validated number in a public configuration variable. A trusted
metadata-only observer posts one separate comment per event to that journal;
the owner gets the normal issue email subscription. Also post concise lifecycle
results to the owning maintenance issue/PR where useful. No digest or silent
sampling is the default. Native GitHub may still group or suppress emails and
mail providers may filter them; posting a comment is not proof of inbox delivery.

| Event                                   | Information reported                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Issue created, changed or closed        | Number/link, source, lifecycle action and eligibility; no arbitrary full body                             |
| Monitor check completed                 | Time, healthy/unhealthy, individual check results, release, retries and run link; include healthy checks  |
| Automatic/dependency queue checked      | Eligible candidate, empty queue, busy lock or exact hold reason; include idle checks                      |
| Coding/review phase started or finished | Ticket, phase, actual run/job/head, outcome and consumed allowance; no prompts or credential-bearing logs |
| CI/build/tests completed                | Passed/failed/cancelled, tested head and CI/job link; distinguish testing from deployment                 |
| Independent review result               | Pass, requested changes, invalid artifact or provider hold, with evidence link                            |
| Merge/deployment lifecycle              | Protected merge, approval pending, approved/rejected, deploy started, verified/failed and exact release   |
| Stop, budget or credential hold         | Sanitized reason and operator action/link; no fabricated attempt refund                                   |

Observer `workflow_run` events cover allowlisted requested/in-progress/completed
run transitions. Trusted controller/worker lifecycle transitions supply per-phase
events that run-level signals cannot identify promptly. Deduplicate each event
using its producer run/attempt/phase/state; retry notification publication only
with a durable intent and reconciliation, never by rerunning a model.

Use trusted `GITHUB_TOKEN` job permissions `actions: read`, `contents: read` and
`issues: write` (plus pull requests write only where a PR comment is necessary).
The notification job receives no Claude token, GitHub App key, database password,
test account password or Render hook. It never executes source from a candidate
PR or interpolates untrusted text into a shell. Report typed results and links,
scan prepared bodies, and bound sizes. Comments cannot enqueue work or notify
the observer about itself. Notification failure must remain visible without
marking a repair/review successful or changing an existing approval.

Expect dozens of emails per day at the existing monitoring/pickup cadence, plus
CI and lifecycle events; overlapping native and journal emails are possible.
The owner requested that verbosity. Notification publication uses no AI budget
and does not automatically raise any hosting, GitHub or provider allowance.

### Silence and stale monitoring

On each valid wake/activity run, compare current time with the last verified
production-monitor completion. Proposed threshold: 90 minutes, an engineering
choice allowing cold-start/runtime delays. Report a distinct stale-monitor
warning; do not report a healthy app from old results. Repeated warnings for one
unchanged stale interval are deduplicated, but the later recovery is reported.

**A GitHub-only observer cannot send an immediate warning if GitHub delivers no
timer or event at all.** This option reduces dependence on cron for work that
already arrives as events; it does not guarantee periodic monitoring or detect
complete silence independently. No independent watchdog is added in this scope.

## Controls and rollout

Preserve Claude Pro OAuth-only execution, zero paid AI API fallback, usage-credit
setting off (owner-confirmed), all configured limits, counters, historical grants,
strict protection, genuine reviews, quarantine and named production approval.

Preparing/reviewing this design leaves the three live switches unchanged. At its
preparation snapshot all three are true. Do not stop or enable them merely to
write documentation. No event workflow, journal issue, dispatch or email
publication is installed or started by this design.

Proposed new opt-in controls default false: `FACTORY_EVENT_PICKUP_ENABLED` and
`FACTORY_ACTIVITY_LOG_ENABLED`. After an approved implementation PR and genuine
review, initialize the bounded wake/activity registries and journal in a
separately authorized rollout. Exercise previews first; verify personal email
settings and actual receipt of one harmless journal notification before enabling
full activity publication. Enable event pickup only after its scope is approved.
Existing cron stays as fallback throughout. Do not add factory-ready to the
harness design/review ticket.

## Acceptance and evidence

- Offline tests prove recognized owner/monitor/Dependabot events, actual actor
  provenance, main-only helper execution and rejection of forged/fork/stale data.
- A monitor issue created with GITHUB_TOKEN is picked up through monitor completion
  without depending on a suppressed issue event.
- Duplicate events, two receiver runs, uncertain dispatch, head changes, a busy
  lock, queued second ticket, empty completion and the 90-minute stale check have
  meaningful fail-closed tests. Existing reservations/counters are not reset.
- Event-origin coding/review/CI/merge proof remains valid end to end; missing or
  stale independent review still blocks merge. Stops block event admission and
  active interruption remains effective.
- Notification coverage includes healthy/idle checks and every requested lifecycle
  class. Bodies are scanned, linked to real producers and cannot leak secrets or
  create recursive wake/comment loops. Notification errors consume no model grant.
- Native notification account settings and owner-confirmed inbox delivery are
  recorded separately from a successful notification API response.
- Run appropriate factory suites, formatting, secret scanning and native CI.
  Obtain a separately authorized genuine Claude Pro review before protected merge.
- Live validation needs later authorization; no Claude session, paid AI API,
  external timer or live trial is part of design preparation.

## Remaining engineering decisions

The implementer may choose helper filenames, strict schema details, registry
capacity/retention that preserves unresolved identities, and whether phase events
post directly through a trusted notifier or enqueue typed records for the
observer. Choose the smaller surface that satisfies the invariants above and
document it in the implementation plan. Do not invent new production probes or
broaden accepted actors without the source-proof contract.

## Primary references

- [GitHub workflow events, scheduling and workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).
- [GITHUB_TOKEN event suppression and explicit dispatch](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
- [Actions email notifications](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications).
- [Watching, own-activity emails and mobile notifications](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications).
- Existing [operating guide](../../factory/OPERATIONS.md), [automation controller](../../../scripts/factory/automation.cjs),
  [dependency policy](../../../scripts/factory/dependency-policy.cjs) and [monitor](../../../scripts/factory/monitor.cjs).
