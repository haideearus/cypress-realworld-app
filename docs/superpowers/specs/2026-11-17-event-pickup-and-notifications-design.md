# Event pickup, full activity notifications and proactive testing

Status: the owner approved the combined event/notification/proactive-testing
design on 17 November 2026, then selected the two-active-ticket extension below.
Implementation and live rollout have not started. The owner selected option 1
(GitHub events with cron fallback, no additional service or paid AI APIs), two
discovery sessions/day, up to four new bug tickets/day and two active tickets.

## Intent and observed problem

The owner wants maintenance to proceed with the PC off and wants emails about
new issues, checks, blocked work, coding, review, merging and deployment. They
also need a clear explanation of who finds problems and who repairs them.
The expanded request adds an AI tester that examines current code and actively
tries browser/API scenarios to discover failures before the owner reports them.

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

| Component                | Responsibility and implementation status                                                                   | Boundary                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Production monitor       | Health, readiness, frontend response, synthetic login/session/feed/logout and pagination contract          | Fixed API checks; not autonomous exploration of every page or discovery of every possible bug                                    |
| Dependabot               | Scheduled version proposals and native vulnerability/security update proposals                             | Updates are candidates; advisory/version checks, tests and review still apply                                                    |
| Owner                    | Describes other observed bugs and explicitly marks a bounded app ticket ready                              | Old unlabelled issues are not automatically coding instructions                                                                  |
| CI                       | Unit, API, browser and production regression tests when relevant workflows run                             | Not a continuously running exploratory tester; a failing candidate need not indicate a deployed incident                         |
| Proposed discovery agent | Claude Pro inspects source, creates exploratory tests and examines sandbox results                         | Not installed yet; cannot alter production or application implementation; suspected findings are not automatically verified bugs |
| Coding agent             | Investigates an admitted app ticket, preserves a failing regression, repairs and retests                   | Runs only under a durable grant, scope and limits; may hold provider/configuration failures rather than invent a code change     |
| Independent reviewer     | Reviews the final commit with fresh context; dependencies are read-only reviews                            | A check/notification cannot substitute for genuine review                                                                        |
| Controllers and merger   | Verify provenance, enforce budgets/locks, require current-head CI/review and perform protected publication | No model decides to bypass protection or refund counters                                                                         |
| Named owner              | Approves each production deployment and handles exceptional/destructive/spend decisions                    | Remains a human gate, usable from a phone                                                                                        |

The original change improves pickup and visibility. The new discovery role adds
bounded proactive code inspection and testing in a disposable app. It does not
replace the existing fixed production monitor, test every possible behavior,
continuously spend Pro allowance or explore the live payment demo with write
access. Production browser exploration and more live probes remain outside scope.

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

For the new testing role, the recommended design is **code inspection plus
browser/API tests against an isolated disposable copy**. Code-only review is
cheaper but cannot demonstrate runtime behavior. Exploratory writes against the
live app would mix synthetic experiments with persistent data and are excluded.
The sandbox choice is an engineering recommendation in this expanded design,
not a claim that the owner previously approved additional production access.

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
| Discovery finding publication completed                     | New allowlisted discovery producer and typed finding receipt; verified grant, immutable scan head, replay evidence, deduplication and live issue identity            |
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
daily/lifetime limits, stop checks or the approved shared ticket-capacity limit.

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

## Two active tickets with isolated execution

The owner selected a new ceiling of **two active tickets**, shared across app
repairs, dependency reviews, owner PR reviews and discovery sweeps. This means
two independently executing ticket workflows, not two open GitHub issues and
not an allowance to spawn extra model sessions inside one ticket. Code and review
for the same ticket remain sequential. All sessions share finite Claude Pro
allowance; concurrency does not increase the twenty-ticket daily budget.

The live controller currently accepts only one active ticket and stores one
`state.active` object. Do not raise its live variable before the change is merged
and migrated. Introduce a versioned usage-ledger active-ticket map keyed by ticket,
with one producer run/attempt per active entry. Atomic compare-and-swap admission
must count entries across every lane and reject a third ticket. A ticket cannot
hold two active entries, and a completion/cancellation may release only its own
entry. Readers must support retained v1 history; do not confuse usage-ledger
entries with the monitor registry's independent active-incident field.

