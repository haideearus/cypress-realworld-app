# Safe functional discovery

This workflow runs checked-in browser assertions against a disposable copy of the
application with a synthetic database. It checks sign-in, navigation between
Home and Settings, opening Settings, Settings form validation, and bank-account
onboarding. It does not use production account secrets, a model, or a paid AI API.

The onboarding check creates a fresh synthetic user on loopback for each attempt.
It simulates one rejected GraphQL save and expects the form to remain open with a
visible error. A second save uses the disposable database. The check signs out,
signs in again, and verifies that the account is listed and the wizard stays
closed. Other account-changing browser requests remain blocked.

The runner reports a confirmed failure only when the same named assertion fails
in two browser runs on the same checkout. Installation, application startup,
browser errors, unknown failures, and inconsistent results are inconclusive.
Only fixed check and assertion IDs and the trusted run and commit identify a
published issue.

The publisher verifies the current main revision and uses a separate functional
incident registry with one open incident and the existing daily publication
bound. A repeat failure reuses the open incident. A different assertion holds
the older incident for review while its issue is open. The production monitor
keeps its own incident slot. Event pickup verifies the finished source workflow,
successful browser and publisher steps, issue text, and retained incident before
ordinary repair admission.

## Preview and activation

1. After the implementation passes protected review and post-merge CI, open
   **Actions → Safe functional discovery → Run workflow** on `main`. Leave
   **Run the approved checks without publishing a ticket** checked.
2. Inspect the **browser** and **publish** jobs. Expect `outcome=preview`,
   `modelCalls=0`, and a result of `healthy`, `confirmed_failure`, or
   `inconclusive`. A preview creates no ticket or incident receipt.
3. Check that the preview is healthy or confirmed the expected assertion before
   allowing publication. With `FACTORY_FUNCTIONAL_DISCOVERY_ENABLED=true`, the
   approved checks can publish on the 02:12 and 14:12 UTC schedule. GitHub may
   delay scheduled starts. A fresh manual run with the checkbox unchecked uses
   the same controls and incident limits.

Keep the earlier **Proactive app discovery** and **Verified discovery finding
intake** workflows paused for this rollout. The existing event-pickup and
factory switches control repair for a published ticket. CI, independent review,
merge controls, and named production approval still apply. A functional issue
closes after its fix is verified by the owner. The next healthy scheduled check
can then release its incident slot.
