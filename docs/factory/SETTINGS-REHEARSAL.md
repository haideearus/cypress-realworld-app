# Step 5 Settings validation rehearsal

The rehearsal follows one browser finding through ticket publication, pickup,
coding, independent review, and a protected merge in a separate repository.
The bug changes the invalid-email message in Settings. The existing
`form-validation / settings-email-invalid` assertion detects it. The app uses
synthetic data and a disposable loopback PostgreSQL database on GitHub runners.

## Prepare the sandbox after setup review

1. From this checkout, generate a bundle into a new directory outside the
   checkout. The script exports the tracked application at the verified
   `7b7482f165c618b6b7188e2726e82242a62c5dcc` commit. It makes local files only.

   ```powershell
   node scripts/rehearsal/prepare-settings.cjs ../settings-rehearsal-bundle
   ```

2. Use a new standalone repository named
   `haideearus/cypress-realworld-app-settings-rehearsal`. Import **only** the
   `app` directory as a fresh Git repository with `main` as the default branch.
   The outer `settings-validation-seed.patch` stays outside Git. The export
   keeps the rehearsal workflows, removes schedules, Dependabot and Render
   deployment, scopes the GitHub App token to the sandbox, and sets the app URL
   to the reserved `https://settings-rehearsal.invalid` domain. Use a public
   sandbox with synthetic data if you use GitHub Free branch protection.
   [GitHub protected branch availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule)
3. Set these **sandbox** variables. The original repository keeps all four
   factory switches off throughout.

   | Variable                                 | Initial value                        |
   | ---------------------------------------- | ------------------------------------ |
   | `FACTORY_ENABLED`                        | `false`                              |
   | `FACTORY_AUTOMATION_ENABLED`             | `false`                              |
   | `FACTORY_AUTOMERGE_ENABLED`              | `false`                              |
   | `FACTORY_DISCOVERY_ENABLED`              | `false`                              |
   | `FACTORY_FUNCTIONAL_DISCOVERY_ENABLED`   | `false`                              |
   | `FACTORY_EVENT_PICKUP_ENABLED`           | `false`                              |
   | `FACTORY_PRIORITY_RETRY_ENABLED`         | `false`                              |
   | `FACTORY_MAX_TICKETS_PER_DAY`            | `1`                                  |
   | `FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET` | `1`                                  |
   | `FACTORY_MAX_REVIEWS_PER_TICKET`         | `1`                                  |
   | `FACTORY_MAX_AUTOMATIC_RETRIES`          | `0`                                  |
   | `FACTORY_MAX_CONCURRENT_TICKETS`         | `1`                                  |
   | `FACTORY_RUN_TIMEOUT_MINUTES`            | `15`                                 |
   | `FACTORY_MAX_TURNS_PER_RUN`              | `100`                                |
   | `FACTORY_TIMEZONE`                       | `Europe/Bucharest`                   |
   | `FACTORY_APP_URL`                        | `https://settings-rehearsal.invalid` |

4. Install a separate GitHub App on **only** the rehearsal repository. Use the
   repository permissions listed in [automatic pickup](AUTOMATIC-PICKUP.md).
   Save its Client ID in `FACTORY_GITHUB_APP_CLIENT_ID`, slug in
   `FACTORY_GITHUB_APP_SLUG`, and private key in `FACTORY_GITHUB_APP_PRIVATE_KEY`
   in the rehearsal repository. Use Claude Pro OAuth only, with
   Extra Usage off. Add `CLAUDE_CODE_OAUTH_TOKEN` only when ready for the separately
   authorized model trial. Keep production and paid API credentials out of the
   rehearsal repository.
5. Initialize the fresh ledger using **Factory agents → initialize**, and the
   wake registry using **Factory event wake → initialize** with **Preview**
   unchecked, both on the sandbox `main`. Create the `factory-ready` label. The
   functional incident registry initializes on its first recorded incident.

## Prove detection with no model calls

1. On healthy sandbox `main`, run **Safe functional discovery** with preview
   checked and save `outcome: preview`, `status: healthy`, and `modelCalls: 0`.
2. During initial sandbox setup, apply the seed patch to the sandbox app and
   commit it to sandbox `main`. Apply it only here and before protecting this
   new branch. The seeded revision deliberately fails the Settings check.

   ```powershell
   git apply --check ../settings-validation-seed.patch
   git apply ../settings-validation-seed.patch
   ```

3. Set protection on sandbox `main` with required PRs, `verify` and
   `Factory review gate` from GitHub Actions, and no bypass. Preserve the existing
   app and independent-review check implementations. The rehearsal CI runs the
   usual app checks and a focused subset of factory tests covering this lane.
4. Preview the seeded sandbox `main`. The existing browser runner requires two
   matching failures before it reports `confirmed_failure`. Check that the
   `check` is `form-validation`, the `assertion` is `settings-email-invalid`,
   and `modelCalls` is `0`. Stop on any other failure or an inconclusive result.

## Run only after explicit authorization

1. Verify the seed SHA is still sandbox `main`, both protections are set, and
   the rehearsal ledger and queue are empty. Enable the sandbox factory,
   automatic pickup, event pickup and functional discovery. Enable sandbox
   automatic merging only if the trial authorization covers it. The Claude-led
   discovery switch stays off because this test starts with a fixed browser check.
2. Dispatch one **Safe functional discovery** run without preview. Verify
   `incident_created` and capture the single issue number and source SHA. The
   wake workflow consumes this original successful publication run. Repeated
   incident observations reuse the issue and cannot replace the original wake
   source. With the seed still current, a second publication run should return
   `incident_existing` with the same issue number. Capture that evidence before
   the repair merges. A preview alone cannot establish ticket deduplication.
3. Follow the automatic coding and independent review to the candidate PR.
   Verify one coding attempt, one review, and zero retries. Require the
   Settings assertion to pass on the candidate after failing on the seed.
   Match both green required checks and the saved approval to the candidate SHA.
   If automatic merging was authorized, verify the merge job records the merge
   in the ledger. If merging is held or any proof is missing, stop and preserve
   the record for inspection.
4. Turn sandbox pickup, merging, event pickup and the factory back off. Preview
   the merged sandbox `main` and confirm `healthy` before closing the sandbox
   issue. A healthy recorded observation with the issue closed can release the
   sandbox incident slot. Disable sandbox functional discovery afterward.
   Retain the source, issue, PR, protections, run links, and counters as evidence.
   If the trial fails, cancel any active sandbox run and disable the sandbox
   switches. Keep its issue and evidence open for diagnosis.