Every ticket gets its own GitHub-hosted workspace, scratch output, synthetic data
and disposable services. Metadata writes still serialize under `factory-ledger`.
Whole-workflow lane concurrency must no longer serialize all worker execution;
the authoritative two-ticket admission map supplies the limit instead. Keep one
global protected-merge writer and one production-deployment writer. A pending or
ambiguous merge retains its own intent/ownership and cannot be replaced by
another ticket. A changed main/head invalidates affected premerge evidence and
may require refreshed CI/review under existing counters; parallel work does not
permit reusing approval for a different commit.

Automatic/dependency tickets keep a slot while executing their code/test/review/
merge lifecycle. A terminal blocked/cancelled parent releases its slot only
after reserved sessions are safely reconciled. Owner-review completion releases
its execution slot at the human merge handoff. A completed discovery sweep can
release its execution slot while separately held publication metadata waits;
publication does not retain a model slot. There is no hidden free model lane.

The emergency stop must enumerate, interrupt and reconcile both active parents
and all reservations, preserving the existing one-minute target and exact stale-
run quarantine. One ticket's cleanup cannot clear another's live grant. A failed
or partial stop keeps its durable marker and reports unresolved runs explicitly.

Implement dual-version readers before an explicit, previewable owner migration.
The migration requires all three switches false, a durable stop, no active parents
or reserved grants, and a matching expected ledger commit. Preserve ticket,
grant, day, approval and audit history, append a migration receipt, and retain the
old commit. Only then set `FACTORY_MAX_CONCURRENT_TICKETS=2` and separately resume
the authorized operating profile. Preparing this design/plan changes none of
those live settings. Raising the ceiling to three is not included.

## Proactive code inspection and exploratory testing

### Purpose and daily workflow

Add a distinct Claude Pro **discovery** role. It examines the current tested main
commit, reads relevant source and existing tests, proposes additional scenarios,
runs them through a trusted sandbox executor, and inspects the results. It seeks
new reproducible failures rather than repairing its own findings in the same
session. Discovery, coding and independent review remain separate roles.

Start with rotating test charters: authentication/session boundaries; transaction
feed/pagination; profile/form validation; and synthetic account/contact/payment
journeys. Cover ordinary use and boundary cases such as empty, malformed or
out-of-range input. Use the existing Vitest, API and Cypress tools; browser
exploration is expressed as executable Cypress scenarios, with sandbox-only
screenshots/results available for the agent to inspect. No additional paid
Cypress AI feature, recording subscription or alternative LLM is needed.

The owner selected **at most two discovery sessions and four newly published bug
tickets per Europe/Bucharest day**. Each session can propose/publish at most two
new findings. A successful new-main push CI event can request a sweep; a twice
daily cron is fallback. Proposed fallback times are 03:12 and 15:12 Bucharest,
an engineering scheduling choice subject to GitHub delivery. Deduplicate the
same head/charter/day, and rotate charters so a second sweep of unchanged source
examines a different area. An owner-requested run uses the same daily counters.
Two sessions is a ceiling, not a promise to spend two sessions every day.

Require a current-main successful CI receipt, discovery opt-in, existing master
and automation switches enabled, no durable stop, available shared capacity and budget
before reservation. Defer behind existing eligible repairs and pending merges;
never preempt a running repair to meet a discovery cadence. No changed main or
test environment is silently substituted after reservation. No source workflow
event or missed timer grants free additional discovery attempts.

### Isolated app and restricted tools

Build a fresh disposable copy of the exact scan SHA in a GitHub-hosted runner.
Use synthetic seed data and a local disposable database; PostgreSQL tests retain
the `_test` name requirement. Local JSON/Cypress reseeding may affect only this
copy. Never reuse the operator checkout's ignored environment files, production
database, live test-account secrets, storage credentials or authentication-provider
secrets. External auth providers are mocked or marked out of coverage.

