# Unit outputs and larger bounded budgets

Historical rollout note: these ceilings are now merged and saved. Issue #11's
fourth coding attempt succeeded, and its strengthened repair merged as PR #25.
The next-run instructions below document that earlier rollout; do not redispatch
the completed ticket. For new unattended work, see [Automatic pickup](AUTOMATIC-PICKUP.md).

Implements [#21](https://github.com/haideearus/cypress-realworld-app/issues/21).

## Collection failure

Run 43418380398 finished Claude successfully in 41 turns with zero permission
denials, then failed collection. No code bundle survived, and the retained log
does not identify the historical failing filename.

A concrete collision was reproduced: Vitest seed/mutation operations wrote the
tracked `data/database.json` (368,209 Git-blob bytes), exceeding the 200,000-byte
file boundary. The new regression failed before unit isolation, then passed.
`VITEST=true` now selects LowDB Memory; ordinary development/Cypress FileSync and
the existing production Memory behavior remain unchanged. A full unit run leaves
the tracked database byte-for-byte unchanged.

Collection now rejects forbidden paths before content reads. Rejections identify
a bounded, sanitized repository-relative filename and file type/size/limit;
secret-like filenames are redacted. Evidence must stay below 20,000 UTF-8 bytes.
The original path, regular-file, UTF-8, secret, 200 KB/file and 500 KB/patch limits
are preserved. Increasing model turns cannot repair an invalid output file.

## Values to set only after this change is reviewed and merged

| Variable                               | Value                         |
| -------------------------------------- | ----------------------------- |
| FACTORY_ENABLED                        | false until ready for one run |
| FACTORY_MAX_TICKETS_PER_DAY            | 10                            |
| FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET | 5                             |
| FACTORY_MAX_REVIEWS_PER_TICKET         | 5                             |
| FACTORY_MAX_AUTOMATIC_RETRIES          | 4                             |
| FACTORY_MAX_TURNS_PER_RUN              | 200                           |
| FACTORY_RUN_TIMEOUT_MINUTES            | 30                            |
| FACTORY_MAX_CONCURRENT_TICKETS         | 1                             |

Timezone and application URL stay unchanged. Concurrency remains one because the
durable coordinator has one active-ticket lock. These are work ceilings, not a
token/money guarantee; higher limits can use more of the shared Pro allowance.
Only Claude subscription OAuth is accepted, with usage credits/extra usage off;
no API-key/provider fallback or purchase is configured.

Five sequential cycles support an initial attempt and up to four retries after
CI failure or a valid changes-requested review. Each follows the preceding
durable reservation. The terminal cycle never reserves an unsupported sixth
job. Infrastructure/provider failures still stop instead of looping.

## Continue issue #11 without resetting history

Its three consumed code grants and legacy recovery marker stay intact. Under the
new five-attempt budget, ordinary attempts four/five use retries two/three; fresh
tickets use at most five attempts/four retries. A sixth attempt and repeated
`recover` remain refused. Lowering limits still stops pending execution while
historical ledgers remain readable. Old workflow revisions may reject the new
counters; always start a new dispatch on the newly merged `main`.

After review/merge and saving the values above, use **Factory agents**, branch
**main**, operation **run**, ticket **11**, PR empty. This is a new ordinary
attempt, not a rerun of the consumed recovery. Blocked tickets with no published
PR select current main, so they receive the unit-isolation repair. Published PR
retries retain their existing head and orphan branches still refuse admission.

Enable only when ready, dispatch once, and restore false after the whole workflow
finishes. After a genuine review pass, refresh only the read-only native gate;
that metadata check invokes no model. No counter reset or old approval is used.
