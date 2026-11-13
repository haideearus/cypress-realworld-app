# Claude factory: installation and operation

This implements ticket [#6](https://github.com/haideearus/cypress-realworld-app/issues/6).
The workflows are installed through a reviewed PR. Keep `FACTORY_ENABLED=false`
during installation. Saving variables or a token does not enforce the limits by
itself; the controller and worker preflight enforce them.

## What is added

1. **Factory agents** is a manual, owner-only entry point on `main`. It can
   initialize the usage ledger, run one open issue, review an existing owner PR,
   or cancel active work.
2. A controller reserves usage on the dedicated `factory/state` branch **before**
   an agent starts. Missing/corrupt state or a failed write refuses execution.
3. A coding job checks out the reserved commit and runs one fresh Claude session.
   It has a read-only GitHub token, local disposable data, and no live secrets.
4. A separate publisher validates the resulting text files and evidence, creates
   a ticket branch/PR, and explicitly dispatches `Factory CI` for that head.
   Each dispatch has a unique ledger-backed request ID and exact run ID; an older
   successful run at the same commit cannot satisfy the request.
5. After `verify` passes, a separate read-only Claude session reviews the exact
   commit. A native pull-request job named **Factory review gate** checks the
   saved proof using trusted base-commit policy and read-only metadata.
6. Only a failed CI result or a valid review requesting changes can reserve a
   remaining automatic retry, within the configured five-attempt ceiling.
   Provider errors and interrupted model jobs stop work.

The initial version was manual. Ticket #26 adds a separately disabled scheduled
entry and protected automatic merging using a repository-only GitHub App. Follow
[the installation and trial guide](factory/AUTOMATIC-PICKUP.md); code preparation
does not establish live unattended operation. Public mentions, incident monitoring
and production deployment are outside this change.

## Subscription and spending

- `CLAUDE_CODE_OAUTH_TOKEN` is the only model credential referenced by a workflow.
  It goes only into the model action's `claude_code_oauth_token` input.
- No API key, alternative inference provider, billing configuration, purchase,
  or paid fallback is configured. Keep Claude **Usage credits / extra usage off**.
  That is a provider account setting; these workflows cannot inspect or enforce
  it on the owner's account. The owner confirmed it was off during setup.
- The pinned official action installs Claude Code **2.1.322**. Its source commit
  is `4fa93a88de49bbef68b10eb15aabedf28ca0e1ed`. It uses its own pinned dependency
  lockfile, so this project does not add a second CLI installer/package manager.
- `claude-sonnet-5` is the configured subscription model. Real subscription coding
  and independent review were demonstrated for issue #11 in
  [run 43433517715](https://github.com/haideearus/cypress-realworld-app/actions/runs/43433517715).
  [PR #25](https://github.com/haideearus/cypress-realworld-app/pull/25) subsequently
  added HTTP regression evidence and passed fresh review before merging. This does
  not prove remaining account allowance or future unattended availability.
- A Pro allowance is not unlimited and is shared with other Claude use. The
  counters below limit work, not exact tokens or a promised dollar allowance.
  Exhaustion must wait rather than buy usage.
- Standard Ubuntu GitHub-hosted runners are used. This PR does not change GitHub,
  Render, or Neon billing settings or claim a verified account-wide spending cap.

## Limits and counter meanings

Issue #21's reviewed change is merged. Its live daily setting was 10 on
2026-11-13. Issue [#33](https://github.com/haideearus/cypress-realworld-app/issues/33)
raises only the approved daily ceiling to 20. The table gives the intended
settings **after that PR merges and the owner saves the daily variable**; a code
change does not update GitHub variables. Keep all three factory switches false
during this rollout. Per-ticket limits, concurrency and subscription-only
authentication remain unchanged.

| Variable                               | Post-merge value                            |
| -------------------------------------- | ------------------------------------------- |
| FACTORY_ENABLED                        | false until ready                           |
| FACTORY_AUTOMATION_ENABLED             | false until ready                           |
| FACTORY_AUTOMERGE_ENABLED              | false until ready                           |
| FACTORY_MAX_TICKETS_PER_DAY            | 20                                          |
| FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET | 5                                           |
| FACTORY_MAX_REVIEWS_PER_TICKET         | 5                                           |
| FACTORY_MAX_AUTOMATIC_RETRIES          | 4                                           |
| FACTORY_MAX_CONCURRENT_TICKETS         | 1                                           |
| FACTORY_TIMEZONE                       | Europe/Bucharest                            |
| FACTORY_RUN_TIMEOUT_MINUTES            | 30                                          |
| FACTORY_MAX_TURNS_PER_RUN              | 200                                         |
| FACTORY_APP_URL                        | https://haide-software-factory.onrender.com |

The daily counter records distinct first admissions using Bucharest dates,
including owner PR reviews. Per-ticket code/review counters are lifetime counts,
not per-day counts. Five attempts means one initial attempt plus at most four
retries; the separate five-review allowance spans those attempts. All reservations
remain consumed even on failure/interruption, and a new run attempt cannot reuse
an old grant. Historical counters and approvals are never refunded or reset.

The cap-increase PR itself is reviewed by the existing policy on `main`, which
still has a ceiling of 10 until that PR merges. If ten tickets have already been
admitted today, wait for the next Bucharest calendar day before admitting its
review ticket. Do not set the variable to 20 early, reset the ledger, or reuse an
unrelated review ticket to bypass that limit. After the reviewed PR merges, save
`FACTORY_MAX_TICKETS_PER_DAY=20`; the same day's existing admissions still count
toward the new limit. The twenty-first distinct ticket is refused until the next
day. Lower configured limits remain valid. More daily tickets can consume more
of the shared Claude Pro allowance; this does not enable paid API usage or add
subscription capacity.

The coordinator retains one active-ticket lock across coding/CI/review. Existing
owner PR review still reserves its own review before CI and uses zero coding
calls. Missing/malformed/above-ceiling settings fail closed. Lower settings are
valid, but stop pending work when the applicable current budget is exceeded.

Five serial workflow cycles support the larger allowance. Each retry uses the
preceding output and next slot; the terminal cycle never reserves a sixth job.
Automatic retries follow only failed CI or valid changes-requested reviews;
infrastructure/provider failures stop. Only subscription OAuth is configured;
shared Pro quota exhaustion stops rather than purchasing paid API usage.

### Issue #11: preserved recovery history and completed repair

Its first two attempts failed at 20/50 turns. PR #19 added one audited recovery,
which was consumed in run 43418380398: Claude succeeded in 41 turns with zero denials,
then collection failed. No bundle survived, so its patch cannot be reconstructed
from retained artifacts. The failing filename was not logged.

The approved unit command was reproduced writing a tracked 368 KB JSON database,
over the 200 KB file boundary. Vitest now uses in-memory LowDB, preserving ordinary
development/Cypress and production modes. Collection validates paths before reads
and identifies bounded relative file/type/size/limit failures; private-looking
names are redacted. Evidence must be concise and below 20,000 UTF-8 bytes. Publication
path, regular-file, UTF-8, secret and byte boundaries are unchanged.

The fourth ordinary coding attempt succeeded in run 43433517715, using retries=2
and one independent review. The owner then requested a real HTTP regression to
strengthen the initial helper-only proof. Owner-authored replacement PR #25 passed
a fresh counted review under ticket #24 and merged. PR #23 is closed without
merging, and all original grants/recovery provenance remain intact.

Do not redispatch the completed issue #11 or replay its consumed recovery. The
old [operating details](factory/ARTIFACTS-AND-LIMITS.md) record that rollout; future
automatic tickets use the separate queue and App guide. Older workflow revisions
may fail closed on newer ledger metadata; use fresh dispatches on merged main.

### Command guidance without permission expansion

The trusted worker prompt/context now names its existing preapproved commands:
`yarn types`, `yarn lint`, `yarn test:unit:ci`,
`yarn build:production`, and `yarn test:production`.
The prompt directs the coding role to inspect files with repository-relative
Read/Glob/Grep calls, execute one bare approved command per call, and stop with
honest evidence if an approved action remains blocked. It points API regression
work at `scripts/tests/production-integration.test.cjs`, which is exercised by
the approved production test command after a production build.
The approved harness manages its own disposable server; the prompt restricts
additional shell commands for launching dev servers or invoking Cypress.

The read-only reviewer still receives Read/Glob/Grep and no shell commands.
Native tool lists, preapproval/deny rules, restricted/safe mode and noninteractive
permissions are unchanged. Claude's [permission documentation](https://code.claude.com/docs/en/permissions)
explains that noninteractive mode denies calls that need approval and that
compound commands have their own matching rules. This guidance closes a known
instruction gap; it cannot establish which raw calls were denied historically
or guarantee future model compliance without a separately authorized run.

## Owner installation steps, one at a time

1. **Review and merge the installation PR only after `verify` is green and its
   independent implementation review is recorded.** This bootstrap review is
   separate from a future real Claude maintenance-ticket review. Confirm Render
   automatic deployment stays off. Do not enable the factory or add the new
   required review check before merging this bootstrap PR.
2. In GitHub **Actions → Factory agents → Run workflow**, choose branch `main`,
   operation `initialize`, and leave the ticket empty. This creates the orphan
   `factory/state` branch without any model invocation. Initialization refuses
   to replace an existing ledger. Keep `FACTORY_ENABLED=false`.
3. Run operation `run` with an issue number while the flag is still false. The
   admission job must say disabled; both coding/review cycles must be skipped.
   No usage reservation or provider request should be created. Inspect the run.
4. Open a PR to register/check the merge gate. **Factory review status** runs a
   native pull-request job named **Factory review gate**. Without genuine proof
   for that exact head it must fail, including while the factory is disabled.
   This metadata check is not a model session. **Factory independent review gate**
   remains an informational proof-report entry; its custom API report is named
   **Factory review evidence** and is informational, not the required job.
5. Add **Factory review gate** alongside **verify** in main's required checks,
   selecting GitHub Actions as the source. Keep the branch protected for everyone.
   Afterward, unreviewed PRs, including owner PRs, cannot merge while disabled.
   A previously recorded genuine review of an unchanged head may still verify.
6. Before a later real demo, allow GitHub Actions to create PRs under repository
   **Settings → Actions → General** if GitHub currently disables that capability.
   Keep the default workflow token read-only; individual jobs request the narrow
   write scopes they need. This is a GitHub setting, not AI API billing.
7. Enabling agents and starting a real application ticket is a **later explicit
   owner decision**. This installation PR must leave the flag false. A normal
   application ticket is appropriate; ticket #6 itself changes the harness and
   is deliberately outside the normal agent patch allowlist.

For a later owner-written application or harness PR, use **Factory agents** on
`main`, operation **review**, with the open maintenance **ticket** and existing
**pr** numbers. The PR must be authored by `haideearus`, reside in this fork, and
target `main`. Trusted default-branch helpers dispatch exact-head CI, then run
only the separate read-only review role and publish the review proof. There
is no coding/publishing job or automatic retry in this path. If changes are
requested, update that PR and explicitly request another review within the two
review lifetime cap. A head change invalidates prior approval. This operation is
also disabled by `FACTORY_ENABLED=false`; it is not a human-author bypass.

### Review status reporting and PR #19 bootstrap

Ticket [#20](https://github.com/haideearus/cypress-realworld-app/issues/20) repairs
custom API checks that report success while GitHub still shows the required
status as Expected. A green API record alone does not establish merge readiness.
Check the actual PR merge status and the native required job.

**Factory review status** runs only on pull-request events. It checks out the
immutable base SHA, reads the current PR and durable ledger, and refuses missing,
stale, fixture, failed or unavailable proof. It does not check out PR code, run
an agent, install application dependencies, reserve usage, write the ledger or
receive a model credential. Its repository token is read-only. The actual stdin
entry is tested both with and without synthetic current-head approval.

After genuine current-head approval, open the matching **Factory review status**
run and select **Re-run failed jobs**. This reruns only its read-only metadata
gate, using the original pull-request event; it does not invoke Claude and can
run while FACTORY_ENABLED=false. The owner or an explicitly authorized repository
management action performs that refresh. Automatic gate refresh is not part of
this rollout: the proposed rerun helper and its added Actions write grants were
removed. Existing CI dispatch permissions stay unchanged; no metadata or model
job gains an extra permission. The informational custom check uses a different
name to avoid competing with the native required job.

For PR #19, both parts of the owner-authorized change are reviewed against the
complete [combined brief](factory/PR-19-REVIEW.md), also saved as issue #20 before
its first admission. This includes the recovery from #18 and reporting repair
from #20. The owner authorized one additional subscription review after the
second #18 review requested changes for a scope mismatch. Keep #18's two consumed
reviews and all verdicts intact. The additional review is recorded under the
existing, previously unadmitted #20; it does not refund history or create another
coding admission for #11. That historical rollout used 100 turns, 15 minutes, five daily
tickets and two reviews per ticket; its owner authorized one additional run.
Current post-merge ceilings are documented above under issues #21 and #33. Restore the factory flag to false after the full review
workflow finishes, refresh only the native gate after an actual pass, and verify
GitHub's merge decision before merging. No previous approval covers a new head.

GitHub documents that workflow trigger/source affects required-check evaluation:
[troubleshooting required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#checks-from-some-workflow-jobs-are-not-evaluated).

The GitHub integration used during setup could read main's protected flag and
required `verify` check, but its detailed branch-protection endpoint returned 403. The owner created the rule in the UI. Do not claim every checkbox was
independently verified through the integration.

## What model jobs can and cannot do

Each model job uses a fresh runner/session, `--restricted`, `--safe-mode`, no
project settings/skills/hooks, an empty strict MCP configuration, and no resume
or continue flag. Nested agent tools are denied. The review role exposes only
Read, Glob and Grep. The coding role additionally permits edits and a short
allowlist of local Yarn verification commands.

The configured job timeout bounds the entire agent job, including installation.
The CLI turn cap bounds the agent iteration loop; it is not an exact token cap.
Production URLs must not be used as targets for development/Cypress reset suites.

Normal agent patches are limited to regular text application/test files and
README. They cannot modify workflows, factory scripts/tests, agent instruction
files, dependencies/lockfiles, infrastructure, hidden configuration or secrets.
Those require a separate owner maintenance PR using the bounded existing-PR
review path above. A forbidden patch consumes its
coding reservation but is not published. The publisher never runs artifact code.

## Audit and recovery

`factory/state:state.json` contains daily admission sets, lifetime counters,
active ticket/run IDs, expected commit hashes, reservations, outcomes and audit
events. Git history preserves earlier snapshots. Only metadata controllers write
it; model jobs receive read-only GitHub tokens. Do not force-push, delete or edit
the ledger to clear a limit. The normal factory cannot silently recreate it.

Artifacts contain validated changed files/evidence or a bounded structured
review, not credentials or full model transcripts. GitHub retains them for seven
days. PRs, CI links, ledger commits, and model run links provide the longer audit
trail. Coding evidence is agent-authored and must be checked by CI and review;
its existence alone is not proof that a RED command really ran.

### Failed-session permission diagnostics

After a failed Claude step, the workflow attempts a diagnostic-only report.
Open **Preserve sanitized permission-denial diagnostics after a model failure**
in that job's logs, or download the separate
`diagnostic-<phase>-<grantId>` artifact within seven days. Its single file is
`factory-permission-denials.json`. It is never a code bundle or review approval.

The reporter reads the pinned action's `RUNNER_TEMP/claude-execution-output.json`
while the runner still exists. The action writes this file before throwing on a
failed session, so the reporter does not depend on outputs from the failed step.
The input is bounded to 8 MiB and at most 100 denial entries are retained, with
truncation recorded. Output contains only fixed tool names, descriptive command
categories/forms, stop reason and counts. It omits raw commands, arguments,
paths, prompts, transcript text, session IDs, credentials and raw exceptions.

Missing, unsafe, oversized or malformed data produces an explicit unavailable
report; missing denial information is not recorded as zero denials. An existing
output file is refused, not overwritten or uploaded as sanitized data. A report
or upload failure never changes the original model failure to success. Categories
do not decide tool permissions, and SDK-reported turn counts do not alter quotas.

The two exact denied calls from
[run #5](https://github.com/haideearus/cypress-realworld-app/actions/runs/43203237182)
cannot be recovered from its retained logs/artifacts. This feature records future
failures only. No agent rerun, permission change, quota increase or deployment is
authorized by preparing or installing it.

For a stop:

1. Set `FACTORY_ENABLED=false` to stop new runs. GitHub may snapshot variables for
   an already queued/running workflow: do not treat changing this variable as an
   instant stop of its later phases.
2. Run **Factory agents**, operation `cancel`, on `main`. This separate,
   owner-only metadata run can operate while disabled. It cancels the active
   run, waits for completion, marks unfinished reservations blocked, and releases
   the ticket lock. Its controller is not queued behind an entire model job.
3. If completion cannot be verified, the lock stays held. Use GitHub's Cancel
   workflow control, then retry the metadata cancel operation. For an emergency,
   revoke the Claude subscription token; do not paste it into issues or logs.

If publication partially succeeds but ledger persistence fails, a branch/PR may
exist without a recorded publication. Admission refuses an orphaned branch before
spending another attempt. Resolve that inconsistency through a reviewed owner
recovery operation; do not overwrite an unknown branch or reset counters.

## Verification and remaining work

Run `yarn test:factory`. The suite exercises the real policy/controller/worker
against fake GitHub HTTP responses and temporary local Git repositories. It
simulates model results and does not import an AI SDK or contact a model.
Required `verify` also runs the existing app types, lint, unit, production and
Cypress regression checks against disposable data.

The simulations do not prove account allowance, future model quality, App setup,
native App-created PR checks or cancellation of a real model job. Real owner-run
coding/review evidence is recorded above; unattended installation needs its own
controlled trial.

Automatic backlog scheduling and protected merging are prepared under #26 and
remain disabled until review, App installation and a successful controlled trial.
Monitoring, production environment approval/deploy hook, generic stale-run
recovery, repository-wide secret scanning and complete course hand-in evidence
remain later work. The application stays deployed while the factory is disabled;
merging an app repair does not deploy it while Render Auto-Deploy is off.

Sources: [Claude GitHub Action](https://code.claude.com/docs/en/github-actions),
[subscription tokens](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token),
[usage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans),
[GitHub workflow triggers](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