Application implementation, dependencies, configuration, factory code, instructions
and existing tests are immutable to the model. The agent may read relevant source
and write new test proposals and a structured report only in its output area.
It cannot delete tests, change assertions to conceal an existing failure, patch
the application, commit, push, publish a ticket, approve, merge or deploy.

The model may invoke only a checksum-pinned trusted test helper with a bounded
request-file contract. No arbitrary shell, unrestricted browser/MCP tools or
direct network tools are added. The helper chooses fixed unit/API/Cypress command
templates and accepts only validated test artifacts/spec identifiers; test text
is never interpolated into a shell. The model can inspect resulting sanitized
logs, screenshots and traces and refine its proposals within the same session.

Execute generated tests and the disposable app in an isolated internal container
network with no public egress, host networking, privileged containers, Docker
socket, owner credentials or unrelated host mounts. The trusted controller owns
container creation. Model credentials stay outside test containers; child
environments are allowlisted. Tests get only sandbox endpoints and synthetic
credentials, and filesystem mounts separate immutable source from writable
scratch output. Package/browser installation and baseline setup happen before
model credentials are available. Missing isolation must hold discovery, not fall
back to live app testing or host execution with inherited secrets.

Proposed per-session test budget: up to four exploration batches, each bounded
to five minutes, inside the existing 30-minute/200-turn model ceiling. A batch
may run selected new cases rather than the entire suite. Trusted baseline and
final replay jobs have separate bounded runner timeouts and no model token.
Record cases actually executed and coverage skipped when time expires; a timeout
or exhausted Pro allowance is not evidence of an application bug.

### Metering and stop behavior

Do not reuse an owner repair issue or add free model calls outside the ledger.
For each sweep, a trusted metadata controller creates at most one uniquely
receipted discovery-work issue (never factory-ready), then admits it as a new
`discovery-sweep` source under the **existing 20-ticket daily admission cap**.
Reserve one new `discover` phase grant on that source; preserve actual producer
identity and a strict new origin/schema. Existing code/review roles retain their
current scope. The sweep issue is a budget/audit record, not an app defect.

The discovery grant consumes one of the shared two-ticket execution slots and one of
the two daily discovery sessions, in the reservation's Bucharest day bucket.
Interruptions, invalid output, provider rejection and failures consume that
attempt; no automatic model retry, refunded reservation or replacement sweep
issue bypass is permitted. Metadata publication intents precede non-idempotent
issue creation; ambiguous creation is reconciled before any repeat attempt.

Up to four accepted finding issues may be published per Bucharest day, with at
most two per source sweep. Publication has its own durable daily counter and
intent, independent of GitHub API retries. Later admission of each finding to
coding consumes its own ticket under the same 20-ticket cap. Thus two sweeps and
four admitted repairs use up to **six** daily tickets; they are not six extra
tickets above twenty. When the global cap is exhausted, discovery/repair waits.
Finding creation alone does not authorize a model or reserve a repair attempt.

Extend the existing emergency-stop inventory to include discovery parent and
model runs. Stop must block reservation, interrupt an active discovery session,
preserve its consumed grant and block new finding-publication intents while
active. Recheck stop immediately before publication. A GitHub issue request
already accepted before the stop may still finish; retain/reconcile that receipt
and forbid repair admission while stopped rather than repeat or erase the write.
Notification and metadata-only audit reporting may explain the interruption
without invoking another model. Preserve the existing narrow stale-run quarantine
unchanged.

Publication records distinguish verified, held-for-stop, held-for-quota,
publishing-intent, published, duplicate, rejected and observed-resolved states.
Pending verified findings can be reconsidered after resume or the next daily
budget window using current-head replay and artifact availability checks, with
no new discovery session or refunded old grant. Their actual publication day
uses the current four-ticket publication cap. Interrupted/noncompleted discovery
grants cannot publish findings on resume; uncertain writes retain their intents.
An expired artifact or failed current-head replay becomes a visible hold/rejection,
not an invisible reset or automatic request for another paid/subscription model.

### Evidence before a repair ticket

