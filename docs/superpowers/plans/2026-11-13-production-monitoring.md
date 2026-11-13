# Production monitoring and daily allowance

Tracking ticket: #33. Owner requested automatic monitoring/maintenance tickets and
a higher daily allowance in the same PR. Preparation is authorized; all existing
factory switches remain false. No model run, merge or deployment is part of this
implementation step.

## Design

- A separate `factory-monitor.yml` workflow checks fixed public health, readiness
  and frontend URLs every 30 minutes. `FACTORY_MONITOR_ENABLED` defaults false;
  manual preview performs reads only. No Claude credential or provider API.
- Bound network time, retries and response size. Treat remote content as data;
  issue descriptions use fixed text and enumerated failure categories only.
  A healthy release can legitimately be behind main awaiting human approval.
- Store incident history on `factory/monitor`, separately from usage counters.
  Record an intent before one issue-create attempt; ambiguous publication stops
  for owner recovery rather than creating duplicates. Keep one unresolved
  incident, at most two creation intents per UTC date, and at most 180 records.
- Issue identity, criteria hash, source workflow SHA/run/attempt form an immutable
  receipt. Pickup, admission and merge verify the receipt and actual successful
  main monitor run. Bot author or labels alone confer no trust. Freeze the receipt
  in the admitted ledger ticket. Recovery never refunds usage or re-admits a ticket.
- A bounded diagnostic ticket may stop on provider quota/configuration problems;
  agents may not change hosting plans, credentials, harnesses or production data.
  An unresolved incident never generates another daily repair budget.
- Raise the approved daily ticket ceiling from 10 to 20. Keep all other ceilings,
  subscription-only authentication, independent review, one active ticket and
  named human production approval unchanged. Existing main still governs the
  review of this PR until merge; do not raise the variable prematurely.

## Implementation and verification

1. Add probe tests before `monitor-probe.cjs`: cold starts, persistent failures,
   redaction, redirects, timeout/body bounds, older healthy release.
2. Add durable registry and provenance tests before `monitor-state.cjs` and
   `monitor-origin.cjs`: atomic append, malformed state, forged/edited tickets,
   unsuccessful/foreign runs and recovery after admission.
3. Add monitor coordinator tests before `monitor.cjs`: disabled/preview has no
   mutations, deduplication across days, intent-before-create and uncertain result,
   recovery/rearm, creation caps. Never simulate an incident against live GitHub.
4. Integrate verified receipts in queue/admission/merge and ledger validation;
   preserve owner-created ticket behavior. Add tests at these boundaries.
5. Add the disabled workflow, operator documentation and daily limit boundary
   tests. Run factory suite, lint/types, actionlint and diff checks, then obtain a
   separate local review and open a draft PR with real verification evidence.
6. User later performs genuine Claude Pro review, merges, changes daily variable
   to 20, previews healthy monitoring and separately enables monitor creation.
   Automatic coding/merging remain separately controlled. Production approval
   remains human. Scheduled delivery is best effort, not an uptime guarantee.

## Remaining work

Do not claim full recovery automation or PC-off end-to-end validation yet. Pending
publication, exhausted diagnostics, platform quota and stuck GitHub runs require
operator attention. Monitor registry retention is intentionally bounded and needs
owner maintenance when full. This PR must not erase history to resolve any limit.
