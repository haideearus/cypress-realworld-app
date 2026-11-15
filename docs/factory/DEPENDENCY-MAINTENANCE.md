# Dependency and security maintenance

Implementation ticket: [#50](https://github.com/haideearus/cypress-realworld-app/issues/50).
Local preparation evidence: [verification record](dependency-maintenance-verification-2026-11-15.md).
This lane is prepared for review. It has not been activated or tried against a live
Dependabot PR. All three factory switches remain false during implementation.

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
- OSV checks cover added and removed package/version identities. A known affected
  added version, outage, pagination, malformed result or exceeded bound holds the
  change. Recorded removed-version advisories describe this update; they do not
  certify that the entire app is vulnerability-free or that every CVE is fixable.
- Reports bind repository, PR, current base/head, trusted workflow source, run,
  attempt, stage and the private tools lock digest. Actual same-run successful
  producer jobs and artifacts are checked. Premerge evidence expires after five
  minutes and the PR must include current `main`; otherwise wait for a bot rebase.
- Interrupted metadata-only preparation can be released after its owning trusted
  parent is proven terminal. Model grants and uncertain merge intents are retained;
  the existing owner stop/recovery paths handle them without refunding counters.

The analysis bounds are 64 KiB manifests, 2 MiB locks, 10,000 lock entries, 500
changed package/version identities, five OSV batches of 100, 1 MiB per response and
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

Sources: [Dependabot configuration and limits](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference),
[fork version updates](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/enabling-and-disabling-version-updates),
[OSV batch API and pagination](https://google.github.io/osv.dev/post-v1-querybatch/).
