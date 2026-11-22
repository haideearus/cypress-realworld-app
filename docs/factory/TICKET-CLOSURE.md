# Verified app repair closure

**Close verified app repairs** runs after successful **Approved production
deployment**. Its twice-daily schedule can catch up when the deployment event
was missed or browser recovery arrived later. The existing factory and
automation switches authorize writes. A durable emergency stop holds them.

The workflow checks the original `factory-ready` issue, the retained passing
review and CI for the exact PR head, the factory's merged record, and the active
production release. The release must come from successful main CI and a
named human production approval. A newer release qualifies when it contains the
recorded merge and the release comparison shows the repair files survived
unchanged. Reverted, changed, blocked, and unreviewed repairs remain open. The
runner writes only confirmed issue closures, with no model or deploy credential.

Functional findings require the retained recovered browser incident and its
original trusted publication. Claude discovery repairs carry their verified
intake and repair proof. Production monitors keep their separate closure path
with production probes. Dependency tickets keep their Dependabot confirmation
path.

## Preview for issue #156

After this change is on main, open **Actions → Close verified app repairs →
Run workflow** on main. Enter issue **156** and deployment run **44953471185**.
This dispatch is always read-only. While release `49ba458` is live, the
summary should show issue #156 as eligible, PR #157 and merge `4f05497`.
If a newer tested release has shipped, use its verified deployment run ID.
Keep the original issue open for the automatic test.

A successful future deployment or the scheduled catch-up can record the actual
closure. Verify the live SHA and the recorded issue number in the workflow
summary. The next healthy browser observation can release the functional
incident slot. The usage ledger and every prior attempt remain intact.
