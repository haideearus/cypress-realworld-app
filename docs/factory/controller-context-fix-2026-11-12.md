# Factory controller context repair

Maintenance ticket: [#8](https://github.com/haideearus/cypress-realworld-app/issues/8).
Base: `bd7dbc7abe0d1fbc8093aea0903be36b4df0b6b3` (merged PR #7).

The first [initialize run](https://github.com/haideearus/cypress-realworld-app/actions/runs/43186346006)
failed while GitHub loaded the composite action manifest:

```text
action.yml (Line: 51, Col: 28): Unrecognized named-value: 'vars'.
Located at position 8 within expression: toJSON(vars)
```

The controller did not execute, and all coding/review jobs were skipped. This
failure was in the workflow wiring, not the values entered by the owner.

## Repair

- Declare a required `variables_json` composite-action input. All eleven
  production controller calls pass `toJSON(vars)` from workflow scope. The
  action reads `inputs.variables_json`, a supported composite input context.
- Add a pure `validate` controller operation. It applies the existing typed
  configuration and subscription-only authentication checks, then returns
  without requiring a GitHub token, accessing the ledger, or invoking a model.
- Required `verify` now executes the actual composite action on GitHub with
  synthetic disabled configuration and read-only permissions. Earlier CI parsed
  the YAML and tested controllers but did not load this action through a runner.
  Actionlint had accepted the original manifest and alone is insufficient.
- Keep all limits, job permissions, required checks, model credentials, and
  deployment behavior unchanged. No repository variable or secret is edited.

GitHub's [composite-action design](https://github.com/actions/runner/blob/main/docs/adrs/1144-composite-actions.md#guiding-principles)
explains that actions receive needed values through inputs and have limited
context access. The failed run is direct evidence of this runner's restriction.

## Verification

Four regression checks were added before the repair. The affected test files
initially had **3 failures / 23 passes**: the unsupported context, missing real
action smoke check, and absent token-free validation operation failed. Existing
configuration/auth rejection checks already passed.

After repair, `yarn test:factory` passes **63 tests, 0 failures**. Local logs are
saved outside the repository as `../outputs/factory-vars-fix-{red,green}.log`.
The fix PR records actionlint, fresh independent review and final GitHub CI,
including the actual composite-action smoke result.

These tests and the smoke operation make no AI requests and perform no ledger
writes. Actual initialization with the owner's repository variables remains a
separate, manual post-merge check; it is not claimed by the CI smoke check.

## Resume the owner's setup

Keep `FACTORY_ENABLED=false` and Render Auto-Deploy off. Review and merge the fix
PR only after required `verify` passes and independent review is recorded.

Then start a **new** Factory agents run using branch `main`, operation
`initialize`, and empty ticket/PR inputs. Re-running the old failed run would use
its original revision and cannot demonstrate this repair. Initialization still
refuses to replace an existing ledger; no state deletion or counter reset is
part of this fix. Check initialization success and the actual `factory/state`
contents before continuing to the disabled-run proof.
