# Proactive discovery: execution foundation

This implements stage 3 of the [approved expansion](../superpowers/plans/2026-11-17-factory-expansion.md)
under owner harness issue #85. It does not enable discovery or publish bug tickets.

## What the new role does

`Proactive app discovery` inspects a successful, current-main push-CI revision.
New sweeps rotate among public-feed pagination, ordinary directory search, the
notifications list and the Settings profile. The selector prefers the least recently reserved eligible
charter, so each area can get a turn even when only one session runs per day.
The second reservation of a day excludes the charter already reserved that day,
including when `main` has moved.
The model can read a small set of relevant frontend files at the frozen revision,
choose input combinations for its assigned charter and inspect the test results.
The broker turns approved inputs into fixed API tests that run against one
synthetic session in a disposable app. The model cannot supply executable test
text or change the app, existing tests, configuration or dependencies. The
scheduled Safe functional discovery browser workflow continues to cover sign-in,
navigation and Settings separately.

The only model tools are a checksum-checked local stdio broker's six operations:
list/read charter source, submit a scenario, run a fixed batch, read a batch
result and write a structured report. There are no built-in file, shell,
network, general MCP, child-agent or publication tools. Only the single model
step receives the existing Claude Pro OAuth secret. There is no API-key input,
alternative provider, Cypress recording or paid service integration.

Packages and the Cypress binary are installed before model credentials exist.
The official Node base is pinned by manifest digest; application packages use
the existing frozen Yarn lockfile. The resulting local image ID is immutable.
Docker gets only an environment allowlist and an empty credential home.
The model and generated tests never receive live test-account, GitHub App,
Render, database, storage or provider credentials.

Each batch starts a fresh synthetic app and separate test container. They use
an internal bridge with an isolated gateway, read-only image roots, unprivileged
users, dropped capabilities, bounded resources and ephemeral writable scratch.
Test containers retain a 512-process/thread ceiling for Cypress and its Node
workers; app and oracle containers retain 256. All keep a three-gigabyte memory
ceiling and two-CPU quota. Unit caches use disposable `/work` scratch, keeping
installed packages read-only. Raw output is bounded and overflow holds the batch.
The plain JavaScript unit config uses Vite's native loader, avoiding temporary
configuration bundles beside read-only dependencies. Native CI measured 358
tasks during browser login, exceeding the former 256-task test ceiling.
The test container shares only its own disposable app container's network
namespace, preserving the unchanged browser/API localhost origins; it never
shares the host namespace.
Only the current proposal directory is mounted, read-only. There are no host
network, ports, Docker socket, production URLs or unrelated mounts. Unsupported
Docker isolation fails closed; generated tests never fall back to host execution.

The first runtime uses the app's existing JSON database in a disposable container
and synthetic session login. External identity providers, production PostgreSQL
and object storage are explicitly skipped coverage. This is neither a production
browser probe nor a claim that every page or backend path was tested.

## Budgets and retained state

- `FACTORY_DISCOVERY_ENABLED` is opt-in; absent/false disables model admission.
- Two discovery reservations per Europe/Bucharest day, sharing the existing
  twenty-ticket admission cap and configured execution capacity. Each source
  receives one `discover` grant, with zero coding/review attempts.
- Failed builds, provider rejection, invalid reports, interruption and failed
  replay retain consumed reservations. No automatic model retries or refunds.
- Replay and finalization wait for a confirmed GitHub API quota reset for up to
  65 minutes per job. Replay refreshes its state checks after a wait and keeps a
  five-minute execution budget per finding. Both jobs use the original evidence
  and grant. If finalization cannot write the ledger within that budget, the
  saved reservation remains available for owner reconciliation.
- Up to four exploration batches per session, each with a five-minute outer
  deadline; the existing turn/minute limits still bound the model step.
- Up to eight proposal files, two candidate findings and bounded text/log output.
  The separate replay job has no model credential and has its own runner timeout.
