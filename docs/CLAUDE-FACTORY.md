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
   commit. A deterministic **Factory review gate** checks the saved proof.
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
| FACTORY_MAX_TICKETS_PER_DAY            | 2                                           |
| FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET | 2                                           |
| FACTORY_MAX_REVIEWS_PER_TICKET         | 2                                           |
| FACTORY_MAX_AUTOMATIC_RETRIES          | 1                                           |
| FACTORY_MAX_CONCURRENT_TICKETS         | 1                                           |
| FACTORY_TIMEZONE                       | Europe/Bucharest                            |
| FACTORY_RUN_TIMEOUT_MINUTES            | 15                                          |
| FACTORY_MAX_TURNS_PER_RUN              | 20                                          |
| FACTORY_APP_URL                        | https://haide-software-factory.onrender.com |

The daily counter records distinct tickets when first admitted, using Bucharest
calendar dates. It does not reset lifetime per-ticket counters at midnight.
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
4. To register/check the merge gate, run **Factory independent review gate** for
   an open PR number. With no genuine review record it must post a **failing**
   `Factory review gate` check. This is an expected refusal, not a real AI review.
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
only the separate read-only review role and publish the same review gate. There
is no coding/publishing job or automatic retry in this path. If changes are
requested, update that PR and explicitly request another review within the two
review lifetime cap. A head change invalidates prior approval. This operation is
also disabled by `FACTORY_ENABLED=false`; it is not a human-author bypass.

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
