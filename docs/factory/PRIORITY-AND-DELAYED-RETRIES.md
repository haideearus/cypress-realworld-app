# Priority and delayed retries

When `FACTORY_PRIORITY_RETRY_ENABLED=true`, Automatic factory selects eligible
production incidents and owner-authored issues marked `factory-priority` first.
The issues still need the usual `factory-ready` label and source checks. Within
each tier it selects the oldest eligible issue. Other newly eligible tickets
come next. Due retries come last. Existing ledger limits, active work, and
merge reconciliation take precedence.

A delayed retry is available only after a verified GitHub 502, 503, or 504
during preparation for an ordinary ticket's first automatic coding attempt.
GitHub Actions must report that the dedicated gateway hold step failed and the
Claude step was skipped. Existing blocked issues have no such receipt and
remain blocked. A failure during Claude, review, publication, or CI does not
qualify.

The delay starts when the failure is recorded. The next owner-dispatched or
scheduled pickup at least 30 minutes later can reserve the retry. Automatic
factory verifies that the original run has ended, the issue is open and
unchanged with `factory-ready`, and its agent branch and PR are absent. It
rechecks the ready queue before writing the reservation. An incomplete bounded
queue lookup holds the retry. An active run completes normally before any
pending work can take its slot.

The second coding reservation is on the original issue and counts under the
existing coding and retry limits. The original grant and daily admission are
retained. If the retry cannot finish, the ticket holds for inspection instead
of starting another automatic coding cycle.

## Preview

The setting is off when absent. After review and merge, you can turn on only
`FACTORY_PRIORITY_RETRY_ENABLED` and run **Automatic factory** on `main` with
its preview option checked. Keep the factory and automatic pickup switches off
for this preview. The summary identifies the selected issue or explains a
hold. Preview creates no reservation, invokes no model, and changes no issue.
