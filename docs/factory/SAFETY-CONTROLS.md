# Secret scanning and owner stop control

Implementation ticket: [#39](https://github.com/haideearus/cypress-realworld-app/issues/39).
The scanner and owner stop were merged in PR #40. The guarded stale-record
exception below is prepared under [#42](https://github.com/haideearus/cypress-realworld-app/issues/42).
A feature branch does not establish installation or a successful live one-minute
cancellation test.

## Build-blocking scanner

Required `Factory CI / verify` installs Gitleaks **8.30.1**, verifies both the
downloaded archive and executable against committed SHA-256 pins, and scans the
complete tracked working-tree snapshot before dependency installation. Supported
hosts are Linux x64 (GitHub runner) and Windows x64 (owner checkout).

```powershell
node scripts/factory/scanner-install.cjs
node scripts/factory/secret-scan.cjs source
```

Stage newly created files with Git before the local source scan; `source` uses
`git ls-files` and scans their current contents. It does not scan untracked files,
the entire Git history, external databases, or every provider log. CI's checkout
contains the committed source. Symlinks, Windows alternate streams/device names,
oversized files and unexpected scanner errors fail closed. Bounds are 10,000
files, 2 MB per file and 32 MB total.

The model workflow preserves trusted scanner helpers outside the candidate
checkout. It scans the reserved source and prepared context before model access,
then the collected role bundle and sanitized diagnostics before upload. Required
CI also checks a failure log before publishing its failure artifact. The scanner
receives no Claude subscription credential and uses no paid API or hosted
scanning action. Its subprocess environment excludes provider/GitHub credentials.
Findings expose only counts and rule identifiers; raw matches, locations and
scanner stdout/stderr are not printed or uploaded. Reports are redacted and
temporary staging is removed. There is no baseline, rule-disable list or broad
fixture allowlist. Candidate `.gitleaksignore` files and inline allow comments
cannot suppress findings in this wrapper. Every submitted file is staged under a
generated `.txt` name so inherited filename exclusions (including scanner config
and image names) cannot hide plaintext credentials. Rules that rely solely on an
original filename are consequently outside this content-scan boundary.

The default provider rules plus the explicit Claude OAuth rule catch known token
formats. No detector recognizes every possible password or encoding. Existing
least privilege, narrow output validation and credential-free test data still
matter. Cypress screenshots are not OCR-scanned, so they must continue to use
synthetic data. A source-file scan passing does not certify every artifact type.

References: [Gitleaks source and CLI](https://github.com/gitleaks/gitleaks),
[pinned release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1).

## One direct owner command

Run from this repository with its pinned Node version and **existing owner GitHub
authentication**. The CLI uses `GH_TOKEN`/`GITHUB_TOKEN`, or the existing Git
credential manager non-interactively, and verifies `/user` is `haideearus`. The
credential needs this repository's Contents, Actions and Variables write access.
Do not create a provider API key or paste credentials into chat, issues or logs.

Preview is read-only:

```powershell
node scripts/factory/stop.cjs
```

When an actual emergency stop is authorized, this is the single mutating command:

```powershell
node scripts/factory/stop.cjs --execute
```

It records an owner stop marker on `factory/state`, sets `FACTORY_ENABLED`,
`FACTORY_AUTOMATION_ENABLED` and `FACTORY_AUTOMERGE_ENABLED` to `false`, and requests
cancellation of every nonterminal factory agent parent (manual, automatic,
review, cycle/model and rehearsal workflows). It uses the API directly, so the
stop is not waiting for its own Actions runner. It tries force cancellation after
the ordinary request. Variable write/verification failures do not skip active
run cancellation. A failed inventory retains the marker and still attempts to
cancel the known active reservation.

The durable marker blocks current admission, worker preflight, publication and
automatic merge even with old workflow-variable snapshots. Older workflow code
that predates this marker must be stopped through GitHub cancellation; this PR
cannot retroactively change an already-running job. Production monitoring,
required CI/review gates and approved deployment are not AI agents and are not
cancelled. `FACTORY_MONITOR_ENABLED` is preserved.

The command uses a 55-second overall deadline, including authentication, leaving
margin against the course's one-minute target. An exit-zero result with
`stopped=true` and `withinMinute=true` means switch shutdown was acknowledged,
agent inventory completed, every executable agent parent was confirmed terminal
and the result was persisted. The sole conditional pre-job quarantine described
below is reported separately, with its actual queued state. Terminal confirmation
includes the recorded active run attempt. The command never refunds sessions or clears usage counts. It marks only
confirmed terminal reservations blocked and preserves existing reviewed evidence.

`stopped=false`, a nonzero exit or an authentication error is **not a successful
timed stop**. The marker and uncertain locks remain; output must not be used as
proof of cancellation. GitHub API/queue outages can prevent its platform from
stopping a job. Do not erase history or claim a guaranteed GitHub cancellation
SLA. Inspect the run, use GitHub cancellation and, for an active model emergency,
revoke its Claude subscription token. Restore only after resolving the incident.

Repeated `--execute` retains the original stop marker and previous switch values.
It may attempt cancellation again, but does not reset budgets or retries.

## One contained pre-job record

Run [43467058965](https://github.com/haideearus/cypress-realworld-app/actions/runs/43467058965)
is still **queued**, with zero jobs, check runs, artifacts and pending deployments.
GitHub rejected ordinary and force cancellation with 409 and the single guarded
rerun with 403, "This workflow is already running." No new attempt was created.
The owner selected quarantine after that failed recovery; deletion, status
fabrication and counter resets are excluded.

Protected code pins this one repository/run/attempt, source SHA, workflow,
check suite, actor and timestamps. Every reliance checks live provider evidence
and the validated ledger. The completed drill ticket #38 and its finished grant
must remain intact, and this stale run must have no grant or active reservation.
The frozen old controller reads and validates the current ledger before admission;
its actual policy rejects the retained `drill` origin. A credential-free offline
test executes that hash-pinned policy and proves the refusal. It does not depend
on the current switches remaining false. Current policy additionally denies this
run ID at admission and worker preflight, for every attempt.

Stop preview/result and resume report `quarantinedRunIds` and `quarantinedRuns`
separately from terminal and pending runs, including the actual `queued` state,
source and containment ticket. Executed stop/resume records that reliance in the
ledger audit. The exception never releases a lock or changes GitHub's record.
There is no configurable ignore list. See the
[preserved evidence and limitations](evidence/stale-run-43467058965/README.md).

Any changed attempt/source/identity, job, check, deployment, artifact, grant,
containment history or unavailable evidence **revokes quarantine**. The run then
receives ordinary cancellation handling, or blocks stop/resume if unresolved.
Checks repeat while stopping and before resume removes the marker. This handles a
contained pre-job record; it is not evidence that GitHub cancelled it, and it does
not replace the pending live one-minute agent cancellation demonstration.

## Explicit resume

Preview what will be restored:

```powershell
node scripts/factory/stop.cjs --resume
```

After owner authorization and resolution of every agent run/active lock:

```powershell
node scripts/factory/stop.cjs --resume --execute
```

Resume refuses outstanding executable agent runs or reservations and revalidates
any claimed quarantine. It restores exactly the
three values recorded by the stop and removes the marker only after GitHub
acknowledges them. It does not enable a previously disabled mode, alter monitoring
or limits, refund allowance, reset attempts or restart a blocked ticket. Changing
one variable manually while the marker exists does not resume the factory.

## Evidence still needed after merge

Local unit/simulated HTTP tests prove refusal paths, redacted secret detection,
deadline behavior and conservative lock handling. A preview is read-only and is
not cancellation evidence. No live stop, resume, model session or timed kill test
is part of preparing this PR. After independent Claude Pro review and merge, a
separately authorized cloud trial must capture start/end UTC timestamps, run and
attempt identities, cancellation acknowledgement, counters and marker evidence.
Until then the one-minute control is implemented but **not demonstrated live**.
