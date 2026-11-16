# Automatic merge confirmation

Dedicated harness ticket: #72. Requested scope: prepare the fix PR; do not run
Claude, enable any factory switch, merge, or deploy.

## Problem and intent

PR #57's approved squash tree reached main while GitHub still reported its PR
open. The dependency read then demanded a rebase, the merge response had been
discarded, and a later workflow could have attempted the same merge again.
The owner reconciled #57 as closed/already applied. Its approval and counters
are historical evidence and must not be changed by this implementation.

## Approach

Use the existing protected merge API and durable intent. Separate strict write
eligibility from observation of a possibly completed write. Retain a normalized
API receipt in the existing audit and poll actual PR metadata for a bounded time.
The selected approach keeps uncertainty explicit; neither a successful response
nor a matching tree substitutes for confirmed closed/merged PR metadata.

Blind retry was rejected because a lost response may follow a successful write.
Inferring merged from main/tree equality was rejected because #57 demonstrated
that an applied tree is not a confirmed GitHub PR merge.

## Behavior

- A fresh merge retains all existing native checks, exact-head approval, clean
  mergeability, dependency report/base checks, identity and stop guards.
- Before the PUT, the existing intent remains the durable write barrier. A
  provably unissued preflight failure may release it only with an audit entry.
- Normalize the API outcome into a bounded allowlisted audit receipt: merged
  response with valid SHA, rejected response, malformed response, or unknown
  transport outcome. Never retain raw bodies/messages or credentials.
- Confirmation reads still validate the same PR/repository/author/head, but do
  not require an open PR to be based on the now-current main or require a new
  dependency analysis artifact. This read path cannot authorize a PUT.
- Poll at most the configured merger polling budget with five-second pauses.
  Require matching closed/merged metadata and a valid merge commit before a
  merged ledger record. A retained valid response SHA must agree with metadata.
- Unavailable or still-open metadata leaves a clearly pending result, the intent
  and all approval/counter data intact. A later run observes this intent only;
  terminality of the previous workflow does not authorize another PUT.
- Dependency pickup routes existing intents into confirmation only, skipping
  analysis, CI reservation, model review and premerge. Changed heads after an
  uncertain intent are held for owner reconciliation, without retiring proof.
- A stop or changed approval prevents further work. No live state, switches,
  credentials, limits or branch protection are modified by preparing this PR.

## Verification

Add regressions before implementation: delayed closed metadata; main advancement
while a dependency PR is still open; lost/malformed/rejected API replies; SHA
disagreement; temporary GET failure; later-run no-duplicate behavior; unchanged
approval/counters; strict fresh-write checks; preserved stop behavior. Run the
full factory suite, lint/format checks and secret scanning. CI may run normal
tests after opening the draft PR; its required Claude review stays pending.
