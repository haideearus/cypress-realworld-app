# Acknowledge observed recovery without claiming a repair

This is an owner operation for a standard monitor incident which has never
entered the AI ledger. It does not prove an AI repair or replace the existing
reviewed/merged/deployed repair path. Pagination-contract incidents and isolated
drills are ineligible.

Issue #65 is the motivating example: sign-in checks failed, then passed in a later
preview while the separate pagination defect remained. Its cause has not been
established. The original issue and receipt must remain intact.

## Preparation

After the implementation PR passes CI, receives its separately authorized Claude
Pro review and is merged normally, confirm its main CI. Keep all three agent
switches false and the durable stop active. Leave
`FACTORY_FEED_CONTRACT_CHECK_ENABLED` absent/false until this incident is resolved.
This operation never changes these settings, grants access to an AI service, or
resets an allowance.

## Preview

1. Open Actions, then **Acknowledge recovered monitor incident**.
2. Choose **Run workflow**, branch **main**.
3. Enter the exact issue number, for example `65`.
4. Leave **Preview eligibility and fresh checks without closing the issue** checked.
5. Run once. On Summary inspect `acknowledgment_preview`, the issue/incident,
   `scope: standard-only`, owner and observed release.

The checker signs in using the existing synthetic account, checks its session and
normal feed, logs out, and brackets the journey with cookie-free release reads.
The publisher separately checks health, readiness and frontend. Every check must
pass on the same stable release. The report is bound to this run and source,
credential-scanned and at most ten minutes old. No previous preview can authorize
a later operation. The pagination-contract request is not sent by this workflow.

Preview changes no issue, registry, ledger or variable. An ineligible target or
unavailable/failed evidence produces a held/failed run. Inspect the cause; do not
remove the stop, edit criteria or reset state to get a pass.

## Explicit owner execution

With separate authorization, start a new manual run with the same exact issue,
unchecking preview. This records the fixed decision
`observed-recovered-no-code-repair` under owner `haideearus`.

The operation saves intent, closes only that issue as **not planned**, confirms
its unchanged identity and closure, and records completed acknowledgment before
clearing its active pointer. It preserves title/body/comments/labels, original
receipt, issue day, Git history and all AI and monitor limits. Its summary says
that no AI code repair or deployment is credited.

The two-per-UTC-day monitor publication allowance is not refunded. AI admissions
remain separately limited per Bucharest day. Closing #65 does not repair the
pagination defect. A later, separately authorized publication can enable that
check and create its own genuine incident while agents remain disabled.

## Interrupted operation

An ambiguous close or final registry write retains its durable intent. Normal
monitor runs hold publication/repair retirement until the owner reconciles it.
Start a **new** manual run against the same issue, first previewing if useful;
GitHub Re-run attempts are refused. Fresh checks and source/criteria/stop/ledger
verification still apply. The operation reconciles a confirmed not-planned closure
only when its matching intent exists; manual closure alone is insufficient.

A completed acknowledgment is idempotent and cannot clear a newer incident.
Preserve the workflow URL and acknowledgment in `factory/monitor:monitor.json` as
the human-action evidence. Do not label it as code-repair acceptance evidence.

No workflow execution, issue closure or model use is authorized by installing
this documentation or merging its implementation.
