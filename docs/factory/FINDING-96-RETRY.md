# Recovered evidence and the bounded issue #96 retry

The retry described below was consumed by run `44355891864`: recovery download
and RED passed, then prepared-context scanning blocked it before Claude. Keep
that grant/receipt intact. The separately approved preparation for a later
[bounded continuation](FINDING-96-CONTINUATION.md) addresses that context failure;
do not redispatch the consumed `retry-finding` operation.

Preparation of this fix does not authorize execution. Keep `FACTORY_ENABLED`,
`FACTORY_AUTOMATION_ENABLED`, `FACTORY_AUTOMERGE_ENABLED` and
`FACTORY_DISCOVERY_ENABLED` false. Keep Factory event wake, Automatic factory,
Dependency maintenance, Proactive app discovery and Verified discovery finding
intake paused until the owner explicitly authorizes a later trial.

## Failure and evidence

[Run 44338765984](https://github.com/haideearus/cypress-realworld-app/actions/runs/44338765984)
admitted #96, then failed downloading its evidence before the model step. The
evidence resolver used original discovery run `44197159640` with a recovery
artifact name. That artifact belongs to recovery run `44326359550`.

The resolver now uses the candidate's validated artifact producer. The original
discovery proof stays separate. Existing origin verification still checks the
original subscription grant, durable recovery receipt, successful replay and
confirmation jobs, artifact ID/digest, expiry and producing head. Downloaded
content must still reconstruct the exact candidate before trusted RED replay.

## One owner-controlled retry, after this fix is merged and authorized

Use **Automatic factory** on `main`, operation **retry-finding**, ticket **96**.
Leave `wake_id` empty. Preview remains checked by default; it performs GET-only
validation and creates no persistent reservation or model session. A valid
preview reports `finding-retry-preview`, `retryEligible: true`, `ready: false`,
and `modelCalls: 0` even while the main switches are false.

Both preview and execution require the other four pickup/discovery/intake
workflows listed above to remain disabled. The operation never scans the queue,
publishes discoveries, or updates the finding registry. Discovery and automatic
merging must be false. #97 is not selected, relabelled, reverified or repaired.

Live execution additionally requires `FACTORY_ENABLED=true` and
`FACTORY_AUTOMATION_ENABLED=true`, a fresh explicit owner dispatch with preview
unchecked, no wake receipt, no active ticket, no durable stop and available
normal coding/retry capacity. Pause Automatic factory again once the manual
run exists. Do not re-enable other pickup workflows while it runs.

The exact original grant `4fbec36c-7e05-4d0e-b91f-a912b4d8c505` remains finished
and blocked. The controller verifies the original failed parent and its actual
artifact-download failure, with the Claude step skipped. It rejects rerun
attempts, ambiguous jobs, changed criteria/provenance, an existing publication
branch, a pending merge and any previously used retry receipt.

The new grant consumes normal capacity: coding **1 → 2**, retries **0 → 1**,
reviews remain **0** until an independent review is actually reserved. The
existing daily admission remains in its original day. No counter or limit is
reset or enlarged. An immutable retry marker binds the new manual parent,
tested main head, push-CI run and maintenance decision #98, while the original
automatic and discovery proofs remain unchanged.

Before the new model step, successful current-main push CI is required and the
trusted sandbox must freshly reproduce RED on that main head. Harness commits
between the historical intake and the retry are not injected as app overlays.
Later repair cycles use that same immutable retry baseline. Trusted GREEN,
secret scanning, app CI, independent subscription review and the required
review gate remain mandatory. The retry operation itself never automatically
merges or deploys.

After the complete run, turn the factory and automation off; keep discovery and
merging off while inspecting the result. Preserve failed reservations. Do not
rerun the old parent or repeat this one-time operation. Restore the original
operating settings/workflow states only after reviewing the result and any
pending merge state. Production deployment still needs named human approval.

## Model-free validation

`node --test scripts/tests/factory-finding-retry.test.cjs scripts/tests/factory-discovery-repair.test.cjs`
exercises the real reservation policy, original/recovered producer identities,
preview, stale-main and provenance rejection, failure receipts, stop and limits,
repeated retry prevention and preservation of another ticket. The existing
recovery-origin suite tests expired/substituted artifacts and forged receipts.
Run `yarn test:factory` for the full model-free harness suite.
