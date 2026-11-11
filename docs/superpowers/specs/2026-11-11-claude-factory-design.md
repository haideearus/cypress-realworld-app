# Claude agents and factory limits

Date: 2026-11-11, Europe/Bucharest

Status: design for owner review; no agent workflow installed or enabled.

Tracking ticket: https://github.com/haideearus/cypress-realworld-app/issues/6

## Intent and existing setup

Maintain the deployed Cypress Real World App through Claude coding sessions,
existing CI, and independent Claude review sessions. Haide follows the installation
one step at a time. Preserve the public application, Neon data, upstream license,
and current Factory CI. Do not deploy application changes in this work.

The owner reports saving the subscription secret, all variables below, and a
classic protection rule for main. GitHub's branch endpoint confirms main is
protected and `verify` is required with enforcement for everyone, sourced from
the GitHub Actions app. The detailed protection endpoint returned 403, so other
individual rule settings have not been independently verified through that
connection.

The owner confirmed Claude authentication reports `loggedIn=true`,
`authMethod=claude.ai`, and `subscriptionType=pro`. The owner also showed Usage
credits disabled with a zero balance. This work must not read the token value,
enable Usage credits, create an API key, or start a real model session while the
factory is disabled.

## Approach

Use GitHub Actions with Claude's documented subscription-token authentication.
The owner has chosen this approach by installing the Claude GitHub App and saving
`CLAUDE_CODE_OAUTH_TOKEN`.

The standard API-key workflow conflicts with zero paid AI API spending. A worker
that depends on the owner's laptop staying on conflicts with the winter-break
requirement. Neither is an implementation alternative for this installation.

Use separate controller, coding, publication, CI, and review jobs. Model jobs do
not receive production credentials or repository write permissions. Publication
jobs validate artifacts and do not execute agent-generated code.

## Configuration contract

| Repository variable | Installation value | Meaning |
| --- | --- | --- |
| FACTORY_ENABLED | false | Refuse every real model invocation during setup |
| FACTORY_MAX_TICKETS_PER_DAY | 2 | Distinct tickets first started per Bucharest calendar day |
| FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET | 2 | Lifetime coding invocations for a ticket |
| FACTORY_MAX_REVIEWS_PER_TICKET | 2 | Lifetime independent review invocations for a ticket |
| FACTORY_MAX_AUTOMATIC_RETRIES | 1 | One additional coding attempt, within the two-attempt cap |
| FACTORY_MAX_CONCURRENT_TICKETS | 1 | One active ticket through coding, CI, and review |
| FACTORY_TIMEZONE | Europe/Bucharest | Calendar used for the daily counter |
| FACTORY_RUN_TIMEOUT_MINUTES | 15 | Agent job wall-clock ceiling, not the existing CI timeout |
| FACTORY_MAX_TURNS_PER_RUN | 20 | Iteration ceiling for each coding or review session |
| FACTORY_APP_URL | https://haide-software-factory.onrender.com | Reserved for later live monitoring; agents do not test production |

Validate configuration as typed data. Missing, malformed, or increased limits
above this approved policy refuse model work. Lower limits can reduce work.
Concurrency remains one. A higher policy ceiling requires a reviewed policy
change and recorded owner decision. An absent enabled flag never means enabled.

These are workload limits. They do not reserve a number of subscription tokens
or guarantee that two complex tickets fit within Claude Pro's allowance. Do not
use an API-dollar estimate as a subscription spending meter.

## Credentials and spending boundary

Only the Claude model step receives `CLAUDE_CODE_OAUTH_TOKEN`, passed through the
action's `claude_code_oauth_token` input. Do not configure `anthropic_api_key`,
OpenAI credentials, Console billing, a cloud inference provider, or an API-key
fallback. Refuse model work if the execution environment selects an API-key or
third-party provider. No billing settings are changed by a workflow.

Keep provider Usage credits disabled. Subscription exhaustion stops work and
records a waiting/blocked result; it must not cause a purchase or a provider
fallback. The factory cannot change this account setting and cannot claim a
verified account-wide spending cap from a repository variable.

The controller and publisher use narrowly scoped GitHub job tokens, separate from
the Claude credential. No job receives Render, Neon, database, or live session
secrets. Use standard GitHub-hosted Ubuntu runners and no paid runner option.

## Ticket admission and durable state

Initial admission is an owner-started manual workflow taking a GitHub issue number.
After testing, the same controller can accept the approved `agent-ready` queue
from a schedule. Do not install an unrestricted public mention-trigger workflow.
An issue body, label supplied by an untrusted actor, fork PR, or comment cannot
authorize work. The repository and owner allowlist are trusted policy, not issue
text. The configured enabled flag still applies to manual runs and reruns.

Keep a durable JSON ledger on a dedicated `factory/state` branch. It contains:

- Daily ticket admission sets keyed by the configured calendar date.
- Per-ticket coding, review, and automatic-retry counters.
- The active ticket and phase, expected base/head commits, and reservation IDs.
- Run ID, run attempt, actor, timestamps, outcomes, and evidence links.

Only the controller writes this state. Serialize controllers and use a
fast-forward compare-and-update operation on the state branch to prevent lost
updates. State initialization is an explicit, model-free bootstrap operation;
missing or corrupt initialized state must not silently reset the counters.

Reserve a ticket slot and invocation before starting the corresponding model
job. A reserved or interrupted invocation remains consumed. Worker preflight
must match the reservation to the current run attempt and phase, preventing
GitHub's rerun-failed-jobs feature from reusing a prior grant without a new
reservation. A failed reservation write means zero model calls.

