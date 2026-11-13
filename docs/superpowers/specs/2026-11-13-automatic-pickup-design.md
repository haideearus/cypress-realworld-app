# Automatic pickup and protected merging

Owner request: finish stages 2–3 after merging PR #25. The owner selected a repository-only GitHub App. Maintenance scope: #26. Base: `712401a59fe9e49fd0bc830e7c705a225cab928e`.

## Design

A new `factory-automatic.yml` entry checks the queue at minutes 17/47 each hour. Its manual mode defaults to a read-only preview. Live admission requires both `FACTORY_ENABLED=true` and `FACTORY_AUTOMATION_ENABLED=true`. Merge additionally requires `FACTORY_AUTOMERGE_ENABLED=true`; all remain false during installation.

Only the oldest open owner-created issue labelled `factory-ready` and absent from the ledger qualifies. Existing blocked/exhausted/reviewed tickets do not restart automatically. Existing pending automatic merges are reconciled before newer work is admitted. All five existing cycles run under the same root run identity, preserving reservations, correlation and single-ticket locking.

Scheduled authorization retains the owner actor/triggering actor and requires this repository, main, the exact new workflow ref and a valid workflow SHA. Manual authorization remains unchanged. Trusted runtime context gains workflow identity fields; no actor rewriting is permitted.

Automatically admitted records persist workflow/App provenance. Job-scoped App tokens are minted in trusted control jobs through pinned `actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510`. Explicit repository scoping, configured slug validation, minimum permissions and job-end revocation apply. The App connection is checked before admitting a model session. Publication has no unattended fallback. Private key/write tokens are never forwarded to model or PR-code jobs.

The merger handles only automatic factory application tickets. It verifies current identity and head, ledger approval and correlated CI, both native required checks from GitHub Actions, and actual clean merge state. It may refresh only the trusted native metadata review-status workflow after genuine approval. Expected-head API merging, durable intent/result and reconciliation of uncertain responses make repeated ticks safe. Branch protection remains authoritative.

## Public configuration and secret

- `FACTORY_AUTOMATION_ENABLED=false`
- `FACTORY_AUTOMERGE_ENABLED=false`
- `FACTORY_GITHUB_APP_CLIENT_ID`
- `FACTORY_GITHUB_APP_SLUG`
- Secret `FACTORY_GITHUB_APP_PRIVATE_KEY`, entered only into GitHub.

No other usage limits change. Claude subscription OAuth is the sole model credential. This change neither deploys production nor adds incident monitoring. Those remain later stages with named human production approval.

## Evidence and rollout

Write failing behavior tests before implementation; verify new guards and legacy history together. Run factory/unit/types/lint/actionlint and ordinary CI. Keep the factory disabled while code and App setup are reviewed. A genuine fresh Claude Pro review precedes merge. Then configure the one-repository App, run preview, and request one controlled end-to-end ticket with automatic merging.

Public-repository schedules can disable after 60 inactive days and runs can be delayed; included Pro quotas and free-provider quotas can stop execution. App-created native checks must actually be observed running without manual approval before claiming unattended operation.
