# Proactive discovery: execution foundation

This implements stage 3 of the [approved expansion](../superpowers/plans/2026-11-17-factory-expansion.md)
under owner harness issue #85. It does not enable discovery or publish bug tickets.

## What the new role does

`Proactive app discovery` inspects a successful, current-main push-CI revision.
It rotates session/authentication, feed/pagination, profile/form and synthetic
journey charters. A separately enabled discovery session can read the frozen
source, propose new Vitest/API/Cypress tests and inspect bounded test results.
The model cannot edit the app, existing tests, configuration or dependencies.

The only model tools are a checksum-checked local stdio broker's six operations:
list/read manifest source, write a new test, run a fixed batch, read a batch
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
same counters. Automatic paths additionally require automatic pickup enabled.
No cron receipt alone is an admission. Ordinary stop/quarantine controls apply.

## Candidate evidence and replay

Candidate reports preserve the exact source/grant identity, original test text
and hash, executed commands/modes, bounded raw RED logs, checked scenarios and
skipped coverage. Reported coverage is model-authored; actual batch receipts are
reported separately. A zero-finding report does not claim exhaustive testing.

A new credential-free job verifies the successful model step and retained
reservation, rebuilds the exact source/baseline and replays each proposed failure
twice against independent fresh data. It separately evaluates a fixed trusted
oracle twice in fresh sandboxes. Initial oracles cover unexpected server errors,
unauthenticated protected-route access, the existing feed pagination contract
and access to another synthetic user's owner-only endpoint. Requests accept only
fixed routes and bounded query fields. They cannot specify commands or URLs.

Generated assertions, logs, screenshots and model opinions cannot establish
these oracles. Unsupported expectations, inconsistent failures, setup failures
and ambiguous behavior remain held/triage reports. A verified candidate is not
a repair, independent review or merge approval.

The next finding-intake stage will add deduplication, current-main replay,
publication limits (four new bug tickets/day) and normal repair intake. This PR
creates no finding issues, adds no ready labels and approves/merges nothing.

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
   unavailable until the next implementation stage is accepted.

Do not increase live concurrency here. The existing stopped/idle owner migration
is still required before concurrency two. Emergency stop inventories the new
discovery parent and blocks new reservations; terminal cleanup keeps the consumed
grant and cannot release another ticket's active slot. Completion can wake one
pending repair through the existing guarded drain path. Journal observations
report preparation, actual model startup and completion without claiming approval.

## Verification

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