The active-ticket lock survives the wait for CI and independent review. New
controllers cannot start another ticket during that wait. Failed or timed-out
runs need an explicit recorded transition; a lock expiring must not let a still
running worker overlap a new ticket. Persisted attempt counters survive day
boundaries and restarting a workflow.

## Coding and publication

The coding job starts from the expected main/agent commit, with a fresh session
and no production access. Give it the ticket as untrusted data and trusted
repository instructions. Require a failing-before test for a bug, a focused
repair, and commands/evidence describing what passed and failed.

Apply the configured wall-clock and turn limits, disable nested agent spawning,
and validate the installed action/CLI version supports those controls. Disable
untrusted repository startup hooks and extra MCP/plugin configuration for model
jobs. Pin third-party actions and tool versions.

Coding produces a patch and evidence artifact. The publisher validates allowed
paths, patch size, regular files, expected commits, and secret-scan results.
Reject modifications to workflows, agent policy, the usage ledger, or deployment
configuration from normal application tickets. Harness changes use their own
reviewed maintenance PR. Never execute a patch or its instructions as publisher.

The publisher creates/updates a ticket-specific branch and PR. Account for
GitHub's documented GITHUB_TOKEN event restrictions: push events do not trigger
ordinary push workflows, and supported PR events can create runs that require a
human approval. Explicitly dispatch the existing CI at the published head and
verify its check is attached to that exact commit, so routine CI does not depend
on a human approving each automated PR run. Do not weaken branch protection to
get a CI result.

## Independent review and merge gate

After CI passes, reserve a review invocation and start a new read-only Claude
session. It receives the ticket criteria, base/head diff, surrounding source, and
CI evidence. Do not resume the coding conversation or supply its private
reasoning as review context. A second allowed review is another fresh session.

The reviewer has no patch-writing, shell execution, nested-agent, deployment, or
GitHub write tools. A trusted publisher validates the structured review result
and records its reviewed commit. Unknown verdict, malformed output, failed model
call, or stale head is not approval.

A deterministic `Factory review gate` check must require a successful independent
review of the current PR head. It cannot turn green merely because the model job
was skipped while disabled. New commits invalidate old review evidence. Add this
check to main's required checks only after its workflow has been installed and
tested; keep `verify` required throughout.

The gate covers every PR into main, including owner-authored PRs; it does not
have an automatic human-author bypass. A matching, previously recorded genuine
review can be verified while the factory is disabled, without a new model call.
An unreviewed PR remains blocked while disabled. This is intentional: the
disabled flag must not manufacture an independent review. Merge the installation
PR with its documented independent implementation review before adding this new
required check. The later enable/demo step provides the first genuine Claude
review. Explain this rollout order to the owner before making the check required.

For a failed CI or review finding, the controller may reserve the one additional
coding attempt, within both coding and retry caps, followed by the remaining
allowed fresh review. Exhaustion records blocked status rather than looping.
No automatic main merge is needed for the installation itself. Before any later
automatic merge, require both current CI and current-head review evidence and
use an expected-head SHA. No production deployment is part of this controller.

## Disabled state and installation tests

Keep FACTORY_ENABLED=false through all installation work. Do not test model
connectivity by quietly running a real Claude turn. Use a fake model executable
or fixture outputs to prove the controller can decide without provider access.

Required negative and positive tests include:

1. Disabled, missing flag, invalid configuration, or API-backed auth: zero model calls.
2. Third new ticket on the same Bucharest day: refused; next day's admission works.
3. Third coding attempt, third review, or second automatic retry: refused.
4. Rerun cannot reset or reuse an exhausted reservation.
5. Two controllers racing cannot reserve two active tickets or exceed a daily cap.
6. Unreadable, corrupt, or unwritable initialized ledger: refused.
7. Different PR head, skipped review, or malformed review: gate does not pass.
8. An untrusted issue/PR trigger is refused without model work.
9. A forbidden generated patch is not published; its coding invocation remains consumed.
10. An admitted fixture ticket progresses from coding through CI and a fresh review.
11. Subscription quota failure stops without an API fallback or repeated retries.

Fixture ledgers and fake review outputs are confined to tests. They must never
create genuine approval records in the production ledger or make a real PR's
independent-review gate pass.

Changing FACTORY_ENABLED=false prevents new model admissions. It is not an
instant cancellation mechanism for a request already running. Document an
owner-only cancel operation for active factory runs, with token revocation as
emergency recovery. Never claim that the variable alone is the complete kill
switch.

## Rollout and remaining coursework

Deliver one focused PR with deterministic tests and independent implementation
review. Keep the current required verify check green. Report what was simulated,
what ran on GitHub, and what has not been proved by a real model invocation.

After merging, guide the owner through making the review gate required. A real
ticket demonstration requires a later explicit enable decision; this installation
does not flip the variable. Human production approval, a protected production
deploy credential, live monitoring, and the full course evidence remain separate
work if they are not yet installed. Do not describe this PR as a completed
unattended ticket-to-production factory.

## Sources

- https://code.claude.com/docs/en/github-actions
- https://code.claude.com/docs/en/authentication#generate-a-long-lived-token
- https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans
- https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow

Action input names, version pins, GitHub check permissions, and isolated CLI
settings must be verified against primary documentation/source during the plan.
The builder may choose implementation filenames and test fixtures without
changing the owner-approved controls above.