- The versioned `factory/discovery` registry retains at most 400 source intents
  and a one-megabyte registry. Reaching a bound requires owner maintenance;
  it never deletes receipts or resets budgets.

The usage ledger remains authoritative for daily admissions, discovery sessions,
grants and shared slots. The metadata registry retains source-issue creation
intents. Each successful source issue is an unlabelled audit record, never a
`factory-ready` defect. Intent precedes POST; an uncertain result is reconciled
against the exact bot-authored body, not resent speculatively.

Ready repairs and active work take priority over new sweeps. Successful main CI
and fallback UTC cron windows request discovery; the selector filters fallback
hours to 03:12/15:12 Bucharest, subject to GitHub delay. These are opportunities,
not promises of two runs or reliable timer delivery. The manual path uses the
same counters. Automatic paths additionally require automatic pickup enabled. The repository's pinned
Software Factory GitHub App may start a sweep after successful same-repository
main push CI. Manual dispatch and schedule continue to require the owner.
No cron receipt alone is an admission. Ordinary stop/quarantine controls apply.

## Reading the run summaries

Open **Proactive app discovery → Summary** for executed scenario coverage, what
was skipped, and what the replay verified. A report with zero findings describes
the scenarios executed in that run. The summary flags coverage as partial below
three distinct completed input cases. Claude is prompted to cover three cases
within the current charter and can execute up to four. Repeats, timeouts and
incomplete sandbox runs do not count toward the coverage target. Look in **Verified discovery finding intake →
Summary** for links to published issues and their current-main verification
results. **Safe functional discovery → Summary** reports the browser suite
separately, including sign-in, navigation, Settings and form assertions.

The limits stay at two Claude discovery reservations and four new finding ticket
intents per Bucharest day. A limit increases the number of opportunities. The
verified scenario and browser contracts determine the actual coverage.

## Candidate evidence and replay

Candidate reports preserve the exact source/grant identity, generated test text
and hash, executed scenarios, bounded raw RED logs, checked scenarios and
skipped coverage. The broker supplies ticket titles and summaries. A finding
must match its latest failing generated test, and the trusted replay checks the
same contract independently. A zero-finding report covers only the inputs tested.

A new credential-free job verifies the successful model step and retained
reservation, rebuilds the exact source/baseline and replays each proposed failure
twice against independent fresh data. It separately evaluates a fixed trusted
oracle twice in fresh sandboxes. Feed scenarios use positive page and page size
values from 1 to 25. Directory scenarios use short plain-text search terms and
check for server errors. The notifications charter uses one read-only
`GET /notifications` from the pinned synthetic account in every case. Its three
cases check the list response, the known seeded unread items, and the display
fields and supported types of returned items. Case selectors stay in the broker
and trusted verifier. The app receives the same path without query parameters.
The Settings charter uses a read-only `GET /checkAuth`. Its three cases check
the active profile identity, seeded fields displayed in Settings, and the saved
default transaction preference. Both the generated tests and the independent
verifiers confirm that sign-in identifies the seeded account before either read.

Notifications and Settings evidence record the case, HTTP status and the
verifier's boolean checks. They omit notification rows and profile field values.
The independent replay must observe the same contract failure twice before intake can
publish a ticket. An absent synthetic fixture or failed sign-in holds the
finding. A successful intake rechecks the finding on current `main` before
repair can start. The broker controls all request targets, methods and sessions.

Generated assertions, logs, screenshots and model opinions cannot establish
these oracles. Unsupported expectations, inconsistent failures, setup failures
and ambiguous behavior remain held/triage reports. A verified candidate is not
a repair, independent review or merge approval.

The [finding-intake stage](DISCOVERY-INTAKE.md) connects individually verified
functional evidence to deduplicated tickets, current-main replay and normal
repair intake. Older exploratory charters and their findings remain in history.
Intake has its own explicit metadata setup and requires discovery to be enabled.
Verified replay and the ordinary repair gates govern admission and merge.

## Later owner rollout

Do not execute these steps merely because this document exists.

