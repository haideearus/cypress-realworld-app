# Isolated cloud monitor and Claude repair rehearsal

Status: proposed design, not installed or executed.
Implementation ticket: [#35](https://github.com/haideearus/cypress-realworld-app/issues/35).

## Purpose

Haide wants evidence that a monitor-created maintenance ticket can lead to a real
Claude Pro repair and observed recovery on GitHub-hosted runners while their PC
is off. They chose to include one actual coding session rather than a wholly
simulated repair. The deployed Render application must remain available.

One manual dispatch will run a bounded rehearsal against a deliberately broken,
temporary test service. A separate monitor registry and an explicit drill ticket
origin will prevent its evidence from authorizing production pickup, publication,
review approval, merging, or deployment.

## Approaches considered

1. **Synthetic observations only.** Smallest change and no model usage, but it
   does not meet the user's request for a real Claude repair.
2. **Exercise the ordinary coding/review cycle on a fixture committed to main.**
   Reuses more of the complete factory but leaves an intentional defect in main,
   creates a repair PR, and needs extra handling to prevent retries and merging.
3. **Temporary fixture commit, one existing Claude worker, isolated verification.**
   Recommended. It uses the real worker and shared usage ledger but publishes no
   repair PR. The broken fixture exists only on a drill branch. This requires a
   small dedicated coordinator and explicit drill restrictions in the ledger.

The user selected an isolated rehearsal with one Claude repair. The temporary
fixture architecture is the proposed implementation of that choice.

## Intended sequence

1. After installation and review, the owner opens **Monitor repair rehearsal** on
   `main`. Preview is the default and must make no GitHub mutations or model calls.
2. For the live rehearsal, automatic pickup and automatic merging are off. The
   factory model switch is on; production monitoring may stay on. The owner starts
   one live dispatch. No other ticket may hold the factory lock.
3. A preparation job validates the real workflow identity, the current limits,
   an empty active ledger slot, and available daily/coding allowance. It provides
   a 90-second window to shut down the PC before performing the rehearsal work.
   Revalidate mutable switches and available allowance after that window.
4. The job creates one `factory/drill-<run-id>` branch from the trusted workflow
   revision, containing a small broken HTTP response fixture and its regression
   test. Neither file is added to `main`. Record the actual seed commit SHA.
5. A GitHub-hosted job observes the isolated fixture failing. Reuse the real probe
   validation through a fixed loopback-only transport adapter. Preserve the exact
   baseline failure; do not simulate a production outage or call production with
   write requests.
6. Shared monitor incident-transition code publishes one `[DRILL]` issue and a
   durable receipt in `factory/monitor-drill`. A repeated failing observation must
   retain the same issue. The label is `factory-drill`, never `factory-ready`.
7. Reserve one honest coding grant for that issue in the normal factory ledger,
   with explicit `origin: drill`, the real workflow/run identity, and seed SHA.
   This counts as one daily ticket and one coding attempt. Invoke the existing
   `factory-model.yml` worker once with the existing subscription credential.
   For an authenticated drill-origin grant, the worker uses a dedicated prompt
   and narrower read/edit capabilities: no Bash, PowerShell, test execution, MCP,
   network tools or subagents. It explains that trusted jobs provide the measured
   RED/GREEN evidence and that Claude must not claim to have run those commands.
8. In a separate verification job, apply the collected bundle only to the fixed
   fixture implementation path. Preserve the seeded regression test and trusted
   oracle. Reject extra files, deletions, changed tests, links, binary content,
   oversized output, or a mismatched grant/base before executing the candidate.
9. A sandbox with no provider credentials, GitHub write credentials, or external
   network access checks the baseline and candidate against the same trusted
   expectations. Recovery requires the repaired fixture to pass its regression
   cases and real local HTTP health/readiness/frontend probes. Neither the model's
   prose nor a hand-written success file is recovery evidence.
10. A trusted finalization job records the verified recovery, closes only the
    matching drill issue, clears its active incident pointer, and releases the
    factory lock. Retain issue, commit, registry, grant, counters, and evidence.
    The branch is retained as evidence rather than deleted automatically.

## Credentials, limits, and isolation

- Only the existing `CLAUDE_CODE_OAUTH_TOKEN` reaches the model job. Existing
  forbidden-provider-environment checks remain in force. No API-key fallback,
  new billing setting, GitHub App private key, Render hook, or database secret.
- Exactly one coding invocation, zero model review invocations and zero automatic
  retries in the live rehearsal. A failure stops the attempt. The existing turn
  and job-duration limits still apply; no repository limits or counters are raised
  or reset. A rate limit or expired subscription token is a stop, not a reason to
  use another authentication method.
- A genuine independent Claude Pro review is still required for the installation
  PR. That is a separate subscription session from the one rehearsal coding call.
  No independent approval is claimed for the disposable repair: it is never
  submitted for merging or deployment.
- Exact owner, triggering owner, repository, `main`, workflow path/SHA and first
  run attempt checks. No scheduled trigger, arbitrary URL, source branch, command,
  model, fixture selection, or permission override in dispatch inputs.
- A drill ticket cannot be reclassified into a normal maintenance ticket, retried
  through `Factory agents`, independently reviewed, published to main, merged,
  or accepted by the production monitor provenance check. Adding `factory-ready`
  must not change this. Repeating the original run must not create another grant.
  Ordinary manual admission must reject the drill issue before reservation, even
  if it has no ledger entry yet; validate its drill label/receipt rather than
  relying only on the ledger origin.
- The source fixture is created only on a unique temporary branch. All trusted
  helpers are loaded from the reviewed workflow SHA. Generated code runs in a
  bounded disposable container with no external network and only the necessary
  fixture/oracle mounts. Production and local developer data are never mounted.
- Candidate service code and the trusted oracle run as separate processes with
  separate identities. The candidate uses a nonprivileged UID, a read-only
  filesystem, no capabilities and bounded CPU/memory/process/time resources.
  It cannot write the oracle or evidence, inspect or signal the oracle process,
  or share its JavaScript runtime. The oracle probes through loopback HTTP and
  treats candidate output/files/success claims as untrusted. Only the trusted
  host-side verifier writes the bounded finalization artifact. A feasible layout
  is a network-disabled container serving the candidate as UID 10001, with the
  fixed oracle executed separately as UID 0 inside that container; neither
  process has credentials, and evidence is written outside its mounts.
- Shared incident transitions accept already validated observations, but production
  keeps its exact workflow guard, fixed real probes and original registry. There
  is no synthetic mode in the production monitor.

## Durable completion and failure handling

Persist publication intent before the single issue POST. An ambiguous POST or
unacknowledged state update stops without a blind retry. Retain enough identifiers
for owner investigation; do not claim generic orphan recovery is solved.

The ledger must distinguish successful drill verification from normal production
review approval. Use a drill-only terminal state, with `pr: null`, `approval: null`,
one finished coding grant and no retry/review grants. Normal tickets cannot use
that state. The dedicated finalizer validates the exact run/grant/receipt and
measured verification result before writing it. Failed drills retain their real
failure outcome and consumed allowance.

Finalization must not release a reservation while its model job could still run.
For an interrupted workflow where finalization never runs, the owner uses the
existing **Factory agents → cancel** operation, which waits for a terminal run
before cleanup. This is manual cancellation recovery, not automatic stale-lock
recovery. Do not automatically close failed drill issues as successful.

## Evidence and PC-off check

The summary/artifact includes `synthetic: true`, trusted source SHA, seed SHA,
candidate bundle digest, actual workflow/run/attempt, hosted runner identity,
start/shutdown-window/observation/repair/finish timestamps, ticket and registry
links, grant ID, before/after counters, deduplication result, baseline failures,
candidate checks, and final incident/ledger status. No raw model transcript,
credential, environment dump or unbounded response content is published.

The owner notes their shutdown and return times. After returning, they compare
them with GitHub timestamps and confirm the coding and verification work happened
inside that interval. GitHub evidence establishes cloud execution; it cannot
independently attest that the physical PC was powered off.

## What passing establishes

It demonstrates a real monitor-created drill ticket, bounded Claude Pro coding,
measured isolated recovery, incident deduplication/cleanup, durable usage accounting
and cloud operation without the local checkout running.

It does **not** establish production automatic ticket admission, a production
outage repair, independent review or automatic merging of this disposable repair,
Render deployment, or automatic recovery from an interrupted workflow. Earlier
real maintenance runs provide separate evidence for coding/review/merge/deployment;
do not combine them into a claim that one complete production incident chain ran.

## Acceptance checks for the implementation PR

- Preview/disabled/untrusted-context paths create no issue, branch, reservation,
  model invocation, or recovery record.
- Real failed fixture yields an incident; repeat failure deduplicates; candidate
  failure stays unresolved; measured success records recovery and closes only its
  exact issue. Publication uncertainty never triggers another POST.
- One coding grant, zero retries/reviews, global cap/concurrency conservation,
  terminal cleanup, repeated dispatch/attempt protection and wrong-context denial.
- Production admission, publication, review gate and merger reject drill evidence
  even with misleading labels or fabricated approval fields.
- Verification rejects output outside the fixture allowlist and cannot execute
  candidate code with production/model/write credentials or external networking.
- Existing factory tests, focused new tests, formatting, lint, types and workflow
  validation pass; installation PR receives genuine independent review.

## Builder choices

The builder may choose module boundaries, exact fixture function names and a
digest-pinned lightweight Node container image. Keep the scenario small: a wrong
readiness response plus healthy health/frontend responses, with a regression that
checks the required readiness contract. Do not broaden worker command permissions
or add a second repair attempt to accommodate implementation difficulties.

A fresh builder review identified two material ambiguities, resolved here:
drill coding gets fewer tools than ordinary coding, and the verifier never shares
the candidate's process or writable evidence location. These are implementation
choices to preserve the stated isolation, not additional subscription usage.
