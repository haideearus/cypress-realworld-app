# Dependency and security maintenance

Implementation ticket: [#50](https://github.com/haideearus/cypress-realworld-app/issues/50).
Local preparation evidence: [verification record](dependency-maintenance-verification-2026-11-15.md).
This lane is installed. On 16 November 2026, [PR #58](https://github.com/haideearus/cypress-realworld-app/pull/58)
completed analysis, CI, fresh Claude Pro review, evidence refresh, fresh premerge,
protected App-backed merge and ledger confirmation in
[43909582583](https://github.com/haideearus/cypress-realworld-app/actions/runs/43909582583).
Its named-approved [deployment](https://github.com/haideearus/cypress-realworld-app/actions/runs/43913104368)
verified live release `f5969ed32fbe29eaea475b958d33d30f9dd30d18`.
The three switches were restored false and both pickup workflows re-enabled.
See the [operations guide](OPERATIONS.md) and [acceptance index](ACCEPTANCE-2026-11-16.md).

Earlier PR #52 analysis/review holds remain historical evidence. The retained-version/reporting repair is tracked in
[#60](https://github.com/haideearus/cypress-realworld-app/issues/60) and its
[verification record](retained-advisory-fix-verification-2026-11-15.md).
No extended scheduled-operation acceptance is claimed by that controlled run.

## Turn Dependabot alerts into repair tickets

**Dependabot alert intake** compares open alerts with the root Yarn lockfile on
`main`. The manual `preview` operation ranks package groups by severity, then
runtime exposure, and evaluates up to ten.
Public job logs and summaries show aggregate counts.
Each compatible candidate satisfies the existing version selectors and is
outside the affected ranges in the reviewed advisory catalog. A hold may require
updating a parent or a direct pin, reviewing unavailable evidence, or fixing
separate release lines individually. Candidate versions still need the existing
lockfile analysis, CI, independent review and branch protection before merge.

The GitHub App needs **Dependabot alerts: Read-only** on this repository. The
preview creates no tickets or PRs and uses no Claude sessions.

After the App permission and a hosted preview are verified, a separately
enabled run can prepare a repair. Set
`FACTORY_DEPENDENCY_ALERT_REPAIR_ENABLED=true` to opt in. The main factory
and automatic pickup switches must also be on. Intake checks at minutes 07
and 37 of each hour. It gives eligible app work and current native Dependabot
PRs priority, prepares one proposal at a time, and keeps a limit of ten new
preparations per Bucharest day plus the shared maintenance admission budget.

The workflow creates a ticket and an App-authored lockfile PR and applies
`factory-dependency-ready` after recording their exact identities. The normal
hourly **Dependency maintenance** workflow revalidates the ticket and PR, then
runs dependency analysis, CI, and one independent Claude Pro review through
the existing ledger. Both required checks and the existing merging switch
govern merge. Production deployment retains its approval gate.

Intake first tries an in-range lockfile update with unchanged dependency edges.
For an existing held issue, it can then evaluate a wider upgrade. It preserves
attempts when refreshing the same PR against a newer `main` and honors removal
of the ready label. It records a publication intent before creating a ticket or
PR and verifies a matching GitHub object to recover a lost response. It closes
a ticket after the protected merge is recorded, the patched lock entries are on
`main`, and GitHub reports no open alerts for the package.

### Held vulnerability tickets

When a reviewed compatible proposal is unavailable, intake can create one
`factory-dependency-held` issue for the package in the root lockfile. Its
status explains whether an updated parent or direct pin, a larger upgrade,
fresh registry data, or complete advisory evidence is needed. Intake can
reconsider the package on later scans and route the same issue through the
existing protected dependency workflow once a compatible candidate is verified.
The promoted issue links to its repair PR. An upgrade merged outside this path
has no matching publication receipt. Verify the fix and close the held issue
with evidence if that separate upgrade clears it. The held label alone cannot
authorize a repair, review or merge.

For a tracked hold with compatible registry candidates, intake tries up to four
versions in ascending order. It moves past a confirmed graph restriction or
advisory rejection only after a fresh check. A registry or advisory outage holds
the proposal. The chosen release must satisfy the existing selectors, preserve
the dependency graph and clear the advisory checks across affected lockfile copies.

The existing issue records the latest confirmed blocker. When more versions are
available, the next intake continues from the saved candidate position. After
exhausting the list, intake skips duplicate preparation until the dependency files,
candidate releases, or advisory evidence change. A weekly recheck covers updates
reported only by the independent advisory service. Removing the held label pauses
promotion. The issue keeps its identity and history when a candidate passes.

After an in-range check is exhausted or no common candidate fits, intake can
search for separate patched versions for different selectors. It can also try
upgrades to existing direct packages that introduce the vulnerable dependency,
including a major version step, or remove the vulnerable version when a new
parent release drops the dependency. It uses fixed public npm endpoints and
builds the manifest and Yarn lockfile from metadata. Preparation executes no
package code or lifecycle scripts.

A wider proposal can edit up to four existing direct dependency ranges and
the affected lockfile graph. It preserves root dependency names and manifest
configuration. Unsupported sources, missing patches, changes that need app code
edits, and incomplete evidence can still leave the issue held. The original issue
keeps the latest blocker, with recent search results retained in the registry
and earlier results in its commit history. Unchanged unsuccessful searches back
off for a day. Unavailable evidence gets one earlier retry after 30 minutes.

The exact candidate files are bound to the existing App-authored PR receipt, and
only that path accepts wider changes. Candidate CI, independent Claude Pro
review, native required checks and protected merge are still required. A bot
event can request pickup only for a matching trusted green CI receipt. A later
intake confirms automatic closure after the merge and alert clearance.

### Reserved turns for held dependencies

Intake reads one alert snapshot and has separate scan positions for new alerts
and held tickets. When both queues have work, intake gives held tickets priority
until it has prepared three held proposals that day. One new critical runtime
alert can take an earlier turn. The existing app work priority, daily limits
and one-publication limit still apply.

Held tickets are ordered by severity, runtime exposure and time waiting.
A bounded scan moves past paused tickets and incomplete evidence so those
records cannot block later held tickets. Intake keeps the original ticket and
records prepared, merged and GitHub-cleared repairs separately. It targets two
completed held repairs when candidates and capacity are available. The automatic
merge path authorizes at most four held merges per Bucharest day. Alert
reconciliation can finish after the cap is reached. Availability of compatible
releases, review capacity and GitHub scheduling determine how many repairs can
finish in a day.

### Event-driven dependency handoff

Successful push CI for the exact current main commit can wake **Dependabot
alert intake** when event pickup is enabled. Alert intake checks the CI producer
and its verification job before refreshing the existing proposal. It can
continue on its existing schedule if GitHub misses the event.

When intake defers held work because the factory slot is occupied, it can
resume once after the matching trusted workflow finishes and releases the slot.
Intake checks the current main commit, the saved queue, and the usage ledger
before consuming that receipt. Unrelated completions skip dependency analysis
and App token creation.

When PR CI succeeds for the refreshed head, **Factory event wake** revalidates
the configured GitHub App and the exact ready alert ticket, PR and head in
the durable registry. A valid event can start **Dependency maintenance**
through the same receipt mechanism as a native Dependabot PR. Existing CI,
independent review, budgets and protected merge requirements still apply.

## What happens

Dependabot proposes changes to the application's library versions. The native
lane requires a genuine `dependabot[bot]` PR in this repository against `main`.
The workflow creates one `factory-dependency-ready` tracking issue for each
native PR. It preserves that link across head updates and records whether the
PR merged or closed. Native PR eligibility remains governed by verified
Dependabot provenance, CI, independent review and branch protection. App
repair issues use `factory-ready` and their existing coding workflow.

```text
Dependabot PR -> metadata admission -> version/source/OSV checks -> exact-head CI
             -> scanned public evidence -> reserve and run read-only Claude Pro review
             -> fresh version/source/OSV checks
             -> native required checks -> protected merge
             -> named human deployment approval -> existing Render/live checks
```

Claude reviews the diff and recorded evidence; it does not write dependency fixes,
run a shell, or install packages. App tests execute candidate dependencies in a
separate disposable job without Claude, production, or GitHub App credentials.
Only the existing `CLAUDE_CODE_OAUTH_TOKEN` is supplied to the read-only model job.
There is no paid API fallback. Subscription exhaustion blocks the attempt.

After committing a dependency assessment, the trusted assessor refreshes the
informational `Factory review evidence` check through the existing ledger-based
checker. It can publish success only for the current head's genuine approval.
Changes-requested reviews publish failure; changed heads or unavailable proof
cannot authorize premerge. Only this trusted assessor gains `checks: write`;
the Claude and candidate-testing jobs retain their existing permissions.

If check publication fails, assessment fails and premerge does not start from its
output. The completed review, approval or blocked verdict, grant and usage remain
in the ledger. Do not rerun Claude to repair metadata. Once GitHub is available,
the existing **Factory independent review gate** workflow can be dispatched on
`main` with that PR number, without a model or ledger write. A later separately
authorized merge-only recovery must still pass fresh analysis, both native
required checks, clean mergeability, limits and stop checks. Publication alone
does not prove merge or authorize deployment.

When the merger reruns the native review gate, it waits for the commit check and
the job for that exact new workflow attempt to agree. It uses the same bounded
wait for the final verification before sending the merge request.

If a dependency merge stops before it sends GitHub a merge request, the ledger
records the failed check and a safe reason. A confirmed temporary GitHub read
failure can queue one merge-only retry for a later workflow, after at least five
minutes and any verified quota reset. The retry uses the existing CI and review
for the same head and base and performs the normal merge checks again. A failed
or expired retry leaves the approval and counters intact and lets unrelated
work proceed. An uncertain merge request still requires confirmation before
another send.

A held legacy gate can also claim one merge-only attempt with its saved CI and
review. The claim owns the worker slot and rechecks the current dependency
candidate before it runs. If the original native workflow still uses the old
verifier, the merger can attach `factory-gate-refresh` once to request a fresh
native check on the same PR. The required check must pass with the new verifier
before the merge. A changed head or incompatible base follows the ordinary
refresh and independent review path. GitHub event delays or missing evidence
can still leave the ticket held.

For a persistent hold, Factory activity updates one bot comment on the verified
tracking issue with the PR head, run link, and next action. Repeated verified
failures to obtain a fresh gate can create one harness maintenance issue. The
observer reports an unreadable ledger in its Actions summary.

## Limits and holds

- Native version proposals: Monday 06:15, Europe/Bucharest; one open version PR.
  GitHub separately permits up to ten security PRs; the version limit does not
  reduce that native security limit.
- Factory intake: hourly at minute 29. The same `FACTORY_ENABLED` and
  `FACTORY_AUTOMATION_ENABLED` switches gate live work. Merging additionally needs
  `FACTORY_AUTOMERGE_ENABLED`. No fourth switch was added.
- The shared ledger admits only one active app or dependency ticket. Dependency
  metadata admission counts toward the existing daily ticket cap, even if analysis
  fails. It consumes no coding or review session. A pending merge holds new work
  in both lanes until reconciled.
- A dependency PR has zero coding attempts/retries. Each distinct head gets at
  most one review attempt, capped at ten lifetime heads and the configured review
  limit. New bot commits preserve its admission and lifetime counters. A failed
  model review is never automatically retried on the same head. The evidence
  check can retry once without reserving a model. The existing turn and timeout
  caps apply.
- Only modified root `package.json` and `yarn.lock` are accepted. Stable patch and
  minor updates and supported transitive fixes are eligible. Major upgrades,
  downgrades, changed dependency names/sections, scripts/configuration, unsupported
  sources, prereleases and ambiguous graph transitions are held under ordinary
  dependency policy. A wider alert proposal has a separate, receipt-bound
  policy for verified stable upgrades. The ordinary app merger still cannot merge
  dependency files.
- OSV checks cover removed versions and every resulting version of affected
  package names. Added versions and existing versions selected by changed root or
  dependency paths are blocking candidates. Reused paths are followed recursively
  with bounded, cycle-safe comparisons; an ambiguous new selector is held.
- An affected newly selected/retargeted candidate, outage, pagination, malformed
  result or exceeded bound holds the change. Advisories on unchanged baseline
  copies are reported as `remainingBaseline`. They are never called cleared.
  `cleared` contains removed-version advisory IDs absent from all resulting
  versions of affected package names. This is an incremental check, not a whole-app
  security audit or a promise that every CVE is fixable.
- Reports bind repository, PR, current base/head, trusted workflow source, run,
  attempt, stage and the private tools lock digest. Actual same-run successful
  producer jobs and artifacts are checked. Premerge evidence expires after five
  minutes and the PR must include current `main`; otherwise wait for a bot rebase.
  New analysis/premerge proof uses report v2: `changed`, `candidateVersions`,
  `cleared` and `remainingBaseline`. Historical v1 reports remain in the ledger,
  but cannot authorize a new review or merge. No counters are refunded or reset.
- Interrupted metadata-only preparation can be released after its owning trusted
  parent is proven terminal. Model grants and uncertain merge intents are retained;
  the existing owner stop/recovery paths handle them without refunding counters.

## Confirming an automatic merge

The merger stores a durable intent before issuing one expected-head squash request.
It appends a small allowlisted receipt to the ledger audit: accepted with a commit
SHA, rejected, malformed, or unknown transport outcome. Raw GitHub messages and
response bodies are excluded. An accepted receipt alone does not prove the PR
merged.

Confirmation reads validate the same PR, repository, author and approved head.
They do not demand a rebase against the main branch that the pending merge may
already have changed. Fresh merge requests still require all existing base,
report, native CI/review, clean mergeability and stop checks.

The merger polls at five-second intervals, up to its existing polling budget
(normally 30 observations). It records merged only when GitHub reports matching
closed/merged PR metadata and a valid merge commit, consistent with any retained
accepted receipt. Still-open or unavailable metadata produces
`merge_confirmation_pending` or `merge_confirmation_unavailable`. These are held
outcomes, not merge success. The intent, approval, counters and lock remain.
An observer waits for a still-running writer's receipt before confirming success.
Receipt agreement is checked again inside the final ledger update, including
when another observer read older evidence. Late receipts are retained; conflicting
late evidence restores the held intent and appends the prior observation to audit.

A later dependency run routes that intent through the existing reconciliation
lane, without analysis, premerge, CI reservation or another Claude session. It
never repeats the ambiguous merge request, even if the original workflow has
finished. A changed head after an uncertain write is held for owner reconciliation;
it does not erase the old approval or admit a new review. A provably unsent
preflight failure may release its intent, preserving it in the audit, so a future
run can perform fresh checks.

If GitHub never confirms its metadata, owner reconciliation is still required.
The automation does not infer a merged PR from matching trees, bypass checks,
approve deployment, or manufacture a missing push event. PR #57's earlier owner
closure and its approval/counters remain historical evidence.

The analysis bounds are 64 KiB manifests, 2 MiB locks, 10,000 lock entries, 500
combined removed/candidate package-version queries, 500 path comparisons and at
most 500 pending comparisons, five OSV batches of 100, 1 MiB per response and
15 seconds per public request. Analysis jobs time out after eight minutes.

## Original installation procedure (completed setup)

These steps describe installation under ticket #50. Do not reapply initial-off
defaults to the installed monitoring configuration. Use the operations guide for
the current paused state and separately authorized activation.

1. Leave the factory switches false. In this fork's **Settings → Advanced Security**
   (GitHub may label this **Code security**), enable the dependency graph,
   Dependabot alerts and Dependabot security updates. In **Insights → Dependency
   graph → Dependabot**, enable version updates for this fork if GitHub requests
   it. These are GitHub settings, with no AI API key. Do not purchase a paid service.
2. Keep the existing repository-only GitHub App, subscription secret, usage limits,
   branch protections and required checks. No new secret or repository variable is
   needed. The emergency stop inventory includes the dependency parent workflow.
3. Open **Actions → Dependency maintenance → Run workflow**, choose `main`, keep
   **Preview** checked and run it. A preview reads eligibility only; it changes no
   ledger, starts no Claude session and merges nothing. An empty queue is normal.
4. Inspect the first genuine bot PR and authorize a controlled live trial before
   changing switches. Run with Preview unchecked only when ready. A live review
   needs the first two switches; merging needs all three. Restore them to false
   after the trial. Native PR CI and the genuine subscription review must pass;
   never bypass a gate to make the trial succeed.
5. Production remains behind the existing named human approval. A dependency merge
   does not authorize a Render deployment or destructive database operation.

## Local verification

Use Node 22.20.0 and Yarn 1.22.22. Install the separate trusted parser tools before
running the factory tests:

```shell
cd scripts/factory/dependency-tools
npm ci --ignore-scripts --no-audit --fund=false
cd ../../..
yarn test:factory
```

The private npm lock contains only `@yarnpkg/lockfile@1.1.0` and `semver@7.7.3`.
The app still uses Yarn Classic and its existing lock. Tool installation runs in
the trusted source checkout without lifecycle scripts or model/App credentials.
The fixture suite simulates GitHub/OSV/model results; it is not a live Claude trial.

## Current facts supplied to the reviewer

After exact-head CI and before reserving Claude, trusted code in the `evidence` job
reads `package.json` and `yarn.lock` from the immutable base and head. It fetches each resulting
affected version's npm registry record, including retained/baseline copies, and
matches the package name, version, canonical
tarball, integrity, and any lock URL SHA-1 fragment. A fresh OSV batch maps advisory
IDs to each checked package/version; advisory detail requests supply the affected
npm package ranges and explicit affected versions, including legacy release lines.
The packet records its
observation time, exact commits, changed dependency files, source URLs and the
separate cleared/remaining-baseline summary.

The factory scans the packet before handing it to the reservation job. The reservation
and reviewer both check the digest retained in the active attempt, the exact CI run,
the base and head, and a 15-minute age limit. The reviewer receives these facts in
`.factory-input/context.json`. A separate
`dependency-facts-<grant>` artifact retains the same scanned packet for seven days.
It is evidence, not an approval or a replacement for CI, independent review,
fresh premerge checks or native branch protection. Unchanged historical documents
are context; they cannot authorize approval of a newer head. Registry existence
and matching checksums do not establish publisher trust, API compatibility, or an
absence of vulnerabilities throughout the app.

Trusted code uses fixed npm, OSV and GitHub endpoints. The job token is used
only for same-repository CI evidence. Upstream requests are unauthenticated.
Redirects are refused and metadata-supplied URLs are never followed. No package
code or lifecycle scripts run to collect facts. The evidence job installs the
parser tools from the existing private lock in its trusted checkout. The reviewer
does not install parsers or fetch package evidence after reserving Claude. Claude
still has only Read, Glob and Grep.

Evidence collection permits at most 50 resulting affected versions, 100 distinct advisory
records, four concurrent public requests, 1 MiB per response, 256 KiB for the
finished packet, 500 explicit versions per affected record, 15 seconds per request
and two minutes for collection. Missing,
changed, withdrawn, oversized or malformed evidence holds the review. Unsupported
advisory range formats also hold the review.

When a reviewer evidence request returns HTTP 502, 503 or 504, the factory waits
60 seconds and checks once more after revalidating ownership and the PR. Rate
limits and unverified evidence hold the attempt. The ledger keeps start times and
outcomes under the original dependency attempt. If preparation stops here, no
Claude reservation is created. Older attempts and all usage counters remain
readable and keep their original values.

A tracking pass reports unresolved evidence and review holds on the linked
native Dependabot issue. After a confirmed dependency merge, a model-free pass
checks tracked PRs for recovery, starting with PRs whose passing CI was queued.
Successful **Factory CI** for a push to current `main` also wakes the
**Dependency maintenance** refresh job when event pickup is enabled. It checks
the trusted owner or factory-app run and requests at most one stale tracked
PR refresh per pass. The refresh job does not reserve Claude, dispatch CI,
change usage history, or merge a PR.
Scheduled tracking continues to check the rest of the queue within its usual
limits. When immutable comparison proves a native PR is behind `main`, the
factory can post `@dependabot rebase` once for each current head and base pair.
It keeps at most five base receipts per head and retains requests even if the
response is lost. The PR becomes eligible for fresh CI and review when
Dependabot supplies a new eligible head. A delivered comment confirms the
request, and the new commit confirms that Dependabot acted.

Automatic refresh needs the optional `FACTORY_DEPENDABOT_REBASE_TOKEN` Actions
secret. Create a fine-grained personal access token as the repository owner,
select only `cypress-realworld-app`, and grant only **Pull requests: Read and write**
plus GitHub's required metadata permission. Save the token directly as an
[Actions secret](https://github.com/haideearus/cypress-realworld-app/settings/secrets/actions).
The trusted tracking step uses it only for the rebase command. An unconfigured
credential leaves a manual rebase instruction on the tracking issue. Expired
credentials can be replaced. Inspect an ambiguous request on the PR before
sending another. [Dependabot command access](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/manage-dependabot-prs)
· [Comment token permissions](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment).

Sources: [Dependabot configuration and limits](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference),
[fork version updates](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/enabling-and-disabling-version-updates),
[OSV batch API and pagination](https://google.github.io/osv.dev/post-v1-querybatch/).
