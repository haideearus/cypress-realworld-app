# Dependency and security maintenance

Implementation ticket: [#50](https://github.com/haideearus/cypress-realworld-app/issues/50).
Local preparation evidence: [verification record](dependency-maintenance-verification-2026-11-15.md).
This lane is installed. Controlled trials of Dependabot PR #52 have been held by
analysis or independent review; a completed dependency merge/deployment trial is
still pending. The retained-version/reporting repair is tracked in
[#60](https://github.com/haideearus/cypress-realworld-app/issues/60) and its
[verification record](retained-advisory-fix-verification-2026-11-15.md).
All three factory switches remain false during this repair.

## What happens

Dependabot proposes changes to the application's library versions. The dependency
workflow selects only genuine `dependabot[bot]` PRs in this repository against
`main`. No `factory-ready` label is needed for this lane. App repair tickets still
use their existing label and coding workflow.

```text
Dependabot PR -> metadata admission -> version/source/OSV checks -> exact-head CI
             -> read-only Claude Pro review -> fresh version/source/OSV checks
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
  head is never automatically retried. The existing turn and timeout caps apply.
- Only modified root `package.json` and `yarn.lock` are accepted. Stable patch and
  minor updates and supported transitive fixes are eligible. Major upgrades,
  downgrades, changed dependency names/sections, scripts/configuration, unsupported
  sources, prereleases and ambiguous graph transitions are held. The ordinary app
  merger still cannot merge dependency files.
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

## Installation after this PR is reviewed and merged

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

Before the dependency model session, trusted code reads `package.json` and
`yarn.lock` from the reserved immutable base/head commits. It fetches each resulting
affected version's npm registry record, including retained/baseline copies, and
matches the package name, version, canonical
tarball, integrity, and any lock URL SHA-1 fragment. A fresh OSV batch maps advisory
IDs to each checked package/version; advisory detail requests supply the affected
npm package ranges and explicit affected versions, including legacy release lines.
The packet records its
observation time, exact commits, changed dependency files, source URLs and the
separate cleared/remaining-baseline summary.

The reviewer receives these facts in `.factory-input/context.json`. A separate
`dependency-facts-<grant>` artifact retains the same scanned packet for seven days.
It is evidence, not an approval or a replacement for CI, independent review,
fresh premerge checks or native branch protection. Unchanged historical documents
are context; they cannot authorize approval of a newer head. Registry existence
and matching checksums do not establish publisher trust, API compatibility, or an
absence of vulnerabilities throughout the app.

Only fixed, unauthenticated npm and OSV endpoints are contacted by trusted code;
redirects are refused and metadata-supplied URLs are never followed. No package
code or lifecycle scripts run to collect facts. The parser tools are installed
from the existing private lock in the trusted checkout before candidate checkout,
without model credentials. Claude still has only Read, Glob and Grep.

Evidence collection permits at most 50 resulting affected versions, 100 distinct advisory
records, four concurrent public requests, 1 MiB per response, 256 KiB for the
finished packet, 500 explicit versions per affected record, 15 seconds per request
and two minutes for collection. Missing,
changed, withdrawn, oversized or malformed evidence holds the review. Unsupported
advisory range formats are held rather than silently omitted. These are metadata
safety bounds; the existing AI admission/attempt/review/turn/time limits and
historical ledger schema remain unchanged. A failed preparation retains its grant
and history; this feature does not introduce a same-head retry exemption.

Sources: [Dependabot configuration and limits](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference),
[fork version updates](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/enabling-and-disabling-version-updates),
[OSV batch API and pagination](https://google.github.io/osv.dev/post-v1-querybatch/).