The discovery model cannot directly add factory-ready. A trusted collection and
validation job must verify all of the following before automatic publication:

1. A real finished Claude-subscription discovery grant and allowlisted workflow
   run/attempt cover the exact source SHA; output is not a fixture.
2. Only allowed new test artifacts/report files exist, are regular bounded files,
   pass secret scanning and identify their commands/specs, inputs and assumptions.
   Application/configuration/lockfile hashes match the unmodified scan snapshot.
3. A fresh sandbox replay reproduces the same failure twice after independent
   data resets on that unmodified application. Preserve the original RED command,
   output, test patch and exact SHA; do not manufacture a fix to demonstrate GREEN.
4. The failure has an observable app symptom and a justified oracle: an existing
   documented contract, demonstrated invariant, unhandled app exception, invalid
   successful response, or synthetic-account isolation failure. A failing test
   based on an invented expectation is insufficient.
5. Classify environment/startup/dependency-download issues, flaky timing,
   unsupported external-provider flows and ambiguous desired behavior separately.
   Speculative code concerns and uncertain assertions remain report findings for
   owner triage, without automatic repair admission.
6. Search open issues, existing receipts and relevant tests for the same bug.
   Use a normalized symptom/route-or-component/contract fingerprint across SHAs,
   not the SHA alone. Update an existing issue's evidence in comments instead of
   creating another ticket or editing frozen accepted criteria. Retain resolved
   fingerprints so a proven recurrence can be distinguished from a duplicate.

The public ticket includes the symptom, affected feature, exact reproduction,
scan SHA, expected/actual behavior, sanitized evidence link and proposed scope.
Use synthetic data; never publish credentials, real personal data or raw secrets.
A zero-finding sweep is a valid result, reported as checked scope and limitations,
not proof that the application contains no bugs.

### Route findings into the existing repair pipeline

Add a dedicated discovery receipt verifier alongside `verifyMonitorIssue`.
The bot author or label alone does not establish provenance. Verify producer,
discovery grant, source ticket, finding identity/hash, test replay, publication
receipt and current issue fields. Only that verified machine-origin ticket can
enter normal coding; arbitrary bot text cannot acquire the same privileges.

Because source can change between discovery and repair, intake must replay the
retained reproducer on current tested main before reserving a coding grant.
Keep original discovery evidence immutable and record a separate current-head
replay receipt. If the failure is already gone, retire the candidate as observed
resolved with evidence, without claiming this factory repaired it. If it still
fails, bind the new repair to that current head. A broken reproducer or uncertain
oracle is held. Bound repeated intake replays per finding/head/day so changes do
not produce an uncontrolled test loop; no further discovery model is required.

The coder receives the verified reproducer, proves RED before its fix, implements
the smallest app change and proves GREEN. Existing full CI, fresh independent
review, protected merge, named production approval and post-deploy checks remain
mandatory. A discovery report is never a passing review. Closure says only what
was verified: a sandbox-discovered defect need not have been exercised in the
live monitor's narrower production checks.

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

| Event                                       | Information reported                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue created, changed or closed            | Number/link, source, lifecycle action and eligibility; no arbitrary full body                                                                 |
| Monitor check completed                     | Time, healthy/unhealthy, individual check results, release, retries and run link; include healthy checks                                      |
| Automatic/dependency queue checked          | Eligible candidate, empty queue, busy lock or exact hold reason; include idle checks                                                          |
| Coding/review phase started or finished     | Ticket, phase, actual run/job/head, outcome and consumed allowance; no prompts or credential-bearing logs                                     |
| Discovery started/completed or held         | Sweep ticket, source SHA, charter, actual tests/areas checked, reproducible findings, no-findings/uncertain results and daily discovery usage |
| Discovery finding published or deduplicated | Bug/previous issue link, verified reproduction receipt and intake/triage status; no invented confirmed repair                                 |
| CI/build/tests completed                    | Passed/failed/cancelled, tested head and CI/job link; distinguish testing from deployment                                                     |
| Independent review result                   | Pass, requested changes, invalid artifact or provider hold, with evidence link                                                                |
| Merge/deployment lifecycle                  | Protected merge, approval pending, approved/rejected, deploy started, verified/failed and exact release                                       |
| Stop, budget or credential hold             | Sanitized reason and operator action/link; no fabricated attempt refund                                                                       |

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
setting off (owner-confirmed), other configured limits, counters, historical grants,
strict protection, genuine reviews, quarantine and named production approval.
The sole approved existing-limit change is one to two active tickets, after the
guarded controller migration above; it is not applied by this document.

