# Issue #11 single-use recovery

The owner requested one combined recovery PR after saving the factory off.
Preparation does not execute the recovery, start a model/reviewer, merge or deploy.

## Evidence and limits

Issue #11 has two finished failed code grants, one normal retry, zero reviews
and no PR. Its criterion hash is unchanged. The 50-turn run retained ten Bash
denials and one Glob denial; raw calls were intentionally not retained.
The trusted prompt does not enumerate the five commands already preapproved by
the worker. We can close that instruction gap without claiming to know every
historical call or guaranteeing that guidance prevents every future denial.

The installed CLI help and official [CLI reference](https://code.claude.com/docs/en/cli-reference)
confirm that restricted mode retains tools explicitly named by `--tools`.
The official [permission reference](https://code.claude.com/docs/en/permissions)
describes noninteractive denials and compound-command matching. Preserve all
existing permission flags and tool rules.

## Approach

A single-use exception for the exact existing issue #11 history meets the
authorized scope. Raising the general coding/retry caps would affect every
ticket; resetting history would lose the audit trail. Those approaches are
outside this change.

- Add an explicit manual `recover` operation to Factory agents, using the same
  owner/main/event checks and existing disabled admission and cycle jobs.
- Only issue #11 with its fixed criterion hash, two exact finished blocked grant
  IDs/run IDs, coding=2, retries=1, reviews=0, blocked status, no PR and no active
  or pending work is eligible. Bind this decision to maintenance issue #18.
- Start from then-current main. Preserve the two old grants and original daily
  admission. Record coding=3, retries=1 and one separate consumed recovery
  record pointing to the new tagged code grant and the owner decision.
- The recovery is consumed when reserved, including failures or cancellations.
  Ordinary `run` still has two code attempts; repeat recovery and a fourth
  code attempt are refused. No automatic extra recovery is admitted.
- Existing publication, exact-head CI and fresh read-only review gates remain.
  Validation accepts the third attempt only with the exact recovery provenance.
  Lower budgets and the factory kill switch still stop pending execution.
- Add structured file-tool/command guidance to the prepared worker context.
  Inspection uses repository-relative Read/Glob/Grep. The coding role gets the
  same five bare yarn commands, one per call, and test locations those commands
  actually exercise. An approved action that remains blocked must be reported
  honestly rather than repeatedly retried or worked around.

## Unchanged boundaries

Claude Pro OAuth only; no paid AI APIs; 100 turns; 15-minute model job; five daily
ticket admissions; two normal coding attempts; two reviews; one normal retry;
one active ticket; existing tools, settings, artifact filtering and diagnostics.
No new credential, configuration variable or permission rule is introduced.
The optional recovery marker extends ledger v1 while retaining old state support.
Old trusted readers may fail closed on a recovered three-attempt record; execute
the operation only from newly merged main and do not reuse old workflow runs.

## Verification and later operation

Use the real policy, ledger/controller and prepared worker with synthetic
GitHub fixtures. Prove consumption, preservation, scope, tamper/replay refusal,
lowered budgets, disabled behavior and successful/changes-requested review paths.
Test the new manual workflow contract and unchanged CLI rules. No inference
test is part of preparation; prompt compliance remains a later runtime question.

After genuine independent review and a human merge, the owner may explicitly
dispatch `recover`, ticket `11`, on main once. That later operation is the
point at which the live ledger changes; restore the factory flag to false after
the whole workflow finishes.
