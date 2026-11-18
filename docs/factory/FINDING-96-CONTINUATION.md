# Finding context and the bounded #96 continuation

The handoff described here was consumed by run `44376807620`. It reached trusted
GREEN but failed final output scanning. Preserve that grant and receipt; do not
redispatch it. See [output recovery](FINDING-96-OUTPUT-RECOVERY.md) for the distinct
new preview-default operation prepared after that failure.

This implementation prepares a later owner-authorized trial. During preparation,
all four factory switches remain false and Factory event wake, Automatic factory,
Dependency maintenance, Proactive app discovery and Verified discovery finding
intake remain disabled. No Claude session or repair is started by this change.

## What failed and what changes

The [first retry](https://github.com/haideearus/cypress-realworld-app/actions/runs/44355891864)
successfully downloaded recovered evidence, proved fresh sandbox RED and prepared
the role. The complete prepared-context scan then reported two generic API-key
matches; the model step was skipped. Both matches are reproducible with only
the public proof digests in `origin.key` and `currentIntake.key`.

The model now receives an allowlisted description: issue and candidate/criteria
digests, original head/source/RED reference, oracle, and selected intake
head/outcome/evidence digest. Raw proof keys and machine-only producer contexts
remain in the ledger and trusted verifiers. They are not encoded, rewritten,
suppressed or copied to the model. Verification still happens before projection.
The original reproducer and trusted RED remain in the final context, and that
whole context still passes through the existing scanner before the model.
Real secrets in reproducer or feedback continue to fail closed.

## Separate append-only continuation

The original grant `4fbec36c-7e05-4d0e-b91f-a912b4d8c505`, retry grant
`33bce768-5170-4d31-80fb-1e19cef4b790`, original automatic/finding proofs and
first `findingRetry` receipt remain unchanged. A later authorized continuation
can append its own `findingContinuation` receipt, pinned to the second blocked
grant and the exact previous receipt. Its new parent, attempt 1, current-main
head, successful push CI and maintenance decision #100 are bound together.

The continuation consumes ordinary capacity: coding **2 → 3**, retries **1 → 2**;
review usage increases only if an independent review is actually reserved. The
existing daily admission stays in its historical day. No quota or allowance is
added, no history is deleted and no failed grant is promoted to success.

Both historical parents remain valid audit history; only the new parent may use
the new reservation. Later normal cycles/reviews remain in that parent and under
the existing limits. A repeated continuation, a rerun attempt, another ticket,
changed history/criteria, stale main, active/unfinished work, emergency stop,
exhausted limit, pending merge or existing publication branch is rejected.

## Later preview/run procedure, after review and merge

Use Automatic factory on `main`, operation **continue-finding**, ticket **96**,
and leave `wake_id` empty. Preview is checked by default. With all four switches
false, it checks the exact failed parent (RED/preparation successful, context
scan failed, Claude skipped), frozen criteria/provenance, limits, paused workflow
states and successful current-main push CI. Its controller result is
`finding-continuation-preview`, `continuationEligible: true`, `ready: false`,
`modelCalls: 0`. No usage or activity-store write is made by the preview.

Enable only Automatic factory temporarily to access its manual form, then pause
it again after the preview appears. Keep the other four workflows disabled.
The continuation selects #96 directly; it does not scan the queue or touch #97.

A live continuation needs a separate explicit owner authorization. Only then
temporarily enable `FACTORY_ENABLED` and `FACTORY_AUTOMATION_ENABLED`, keep
discovery and automerge false, select the same operation/ticket and uncheck
preview. Launch once and pause Automatic factory again. Fresh RED is rebuilt
on this continuation's tested main, rather than overlaying historical harness
commits. GREEN, secret scanning, app CI and independent review remain mandatory.
This operation cannot automatically merge or deploy.

After the entire run finishes, restore `FACTORY_ENABLED=false` first, then
`FACTORY_AUTOMATION_ENABLED=false`; retain the other two false switches and all
five paused workflows. Inspect the result before any further action. Do not
rerun either consumed historical handoff. Production deployment still needs
named human approval.

## Validation

The context tests run actual `worker.prepare` against a synthetic Git checkout,
the canonical public issue body and the unchanged scanner, with synthetic trusted
origin/RED fixtures. They are not live evidence or a real model invocation. They
reproduce the two legacy scanner matches, verify the projection leaves raw
proofs intact, and reject synthetic secrets in original test and feedback.
The continuation suite exercises real policy reservation and history validation,
preview, parent-job proof, limits/stop/locks and no-write/no-queue/#97 boundaries.
Run `yarn test:factory` for all model-free harness protections.