Preparing/reviewing this design leaves the three live switches unchanged. At its
preparation snapshot all three are true. Do not stop or enable them merely to
write documentation. No event workflow, journal issue, dispatch or email
publication is installed or started by this design.

Proposed new opt-in controls default false: `FACTORY_EVENT_PICKUP_ENABLED` and
`FACTORY_ACTIVITY_LOG_ENABLED`, plus `FACTORY_DISCOVERY_ENABLED` for the new model
role. Proposed discovery ceilings are two sessions/day and four new findings/day,
with two findings per session and four exploration batches per session; validate
these in trusted policy, not only an editable repository variable. They do not
increase existing repair caps. After an approved implementation PR and genuine
review, initialize the bounded wake/activity registries and journal in a
separately authorized rollout. Exercise previews first; verify personal email
settings and actual receipt of one harmless journal notification before enabling
full activity publication. Enable event pickup only after its scope is approved.
Existing cron stays as fallback throughout. Do not add factory-ready to the
harness design/review ticket.

Implement this as one approved overall design with separable rollout stages:
first active-ticket isolation/migration, then event pickup/activity publication,
then the discovery sandbox/metering and verified finding-to-repair intake.
Focused implementation PRs are needed because these change distinct admission,
grant-schema, tool-capability and stop boundaries.
That separation does not authorize repeated model reviews or live trials. Each
required fresh Claude Pro review and first live discovery run needs its later
owner authorization; no discovery switch is enabled by approving a document.

## Acceptance and evidence

- Offline tests prove recognized owner/monitor/Dependabot events, actual actor
  provenance, main-only helper execution and rejection of forged/fork/stale data.
- Two-ticket admission races cannot create a third slot or duplicate one ticket;
  completion, cancellation and stop cannot clear a different ticket's grant.
  Prove two isolated workers can run while merge/deployment publication remains
  serialized. Migration refuses active work and preserves old grants/counters/
  approval receipts; monitor active-incident semantics remain unchanged.
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
- Discovery tests prove two-session/four-publication daily caps, the shared global
  budget and lock, the new origin/phase, duplicate/ambiguous publication handling,
  test-only writes and isolation. Attempts to reach production, inherit model
  credentials, weaken tests or label an unverified finding must fail closed.
- Use a seeded defect in a disposable fixture for offline/live acceptance:
  discover a genuinely failing test, retain raw RED proof, deduplicate a second
  observation, publish a proven finding, run the separate repair/review path and
  verify correction. Keep fixture results distinct from real app discoveries.
  Invalid-oracle, flaky, zero-finding, stale-head replay, quota and interruption
  cases need meaningful tests. No fixture can satisfy a production review gate.
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
Discovery runner implementation may choose pinned container images and batch
interfaces, provided it enforces the credential/network/filesystem boundaries,
test-only output and metering contract. The proposed daily fallback times and
four-batch/five-minute sublimits are engineering choices for owner review.

## Primary references

- [GitHub workflow events, scheduling and workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).
- [GITHUB_TOKEN event suppression and explicit dispatch](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
- [Actions email notifications](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications).
- [Watching, own-activity emails and mobile notifications](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications).
- [Docker internal-network isolation](https://docs.docker.com/reference/cli/docker/network/create/#internal).
- [Cypress command line](https://docs.cypress.io/app/references/command-line).
- Existing [operating guide](../../factory/OPERATIONS.md), [automation controller](../../../scripts/factory/automation.cjs),
  [dependency policy](../../../scripts/factory/dependency-policy.cjs) and [monitor](../../../scripts/factory/monitor.cjs).
