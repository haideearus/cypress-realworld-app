# Owner acknowledgment of a recovered monitor incident

Status: approved by the owner on 16 November 2026, Europe/Bucharest. The owner
subsequently authorized an implementation PR. Closing issue #65, changing switches,
starting Claude and executing the live operation remain separately authorized steps.

## Problem and evidence

Production monitor run [43821909542](https://github.com/haideearus/cypress-realworld-app/actions/runs/43821909542)
created [issue #65](https://github.com/haideearus/cypress-realworld-app/issues/65)
after its sign-in journey failed. Its public health, readiness and frontend checks
passed. The original incident is
`4b38a9aa-7089-4532-bc39-500021016116`, with workflow source
`ad0022b614c5b4b6446ed80606657a7594d3a99e`.

Later preview [43824706341](https://github.com/haideearus/cypress-realworld-app/actions/runs/43824706341)
passed login, session, normal feed and logout on that same deployed release. Its
separate pagination check failed. This shows the earlier sign-in failure was not
reproduced in the later observation; it does not establish its root cause or an
AI repair. The pagination failure is a different, still-unrepaired defect.

The current registry permits one active incident. PR #64 deliberately requires
reviewed, merged, deployed repair evidence before automatic retirement. It has no
owner acknowledgment path for an incident that recovered without an admitted
coding task. Closing #65 manually would leave that active record in place.

The read-only baseline is
`outputs/acceptance-incident-baseline-2026-11-16.json` outside the repository. It
records all three agent switches false, the durable stop active, no reserved
grants, no ledger entry for #65, and the original monitor receipt. These are
observations from preparation, not substitutes for checks at execution time.

## Approaches and chosen scope

| Approach                                              | Consequence                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Keep repair-only closure for every incident           | Preserves the current guard but blocks a recovered, unadmitted incident indefinitely.            |
| Automatically clear any apparently recovered incident | Loses the deliberate owner decision and can confuse spontaneous recovery with a verified repair. |
| Add a restricted owner acknowledgment                 | Preserves repair verification while recording a distinct, explicit operational decision.         |

The owner authorized designing the third approach. A separate manual workflow is
the proposed delivery choice. It keeps schedules and the existing monitor's
credential/context checks intact. It is a bounded exception for standard incidents
that have never entered the AI ledger, not a replacement for repair verification.

## Operator experience

Add **Acknowledge recovered monitor incident**, proposed file
`.github/workflows/factory-monitor-acknowledge.yml`. It has no schedule or PR
trigger. Its two inputs are an exact issue number and a preview checkbox, checked
by default. Unchecking preview is the explicit owner decision to acknowledge
observed recovery with no code-repair claim. The recorded reason is a fixed enum,
`observed-recovered-no-code-repair`; no arbitrary explanation, URL or command is
executed or copied into public output.

The preview performs the same eligibility and fresh health checks but makes no
issue, registry, ledger or variable write. Its summary states the selected issue,
incident, evidence, proposed close reason and any reason the action is held.

The live action closes only that incident's issue as `closed/not_planned`, records
the owner's acknowledgment, and clears the matching active pointer after closure
is confirmed. Its summary says **owner acknowledged observed recovery; no AI code
repair or deployment credited**. The root cause remains unproven unless separate
evidence establishes it. It makes no claim that the pagination check passed.

Issue title, body, comments and labels remain unchanged. The GitHub issue history,
monitor receipt, workflow summary and durable acknowledgment provide the audit
trail. No extra issue comment or its non-idempotent POST is needed.

## Eligibility and authority

Execution must enforce all of the following:

- Exact repository, owner actor and triggering actor `haideearus`, `main`, trusted
  workflow source and first workflow attempt. A new manual dispatch is required
  for a retry; GitHub's Re-run button is refused.
- The trusted workflow configuration supplies all three agent switches as false.
  Recheck the durable stop and idle ledger before every mutation. This operation
  never changes variables or removes the stop. An owner must not concurrently
  change the switches; the operation does not gain variable-administration access.
- The issue uniquely matches the active production receipt, its bot author,
  original criteria hash and successful first-attempt monitor publisher. Reuse
  the existing receipt verifier, while explicitly checking the active pointer;
  a recovered flag alone must not make the receipt unverifiable for this path.
- It is a standard incident: no `probeMode: feed-contract`, repair-retirement
  intent, existing completed acknowledgment, or isolated drill record.
- The issue has never appeared in the AI ledger. Refuse any historical entry,
  coding/review grant or admitted task for it, even if the work is now terminal.
  Also require no active ticket or reserved grant anywhere in the ledger.
- The pagination-contract repository flag remains absent/false for this operation.
  Do not disable it automatically. This prevents acknowledgment from suppressing
  a contract incident or substituting a reduced check for an enabled one.

Use the same workflow concurrency group as Production monitor and the same
`factory-ledger` job concurrency group as admission. This serializes normal
publication/retirement and acknowledgment with control jobs. Re-read identity,
criteria, active pointer and ledger before each write; do not rely on a stale
snapshot or use a force update.

## Fresh evidence and credential boundaries

The acknowledgment workflow produces a separate bounded report. It does not relax
or relabel the existing version-one/version-two app-check report formats.

Require fresh public health, readiness and frontend checks, and the complete
standard synthetic login, session, normal five-item feed and logout journey. All
must pass. Public release observations must bracket the signed-in journey, match
each other, and match the later public availability observation. A missing or
changed release, skipped check, timeout, invalid response or authentication failure
holds acknowledgment. The whole report is bound to this workflow run, attempt,
source SHA, fixed host and timestamp, with the existing ten-minute maximum age.
The earlier preview is context only; it cannot authorize a later closure.

A dedicated acknowledgment checker can reuse the pure probe functions without
broadening `assertMonitorContext` or making ordinary reports interchangeable with
acknowledgment evidence. Its scope is explicitly `standard-only`; it does not send
the pagination-contract request or report `feedContract: ok`.

Only the checker receives the two existing synthetic account secrets. The
publisher receives the GitHub token and a validated, credential-free report, never
account credentials, cookies, raw responses or exception text. Retain a report
secret-scan boundary without weakening the ordinary report validator. The new
workflow needs only contents/issues write and Actions read, with checkout
credentials disabled. It receives no Claude OAuth, AI API key, GitHub App key,
Render deploy hook, database credential or administration permission.

Use the existing standard GitHub-hosted Linux runner and pinned actions. Add no
service, paid runner, package dependency or model budget for this operation.

Retain an eight-minute job. A proposed bounded checker uses at most seven
six-second request windows per round, three rounds and the existing bounded
pauses: `3 * 7 * 6 + 2 * 31 = 188` seconds. Availability retains 152 seconds,
scanning 30 and metadata/publication 60, leaving 50 seconds for setup. Share one
metadata/publication deadline across its calls. Ordinary monitor timeouts, model
limits and all billing settings remain unchanged.

## Durable transition and failure handling

Add a distinct optional `acknowledgment` record to the production monitor schema.
Keep the outer schema and existing receipts compatible; existing `retirement`
continues to mean verified code-repair retirement. The two records are mutually
exclusive. An acknowledgment includes a bounded operation ID, owner, fixed reason,
target issue/incident, original criteria/source identity, initial intent run/time,
and final verification run/time, source and stable release.

The state transition is:

1. Verify eligibility and fresh checks; persist acknowledgment **intent** before
   changing the issue. Keep the active pointer and every original receipt field.
2. Revalidate the target and stopped/idle state. Close that exact issue as
   `not_planned`, or reconcile an already closed/not-planned issue only when the
   matching durable intent exists. A pre-existing manual closure without intent
   is not enough to complete this operation.
3. Read back and confirm closure and unchanged identity. Revalidate state, then
   persist acknowledgment **complete**, mark the historical incident recovered
   and clear only its active pointer in one compare-and-set registry update.

While acknowledgment intent exists, normal monitor ticks report an owner-recovery
hold; they must not run repair retirement, overwrite that intent, clear it or
create a second incident. On an ambiguous issue/registry response, retain intent
and the active pointer. A later explicit owner run must use fresh checks and
reconcile the same operation; preserve the initial intent and link final evidence.
If conditions changed, hold rather than pretending the operation succeeded.

A repeat against an already completed acknowledgment is read-only and must never
clear a newer incident. Retain all Git history and receipts, including the issue's
original day. Never delete or reinitialize `factory/monitor`, `factory/state`, or
the drill registry. Do not mutate the AI ledger, counters, grants, stop marker or
quarantine records. Repair verification must explicitly reject acknowledgment as
repair evidence. Closed acknowledged issues cannot become fresh AI work through
the automatic pickup path.

## Limits, scope and planned verification

Keep the existing two monitor creations per UTC day and 180-record bound. Closing
#65 does not refund its publication. If no other incident consumes the remaining
slot, a later pagination incident can use the second publication on 16 November.
The separate AI limit remains 20 tickets per Bucharest day; no allowances reset.

Implementation should cover the real #65 shape with simulated transport and
failure-first regressions: default preview makes zero writes; owner/main/attempt
binding; wrong or edited issue/receipt; admitted or reserved work; absent stop;
switch/config refusal; contract/drill substitution; stale, skipped, failed or
mixed-release checks; intent-before-close ordering; lost issue/final registry
responses; idempotent completion; newer active incident preservation; bounds and
credential scanning; and unchanged counters, existing repair gates and legacy
monitor/drill behavior. Run the relevant factory and workflow checks. Preparation
uses disposable/simulated fixtures, not production mutation or a model call.

## Later rollout, separately authorized

1. Approve this design. Prepare a dedicated harness ticket and implementation PR,
   keeping the switches false. Preserve CI and the genuine independent-review
   requirement; any later Claude Pro review needs its own authorization.
2. After protected merge and successful main CI, preview acknowledgment of #65
   with all switches false and the durable stop active. No incident is closed.
3. With explicit execution authorization, acknowledge #65 only if fresh checks
   satisfy every guard. Inspect the retained receipt and completed acknowledgment.
4. Then, in a separate monitor-publication step, enable the pagination-contract
   flag and obtain its own genuine issue and receipt while agents remain off.
   Normal scheduling can create the incident as soon as the flag is enabled.
   If a different incident or quota intervenes, reassess; do not edit old criteria
   or reset history. Preserve that flag for later matching recovery checks.
5. A later PC-off coding/review/merge trial and named human Render approval remain
   separate. Acknowledgment of #65 cannot count as that acceptance evidence.

This document adds no implementation, secret, workflow run, variable change,
issue mutation, deployment or paid API usage. The implementation and execution
steps above are proposed future work, not actions performed during design.
