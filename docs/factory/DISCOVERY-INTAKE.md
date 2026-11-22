# Verified AI discoveries to maintenance tickets

This stage connects the opt-in [discovery runner](DISCOVERY.md) to ordinary
maintenance. Preparing or merging its code does not enable discovery. The
existing factory switches, concurrency setting, counters, required checks and
named production deployment approval remain authoritative.

For the historical recovered-evidence download failure on issue #96, see the
[bounded retry procedure](FINDING-96-RETRY.md). It preserves the consumed attempt
and original finding proof; it does not automatically retry or enable discovery.

## What qualifies

Normal discovery intake accepts the functional-feed and functional-directory
charters. The finding must carry the canonical generated test hash and trusted
title and summary for its validated scenario. The queue checks these again
before a new repair reservation. Older reports, including saved recovery
evidence, stay in history and are excluded from normal intake and new automatic
admission.

A finding needs an actual finished Claude subscription discovery grant, the
exact source audit issue, successful discovery/model/replay jobs, and a retained
nonexpired evidence artifact identified by run, artifact ID and digest. Report
completion (`assessmentComplete`) does not establish a bug. Each accepted
finding must have its own original failing test, two failing proposal replays,
and two matching observations from the trusted oracle catalog.

Unsupported expectations and ambiguous, flaky, environment or startup failures
remain held. Fixture evidence cannot enter production finding publication.
Discovery is bounded exploration; it does not prove complete app coverage.

Historical bank-account and private-transaction isolation receipts additionally require
verified distinct synthetic sessions and successful owner/participant reads.
They use fixed seed records, authenticated readers and empty oracle queries.
The existing current-head intake and repair RED/GREEN use the same trusted
contracts: denying all users, returning a wrong record or losing authentication
cannot establish a repair. Public/contacts transaction policy is not inferred
from the private-transaction contract.

Historical evidence with `oracle: null`, including both candidates from discovery
run 44179920739, stays held. Its artifact, report, test hashes and consumed grant
remain in the audit record.

## Publication and history

**Verified discovery finding intake** uses GitHub-hosted runners and no model
credential. Successful discovery/main-CI completion can request it, with a
half-hour fallback opportunity. GitHub may delay or miss schedule opportunities.

The dedicated `factory/findings` branch records source receipts, lifetime
fingerprints, publication intentions, duplicates and replay attempts. It is
explicitly initialized; absent metadata holds work instead of creating state
silently. Records stop at 400 findings, 400 source imports, 3,200 replay attempts
or the one-megabyte metadata limit. Owner maintenance is required at a bound;
records are not deleted to reclaim usage.

At most **four new ticket intentions per Bucharest day** and **two findings per
source sweep** are accepted. A fingerprint uses the trusted contract, route and
symptom, independent of commit or model title. Duplicate evidence is appended
in comments; frozen ticket criteria are never rewritten. An observed-resolved
finding retains its history and a later recurrence gets a new generation.
Protected factory merges are recorded separately as **repair merged**, preserving
the admitted origin receipt. The production closure workflow completes the issue
after verifying the deployed repair, then intake records the confirmed closure.
New recurrence evidence must descend from the recorded resolution or merge
commit. Older source evidence stays a duplicate.

Issue/comment intent is retained before a non-idempotent request. An unknown
response is reconciled against exact bot-authored content within five pages;
it is never resent speculatively and never refunds its allowance. An intent
known not to have started may resume after the stop is cleared. Request and
confirmation producer identities are retained separately. Labels or bot names
alone never establish trusted origin.

## Current-main replay and repair

Before coding admission, the original reproducer and trusted oracle run twice
on current, successfully tested `main` in fresh isolated synthetic sandboxes.
The original SHA and RED log stay separate from this current-head receipt.

There are at most **two intake attempts per finding/day** and **eight total/day**,
including failures. An attempt is consumed before building its baseline. Build
preparation is separately bounded to 25 minutes; the subsequent execution shares
one five-minute deadline across all four probes. No AI session is used for
intake. Stop, available ticket budget, capacity and a pending merge intent are
checked before replay and again before ordinary coding admission.

