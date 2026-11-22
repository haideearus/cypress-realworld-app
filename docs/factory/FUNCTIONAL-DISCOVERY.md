# Safe functional discovery

This workflow runs checked-in browser assertions against a disposable copy of the
application with a synthetic database. It checks sign-in and its accessible
field labels, navigation between Home and Settings, opening Settings, Settings
form validation, saving and reloading Settings, bank-account onboarding, the
Everyone/Friends/Mine feed tabs, the new transaction form, and Notifications.
It runs with zero model calls against the disposable app.

The transaction form check finds a seeded recipient and verifies that the request
and payment controls are disabled for missing values and enabled with valid
values. The check ends before submission. Notifications checks use seeded
unread like and comment items for the populated view and a fixed empty
response for the empty view. The browser does not mark notifications as read.

The Settings persistence check creates its own synthetic user. It changes the
first name through the form, checks that the save succeeds, then starts a
fresh session and verifies the saved name appears in Settings. A simulated bank
account list keeps onboarding outside this scenario.

The onboarding check creates a fresh synthetic user on loopback for each attempt.
It simulates one rejected GraphQL save and expects the form to remain open with a
visible error. A second save uses the disposable database. The check signs out,
signs in again, and verifies that the account is listed and the wizard stays
closed. Other account-changing browser requests remain blocked.

The runner reports a confirmed failure only when the same approved named
assertion fails in two browser runs on the same checkout. When several checks
fail, the runner selects one repeated assertion in the suite's fixed order.
The summary shows a check as passed only when it passed both runs, or the suite
passed on the first run. Other failed checks remain unconfirmed in the summary.
Installation, application startup, browser errors, unknown failures, and a
failure with no reproduced assertion are inconclusive. The published issue
identifies the fixed check and assertion IDs, the trusted run, and its commit.

The publisher verifies the current main revision and uses a separate functional
incident registry with one open incident and the existing daily publication
bound. A repeat failure reuses the open incident. A different failed assertion
leaves the previous incident's recovery state unchanged. If a closed issue's
incident still has no healthy observation, it can continue to hold the slot.
Inspect the earlier issue and browser outcomes before relying on publication of
another finding. The production monitor keeps its own incident slot. Event
pickup verifies the finished source workflow, successful browser and publisher
steps, issue text, and retained incident before repair admission.

## Preview and activation

1. After the implementation passes protected review and post-merge CI, open
   **Actions → Safe functional discovery → Run workflow** on `main`. Leave
   **Run the approved checks without publishing a ticket** checked.
2. Inspect the **browser** and **publish** jobs. Expect `outcome=preview`,
   `modelCalls=0`, and a result of `healthy`, `confirmed_failure`, or
   `inconclusive`. A preview creates no ticket or incident receipt.
3. Check that the preview is healthy or confirmed the expected assertion before
   allowing publication. With `FACTORY_FUNCTIONAL_DISCOVERY_ENABLED=true`, the
   02:12 and 14:12 UTC schedules and eligible **Factory CI** completions run the
   approved checks and can publish a finding. A fresh owner-dispatched run with
   the checkbox unchecked uses the same incident limits.

The CI trigger verifies a first, successful **Factory CI / verify** job from a
same-repository push to the current `main` commit. It accepts CI initiated by the
owner or the verified factory GitHub App. Look for **Verify functional discovery
CI trigger** in the browser job. Publication checks that the tested commit is
still current, and pickup requires the retained passing trigger proof.
Periodic checks can still find regressions with no recent merge. GitHub can
delay or drop a scheduled start. [GitHub schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

**Proactive app discovery** and **Verified discovery finding intake** have
separate activation controls. Event pickup and the factory switches control the
repair of a published browser ticket. CI, independent review, protected merge,
and named production approval apply. [Verified app repair closure](TICKET-CLOSURE.md)
closes an eligible repair after the approved release is verified in production.
A subsequent healthy observation can then release the incident slot.
