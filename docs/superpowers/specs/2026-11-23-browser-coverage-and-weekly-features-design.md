# Browser discovery and weekly AI features

## Goal

Give the demo payment app more meaningful browser coverage and a way to grow through useful features Claude chooses. Measure discovery by completed journeys and confirmed findings. Measure feature work by tested features merged, with deployment recorded separately.

## Approach

Extend **Safe functional discovery**, **Proactive app discovery**, and **Verified discovery finding intake** for coverage. Add one weekly planner workflow for features. The planner submits scoped, verified feature tickets to the existing **Automatic factory**. Reusing that workflow keeps coding, independent review, exact-head CI, protected merge, and repair priority in one place. A separate weekly coding pipeline would require duplicate admission and review controls. Weekly owner selection could improve alignment, but the owner chose to approve product goals once and let the AI select work inside them.

## PR 1 — Expand browser discovery

The first additions go beyond the existing form, feed-tab, onboarding, and weekly request, comment, and avatar checks.

| Journey                                                     | Expected result                                                                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Send a demo payment and start fresh sessions for both users | Both histories show the same transaction, balances reflect it once, and the recipient sees the matching notification. |
| Mark a notification read and reload or sign in again        | The selected notification stays read and the badge matches the remaining unread items.                                |
| Use amount/date filters and clear them on a small screen    | The feed shows the correct seeded results, shows an actionable empty state, and restores the full list when cleared.  |
| Remove a demo bank account and revisit from a fresh session | The list reflects the deletion and onboarding appears only when the user has no active account.                       |

Keep short checks in routine runs and run longer journeys in the weekly full suite. Record the completed journeys and results in the run summary. Use disposable fixtures. Claude can choose typed browser journeys and navigation sequences in its existing four bounded batches. The second and optional third daily sweeps ask for two distinct browser journeys.

Keep the verified API intake and add a handoff for exact browser templates. Map the single-screen Settings validation cases and the empty Notifications view to named checked-in assertions. Replay the matching assertion twice in fresh disposable sessions and deduplicate against the fixed browser suite before publishing. Startup errors, timeouts, and inconsistent assertions remain inconclusive. The publisher verifies the sweep and current main, and one confirmed defect can enter the existing app maintenance queue as `factory-ready`.

Use one serialized publication path and one active browser incident slot for both browser sources. Repeated observations of the same check and assertion share the same incident. Retain template, variant, hashes, artifact, and producer run so the evidence can be traced. Replay the first eligible browser lead in a sweep. Keep other leads and evidence for an occupied slot in the sweep record.

Validate with a repeatable synthetic defect in the disposable test app, a healthy control, and cases for an interrupted run and a duplicate finding. Compare completed coverage and elapsed CI time before promoting more checks to routine runs.

## PR 2 — Add weekly AI feature planning

Proposed product goals are easier transaction history and receipts, clearer requests and notifications, and simpler onboarding and mobile/accessibility use. A searchable activity view with useful payment and request filters is an example of a significant feature. Smaller examples include a usable empty filter state, a visible save error, and preserved form state when navigating back. The planner should tie each proposal to a concrete user problem in feedback, an approved roadmap entry, or a demonstrated friction point. It should explain the expected behavior, how users benefit, what tests prove success, and the smallest credible scope.

The owner grants standing authority to choose features for the ordinary demo-app experience. Transaction history, clearer requests, and onboarding are examples. Proposals should explain which current user journey improves and cite verifiable evidence so the controller can check the scope before publication.

The weekly target is up to one major feature and five minor improvements. Dedupe against current features and open issues. Publish only proposals with a clear benefit and acceptance test. Keep the planned, merged, and deployed counts separate. A major feature can be staged across reviewable PRs.

A metered Claude Pro planning session returns structured proposals. A trusted controller validates the app scope, eligibility, bounded fields, and duplicate key before publishing a feature ticket and its durable receipt. Pickup verifies this new feature origin before it assigns existing coding and independent review sessions. Production incidents, verified defects, and urgent dependency work retain priority. Keep model execution inside the existing app-change boundaries, with CI, scanner and independent review gates, and human Render approval.

Count a maximum of one planning session per Bucharest week. Check ready and due repair work at planner admission and again before publishing or starting a feature, including a feature retry. Defer feature work while a production incident, verified bug repair, or eligible urgent dependency repair is waiting. A feature already in its bounded execution slot can finish. Publish and start one feature at a time, with separate per-week major and minor limits and durable progress across runs.

Start with a model-free planner preview and one small feature pilot. Demonstrate that a replayed event cannot publish twice, that pending repairs keep priority, and that quota, stop, and untrusted-ticket failures defer safely. Count every Claude admission in the existing ledger. Allow a third daily discovery sweep only after measuring a week of the existing two and confirming room in the Claude five-hour and weekly usage and the GitHub Actions API budget. Spread discretionary work across time windows and defer near the GitHub reset. Use Claude Pro with Usage Credits off.

Use 25 percent of the observed GitHub job-token hourly allowance as the initial headroom target for discretionary work. Verify baseline GitHub headroom during busy periods and review both Claude usage meters over a full weekly usage cycle before raising discovery to three sweeps per day. Claude Pro usage is checked in the account Usage page for rollout decisions. The workflow accounts for factory reservations and provider quota stops.