- Two failing proposals and matching contract violations produce a ready receipt.
- Two passing proposals and healthy typed observations produce **observed
  resolved**. A truthful evidence comment closes the issue without claiming a
  factory-authored repair or live production verification.
- Broken, missing, expired, changed or inconsistent evidence produces a visible
  hold. New main commits do not bypass replay limits.

An exhausted sibling or expired source cannot block other eligible findings.
Interrupted resolution comments/closures are reconciled from retained intentions.
If reconciliation stays ambiguous, that closure is held instead of blocking the
queue; the owner can use `reconcile` with its exact `finding_key` and preview
checked before authorizing another metadata-only attempt. Preview never changes
the issue or starts a model.

The successful intake completion reaches the existing event wake through a
typed, independently revalidated finding receipt. The repair consumes an
ordinary maintenance ticket and ordinary coding/review/retry allowances.
Discovery evidence is never an independent review pass.

For these repairs Claude has file-editing tools and no shell. Trusted jobs run
the original reproducer and oracle in isolated Docker before and after coding.
Only the original admission-main baseline is built into the image. Unmerged
patches and prior retry edits are applied as read-only runtime overlays inside
fresh copies under uid1000; generated code cannot replace the image's trusted
oracle, entrypoint or interpreter during a privileged build. GREEN checks the
exact validated files to publish, not arbitrary workspace contents. Publication requires that exact file hash,
source/grant identity, preserved RED, GREEN and the successful trusted coding
job. Later normal retries may preserve the first trusted RED while checking an
already-correct baseline; they do not refund attempts. Original tests and raw
trusted results remain in separate artifacts.

The existing model job timeout and turn cap are unchanged. Preparation and
verification count toward its timeout, so an overlong repair holds. Exact-head
CI, fresh independent review, protected merging and human production approval
still apply. A sandbox fix is not evidence of a deployed release or live-monitor
coverage. Journal entries preserve that distinction.

## Later authorized rollout

These are instructions for a later owner-authorized acceptance, not actions
performed when this PR is prepared.

1. Review the implementation, obtain its genuine independent Claude Pro review
   under the unchanged limits, and merge only through both required checks.
2. Keep `FACTORY_DISCOVERY_ENABLED` absent/false. Confirm the existing discovery
   registry setup; then open **Verified discovery finding intake** on `main`,
   select `initialize` with **dry_run checked**. Preview creates no state.
3. With separate setup authorization, run `initialize` with **dry_run unchecked**
   once to create only the findings metadata namespace. It starts no Claude and
   changes no factory variables. Reinitialization refuses to erase history.
4. Run `preview` with **dry_run checked**. It performs read-only inspection and
   cannot publish a ticket, reserve a replay or start a repair. With no completed
   source, an empty preview is expected.
5. Authorize a bounded real discovery and repair acceptance separately. Inspect
   original RED, current-main proof, deduplication, ordinary counters, independent
   review, protected merge and named deployment approval. Retain fixture labels
   where fixtures are used; fixtures cannot manufacture production provenance.
6. Enable discovery only after acceptance. The proposed allowance remains two
   discovery sessions and four new findings/day. Keep the live concurrency at
   its current value; a two-ticket rollout needs its separate stopped/idle ledger
   migration and acceptance. Scheduled execution runs on GitHub with the PC off.

Use only `CLAUDE_CODE_OAUTH_TOKEN` for separately authorized model sessions.
Keep Claude extra usage/usage credits off. There is no paid AI API fallback.
If stopped, preserve the durable stop and use the existing explicit owner resume
procedure only when another run is authorized. Never clear counters or receipts
to make a test fit.

## Saved-output recovery

The narrowly pinned, manual recovery procedure is described in
[Saved privacy discovery recovery](DISCOVERY-RECOVERY.md). It retains failed
source history and requires a separate trusted replay receipt; ordinary failed
sources remain ineligible.
