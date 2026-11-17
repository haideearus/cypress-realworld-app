# Two active factory tickets

This is the first implementation stage of the approved factory expansion. It
adds two-ticket support; it does not enable that capacity automatically. The
existing installation remains at one active ticket until an owner performs the
stopped migration below after this PR is merged and CI passes.

## Ownership and limits

- Version 1 usage ledgers keep their existing `active` entry and capacity one.
- Version 2 replaces that field with `activeTickets`, keyed by maintenance ticket.
  Each entry records the exact parent run and attempt. Both app and dependency
  work use the same capacity; owner PR reviews also consume a slot.
- One ticket's phases stay sequential. Different tickets run on separate
  GitHub-hosted job workspaces and use their own artifacts and disposable data.
- Usage-ledger mutations still use `factory-ledger`; app and dependency merge
  jobs share `factory-auto-merge`. Production deployment remains serialized and
  requires its named human approval.
- An automatic/dependency review retains its slot through merge or reconciliation.
  A finished owner PR review releases its slot for the human merge handoff.
  An ambiguous merge retains its intent, approval, counters and ownership.
- Emergency stop inventories both parents and all reservations. Failed or partial
  cancellation keeps the durable stop and unresolved ownership. The existing
  narrowly contained historical queued run remains recorded as queued.

Daily twenty-ticket, five coding attempts, ten reviews, four retries and
200-turn/30-minute session ceilings are unchanged. Two simultaneous sessions
share the same Claude Pro allowance. This change introduces no paid API fallback.

Discovery, event pickup and the activity journal are later implementation stages.
They are not installed or enabled by this concurrency change.

## Later owner migration

Do not run these commands as part of preparing or reviewing the PR. They modify
live operation and require a separately agreed stopped window.

1. Merge the reviewed concurrency PR through both required checks. Update the
   local checkout to current fork `main` with Node 22.20.0 and existing owner
   GitHub authentication. Keep production data and tokens out of the terminal log.
2. Run `node scripts/factory/stop.cjs --execute`. Require `stopped: true` and
   verify all three switches are false. Resolve an incomplete stop before continuing.
3. Run `node scripts/factory/concurrency-migration.cjs` without `--execute`.
   It checks the stopped ledger, all three live switches and the bounded agent
   inventory. Require `eligible: true`. Record its full `expectedCommit` and digests.
4. Execute once using that exact commit:
   `node scripts/factory/concurrency-migration.cjs --expected=FULL_LEDGER_SHA --execute`.
   Require `migrated: true`. A stale commit or failed safety check requires a new
   preview; do not change the expected value merely to force it through.
5. Verify the returned ledger commit has version 2, an empty `activeTickets`,
   unchanged ticket/grant/day/approval history and one appended migration receipt.
   The prior commit is retained. The reported `afterDigest` describes the planned
   migrated state before that receipt is appended, avoiding a self-referential hash.
6. Set `FACTORY_MAX_CONCURRENT_TICKETS=2` only after migration succeeds. The
   migration command does not change any variable or resume the factory.
7. Separately authorize resume and acceptance. Use the existing stop/resume
   procedure; prove two actual isolated parents and their emergency cancellation
   before claiming the new operating profile is accepted with the PC off.

Do not downgrade an already migrated ledger to version 1. To reduce future
parallelism, stop and reconcile work, set concurrency to one and retain version 2
and all history. Do not delete entries, refund attempts or reset counters.

## Evidence and remaining acceptance

Offline tests cover two-slot CAS contention, rejected third/duplicate admission,
app/dependency sharing, owner review handoff, cancellation isolation, merge receipt
preservation, two-parent/partial stop and migration refusal/history preservation.
Native CI and fresh Claude Pro review remain required for this PR. No live
migration, two-model trial or PC-off acceptance is claimed by the implementation.