1. Obtain native CI and a separately authorized genuine Claude Pro review of
   the implementation PR; merge through existing protection.
2. Keep the discovery flag absent/false. On `main`, open **Proactive app discovery**
   and select `initialize`, dry-run checked. This previews metadata setup without
   a model or write. Actual initialization is a separate authorized owner step.
3. After initialization, run `preview` with dry-run checked while discovery stays
   disabled. Confirm tested main, capacity and daily budget without enabling a
   timer or model. A durable stop is reported as a preview hold.
4. Only after a separately authorized trial, temporarily keep automatic pickup
   and merging off, explicitly enable discovery and the factory, and select `run`
   with dry-run unchecked. Enabling discovery with automatic pickup already on
   also permits later scheduled/current-main sweeps; it is a separate rollout.
   One audit source and one consumed grant cover one Claude Pro session.
5. Inspect both original and trusted replay evidence. Finding publication stays
   unavailable until the next implementation stage is accepted. When the entire
   trial finishes, save `FACTORY_DISCOVERY_ENABLED=false` before restoring any
   previous factory switches; do not leave recurring discovery enabled as a side
   effect of a one-session trial.

Do not increase live concurrency here. The existing stopped/idle owner migration
is still required before concurrency two. Emergency stop inventories the new
discovery parent and blocks new reservations; terminal cleanup keeps the consumed
grant and cannot release another ticket's active slot. Completion can wake one
pending repair through the existing guarded drain path. Journal observations
report preparation, actual model startup and completion without claiming approval.

## Verification

The trusted catalog includes `bank-account-isolation` (`/bankAccounts/:other`)
and `private-transaction-isolation` (`/transactions/:private`). Both require
`authenticated: true` and `query: {}`. IDs and expectations come from the
immutable synthetic seed, never model arguments. The first checks a nondeleted
bank account using its owner and another user. The second checks a private
transaction using both participants and an unrelated reader; it does not
change the public/contacts visibility contract.

Every identity must log in with a distinct session and pass `/checkAuth` before
and after its read. Legitimate users must read the exact fixture, including its
data fields, successfully before an unrelated reader's response counts.
Only a matching record disclosure is RED; a resource-free 401/403/404 with
successful legitimate controls is GREEN. GREEN accepts only error-only JSON
with `Unauthorized`, `Forbidden`, `Not Found` or `denied`, or exact canonical
plain text from the same list. Extra fields, alternate wrappers and unrecognized
denial bodies remain held. Wrong records, missing/deleted/nonprivate fixtures,
broken sessions, server errors and ambiguous payloads also stay held.
Typed observations retain synthetic IDs and control statuses, never cookies or
passwords. Two matching trusted replays are still required.
Each privacy finding requires its own proposal file; a shared failing suite
cannot establish an independent repair's GREEN while a sibling bug remains.

The two original privacy candidates from run 44179920739 remain historical
`unsupported-oracle` holds: their reports contain `oracle: null`. Adding catalog
support does not rewrite an original report or grant it retroactive provenance.
See [finding intake](DISCOVERY-INTAKE.md) for a later authorized supported source.

Offline policy, broker, worker-contract, replay and stop tests run under
`yarn test:factory`. Native Factory CI additionally executes a tiny Docker fixture
to check read-only source, environment filtering, internal app access and denied
public egress. It uses no model, live app or repository state writes. The local
Windows Docker daemon was unavailable during implementation. Native CI also
builds the actual application image and exercises a real API request, an
application unit import and browser login with no model.
Native results and live Claude discovery acceptance are separate evidence.

Current limitation: Cypress screenshots remain inside disposable scratch and are
not exposed through the broker. The model can inspect bounded textual test
results; screenshot inspection remains deferred. An uncertain source issue POST
is reconciled as a metadata-only run before any different charter is selected;
that reconciliation never creates a model grant.

References: [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports),
[Cypress binary installation](https://docs.cypress.io/app/references/advanced-installation),
[Docker isolated internal bridge](https://docs.docker.com/engine/network/port-publishing/#gateway-modes).
