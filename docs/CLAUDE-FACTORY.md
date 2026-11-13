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
6. Only a failed CI result or a valid review requesting changes can reserve the
   second coding attempt. Provider errors and interrupted model jobs stop work.

The initial version has no cron, public mention triggers, automatic main merge,
or production deployment. Those are later rollout steps. Do not call this an
already unattended ticket-to-production factory.

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
- `claude-sonnet-5` is the configured subscription model. Real account access and
  the action/SDK invocation remain unproved until a later authorized real run.
- A Pro allowance is not unlimited and is shared with other Claude use. The
  counters below limit work, not exact tokens or a promised dollar allowance.
  Exhaustion must wait rather than buy usage.
- Standard Ubuntu GitHub-hosted runners are used. This PR does not change GitHub,
  Render, or Neon billing settings or claim a verified account-wide spending cap.

## Limits and counter meanings

| Variable                               | Approved installation value                 |
| -------------------------------------- | ------------------------------------------- |
| FACTORY_ENABLED                        | false                                       |
| FACTORY_MAX_TICKETS_PER_DAY            | 5                                           |
| FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET | 2                                           |
| FACTORY_MAX_REVIEWS_PER_TICKET         | 2                                           |
| FACTORY_MAX_AUTOMATIC_RETRIES          | 1                                           |
| FACTORY_MAX_CONCURRENT_TICKETS         | 1                                           |
| FACTORY_TIMEZONE                       | Europe/Bucharest                            |
| FACTORY_RUN_TIMEOUT_MINUTES            | 15                                          |
| FACTORY_MAX_TURNS_PER_RUN              | 100                                         |
| FACTORY_APP_URL                        | https://haide-software-factory.onrender.com |

The daily counter records distinct tickets when first admitted, using Bucharest
calendar dates. It does not reset lifetime per-ticket counters at midnight.
It includes owner PR review tickets and limits new ticket admissions, not total
AI sessions. A ticket's coding and review sessions use its separate lifetime caps.
Two coding attempts means the initial attempt plus one retry, not three attempts.
Two reviews is a maximum across both attempts, not two reviews per attempt.

The active-ticket lock spans coding, CI and review. Every reservation remains
consumed even if a job is interrupted or refused before calling the model.
Rerunning failed jobs cannot reuse a successful admission output: the new run
attempt must match a new committed reservation. Recovery never refunds usage.

An existing owner PR uses the same admission/day counter and lifetime review
allowance. It reserves one review before CI, takes the same lock, and records
zero coding invocations. Failed CI consumes that reservation without invoking
Claude. It cannot turn a coding ticket into a new review-only ticket or refund
usage by switching modes.

Configuration is mandatory and typed. Increasing a limit above the approved
ceiling, malformed values, a different timezone, or concurrency other than one
refuses work. Lower limits may reduce work. Policy increases need a reviewed
harness change and an owner budget decision.

Merged PR #15 established **50 turns per session** and **five new tickets per
Bucharest calendar day**. The owner subsequently requested **100 turns per
coding or review session** in ticket #16, implemented by merged PR #17.
Lower values, including 20 and 50,
remain valid; values above 100 turns or five daily tickets are rejected.
The 15-minute model-job timeout remains in place, so a session can stop before
using 100 turns. Higher limits can consume more of the shared Claude Pro
allowance; this is not a token or dollar budget.

The current installation uses `FACTORY_MAX_TURNS_PER_RUN=100` and
`FACTORY_MAX_TICKETS_PER_DAY=5`. Keep `FACTORY_ENABLED=false` during recovery
preparation. The recovery change requires no additional limit variables or
changes to the existing settings.

This ceiling change does not authorize another execution, widen tool
permissions, or reset existing attempt and review counters.

The second issue #11 coding attempt in
[run 43391969547](https://github.com/haideearus/cypress-realworld-app/actions/runs/43391969547)
reached the configured 50-turn ceiling. Its retained sanitized diagnostic
reported 11 permission denials: ten Bash and one Glob. Those labels do not
identify the raw denied commands. Raising the turn ceiling does not grant
permission for denied actions.

Issue #11 is now blocked with **two coding attempts, one retry and zero
reviews**, and no published PR. Its coding budget is exhausted across
calendar days. Do not rerun it, reinitialize the ledger, reset its counters or
use a replacement admission to bypass that budget. Any further execution needs
a separately reviewed recovery decision; the recurring permission denials
also need investigation. Keep the factory off during this preparation.

### One owner-controlled recovery of issue #11

The recovery in maintenance issue #18 is an explicit, single-use exception for
the exact recorded history. The proposed `recover` operation becomes available
only after its PR is independently reviewed and merged. Ordinary `run` remains
exhausted for this ticket.

- Eligibility is pinned to issue #11's criterion hash and the two specific
  finished blocked grants. Changed criteria, another ticket, a PR already
  published, active work or changed failed-grant history refuses recovery.
- Admission records the third coding attempt plus a separate `recovery`
  object containing the decision and consumed grant ID. Both failed grants,
  the first daily admission and the existing normal retry count of one remain.
- This one extra attempt is consumed at reservation, even after failure,
  cancellation, a skipped job or unavailable subscription. A fourth code
  attempt and repeat recovery are refused; cancellation cannot refund it.
- The new attempt starts from current main and uses the existing publisher,
  exact-head CI and independent reviewer. No tool permission or general
  coding/retry quota increases.

After genuine review and human merge, the owner may run one controlled workflow:

1. Keep turns at `100`, daily tickets at `5`, and other settings unchanged.
2. Enable the factory, then choose **Actions → Factory agents → Run workflow**.
3. Select branch `main`, operation `recover`, ticket `11`, and leave PR empty.
4. Start once and restore `FACTORY_ENABLED=false` after the whole workflow
   finishes, including failure or cancellation. Preserve the ledger.

Older workflow revisions cannot read the new recovered three-attempt state.
Use newly merged main and new dispatches; old revisions fail closed.

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
   remains a trusted metadata refresh entry; its custom API report is named
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
only the separate read-only review role and refresh the native review gate. There
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

After genuine approval, the trusted controller can rerun the matching failed
native gate once, using that gate's original eligible pull-request event. It
matches the fixed workflow path, repository, head repository, PR and SHA, rechecks
the current PR before writing, and never restarts a cancelled run or a second
attempt. It cannot rerun Factory agents or dispatch another model. Only trusted
assessment/refresh jobs request the necessary Actions write permission; model
permissions and all usage limits stay unchanged. The informational custom check
uses a different name to avoid competing with the required native job.

For **PR #19 only**, the trusted controller on main predates this repair. The
changed head invalidates its old review. Keep the factory false until a fresh
review is separately authorized. After that review, restore the flag to false,
open the failed **Factory review status** run for the new head and select
**Re-run failed jobs**. This reruns only the metadata gate, not Factory agents.
After merge the new controller performs this bounded refresh automatically.
Do not remove a required check or transfer the old approval to the new head.

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

Real GitHub subscription authentication, actual Claude coding/review quality,
the account's remaining allowance, an enabled live ticket, and cancellation of a
real model job are deliberately not claimed by these simulations. Demonstrate
them later with the owner's explicit enable decision.

Automatic backlog scheduling, monitoring, automatic merge policy, production
environment approval/deploy hook, repository-wide secret scanning, and complete
course hand-in evidence remain later work. The application stays deployed while
the factory is disabled.

Sources: [Claude GitHub Action](https://code.claude.com/docs/en/github-actions),
[subscription tokens](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token),
[usage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans),
[GitHub workflow triggers](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
