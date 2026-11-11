# Free cloud deployment guide

## Decisions and current status

The target is a cloud deployment that works while the owner's laptop is off,
preserves newly created demo accounts and payment history, and has a budget of
USD 0 for additional hosting or API charges.

| Part                                    | Target                                               |
| --------------------------------------- | ---------------------------------------------------- |
| Code, tickets, checks, approval history | This public GitHub repository                        |
| Live frontend and Express API           | One Render Free web service                          |
| Durable application data                | Neon Free PostgreSQL                                 |
| Coding and review                       | Existing eligible Codex subscription where supported |
| Production deployment                   | GitHub environment approval by a named person        |

This is the deployment target, not a claim that it is already configured. The
production change is tracked in [ticket #2](https://github.com/haideearus/cypress-realworld-app/issues/2).
Local development still uses upstream's JSON file; production uses PostgreSQL.
Provider connection, public URL verification, and the approval gate are separate
setup steps. Never infer that they are active merely from committed configuration.

## 1. Connect Codex to this fork

Use the same ChatGPT account that has the Codex subscription.

1. Open [Codex code review settings](https://chatgpt.com/settings/code-review).
2. Connect GitHub if requested, and grant access to this repository.
3. Choose `haideearus/cypress-realworld-app` and enable automatic code review for
   it. Review the personal review trigger as well as the repository setting.
4. Configure a Codex Cloud environment for this repository. Its setup must use
   the Node version in `.node-version`, Yarn Classic `1.22.22`, and
   `yarn install --frozen-lockfile`. The repository's `AGENTS.md` describes tests.
5. Verify the review integration on a representative PR with `@codex review`.

Cloud coding tasks and built-in GitHub review use the eligible subscription's
Codex allowance. The `openai/codex-action` workflow is a separate route that uses
an OpenAI API key and API billing. The zero-additional-spend design does not
provision that key or assume that subscription access includes API usage.

Automatic review is one part of the factory. The unattended path from a detected
failure to a coding task still needs a supported trigger and an end-to-end test.
Local desktop schedules require the computer to remain on; they are not the
chosen winter-break solution.

Sources: [GitHub review](https://learn.chatgpt.com/docs/third-party/github),
[Codex pricing and usage](https://learn.chatgpt.com/docs/pricing), and
[Codex GitHub Action](https://learn.chatgpt.com/docs/github-action).

## 2. Create the free database account

1. Sign up at [Neon](https://neon.com/) and retain the **Free** plan.
2. Create a project called `software-factory-rwa`, using a European region close
   to the app's hosting region.
3. Keep scale to zero enabled. Use the smallest compute size available; cap
   autoscaling at that size if the console provides that option.
4. Keep the connection string private. Enter it in the host's secret environment
   settings when the production change is ready, under `DATABASE_URL`.
5. Record the actual compute, storage, and transfer quotas displayed by the
   account. Configure consumption limits where available and observe usage.

At verification on 2026-11-11, Neon advertised 100 CU-hours per month and 1 GB
storage per Free project, with no credit card required. Free quotas can suspend
the database when exhausted; they do not guarantee uninterrupted operation.

Sources: [Neon Free plan](https://neon.com/pricing) and
[Neon plans](https://neon.com/docs/introduction/plans).

## 3. Prepare the app for production

The production maintenance PR implements these changes:

- Route browser API requests to the deployed API instead of the visitor's
  `localhost:3001`.
- Serve the built frontend and API from one public service, with the host's
  `PORT` and a production startup command.
- Store application data in PostgreSQL, initialize synthetic demo data only
  when needed, and preserve data across process restarts and deployments.
- Use an environment-managed session secret and a suitable session store.
- Keep database reset/test routes disabled in production and add a health check.
- Add regression coverage for the reported password-hash response leak before
  exposing the app publicly.
- Verify persistence by creating data, restarting the service, and checking that
  the data remains. Run destructive test fixtures against disposable test data.

`yarn start` and `yarn dev` remain development scripts that reseed local data.
Production uses these commands instead:

```shell
yarn install --frozen-lockfile --production=false
yarn build:production
yarn start:production
```

The build emits the website to `dist/client` and compiles the Node server to
`dist/server`. Startup neither launches Vite nor runs a development seed script.
The frontend calls `/api` on the same origin. `/healthz` reports the release,
and `/readyz` checks database connectivity; neither returns secrets.

Production requires `DATABASE_URL` (private PostgreSQL URI), `SESSION_SECRET`
(at least 32 random characters), and `APP_ORIGIN` (the exact HTTPS origin, with no
trailing slash). Render's `RENDER_EXTERNAL_URL` supplies the origin automatically
when `APP_ORIGIN` is absent. Render supplies `PORT`; the default is 10000.
Never put secrets in `VITE_*` variables: those become public browser code.

PostgreSQL stores the application's JSON state in one `rwa_state` row, plus
login sessions in `rwa_sessions`. Seed data is inserted only if the state row is
absent. Each API request acquires a row lock, refreshes stale state, runs the
upstream business logic, and commits before its response is sent. Failed requests
roll back. This deliberately serializes requests for a small teaching demo; a
busy multi-user service would need a relational persistence redesign.

Run production integration tests against a **disposable** PostgreSQL database
whose name ends in `_test`. Set `TEST_DATABASE_URL` privately in your shell,
then run `yarn test:production` after the production build. These tests drop demo
tables and must never use the deployed database.

## 4. Configure Render after the production PR

1. Sign up at [Render](https://dashboard.render.com/) and connect this GitHub fork.
2. Choose **New -> Blueprint**, select this fork and branch `main`, and use
   `render.yaml` after the production PR is merged. It declares one **Free** Node
   service in Frankfurt, and no paid disks or Render databases.
3. Enter Neon's connection URI as the private `DATABASE_URL` value when asked.
   Enter the storage values from the private `.env.local` file as
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_ENDPOINT_URL_S3`.
   `AWS_REGION` is `eu-central-1` for this project's Frankfurt region. These are
   Neon's storage credentials; no separate AWS account is needed.
   Retain the automatically generated `SESSION_SECRET` across deployments; changing
   it logs everyone out. The Blueprint sets `NODE_ENV=production`, skips downloading
   the unused Cypress browser on Render, and installs build dependencies.
4. Check the exact commands before creating the service:
   build `yarn install --frozen-lockfile --production=false && yarn build:production`;
   start `yarn start:production`; health check `/healthz`.
5. Confirm **Auto-Deploy: Off** and **Free** before the first deployment. Creating
   a Blueprint can trigger its initial deployment: that action is itself the
   named human approval until the GitHub production environment is installed.
6. Open the generated HTTPS `onrender.com` URL. Log in with the synthetic demo
   account `Heath93` / `s3cret`, change a profile field or make a fake payment,
   then restart the service and verify both the change and session remain.
7. Check `/healthz` and compare its `release` with the approved Git commit.
   Record the URL, revision, approval actor/time, and persistence result in the
   deployment evidence. A green local test is not evidence of a public deployment.

Render Free sleeps after inactivity and may take about a minute to wake up.
Monitoring must allow for this and retry before treating a cold start as a fault.
The database is external because the Free service's local files disappear on
restart. Render's Free PostgreSQL expires after 30 days, so it is not the chosen
database for the winter break.

Sources: [Render Free limits](https://render.com/docs/free) and
[deployment controls](https://render.com/docs/deploys).

## 5. Enforce spending and usage limits

These are required setup checks, not settings already applied by this document:

| Service        | Additional-spend control                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Render         | Free service; no payment method; monitor build, bandwidth, and instance-hour quotas                                                                         |
| Neon           | Retain Free plan; monitor quotas and consumption limits; no paid upgrade                                                                                    |
| GitHub Actions | Standard hosted runners for the public repo; configure a USD 0 budget with stop-usage enabled for chargeable Actions usage                                  |
| Codex          | Use existing subscription allowance; inspect paid-credit settings and available credit balance; no extra credit purchase or separate paid API configuration |

Render documents suspension/build blocking on quota exhaustion when no payment
method is present. GitHub's spending alerts and its stop-usage budget option are
different controls; select the option that actually stops chargeable usage.

Codex subscription allowance depends on the model and work performed. It is not
a fixed monthly token count that can be inferred from the subscription price.
Use the [usage dashboard](https://chatgpt.com/codex/settings/usage) to see the
account's actual remaining allowance and reset times. Existing purchased credits
may be consumed after included usage, so check that balance before enabling
unattended work.

The factory also needs bounded concurrency, repair attempts, run time, and task
frequency, plus usage records and a kill switch. Exact token ceilings must be
enforced by the selected runner when it supports them; a sentence in a prompt
does not establish a hard token or spending cap. Until the unattended runner and
account controls have been tested, its cost cap is **pending**.

### Proposed starting limits

| Activity                      | Proposed limit                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------ |
| Non-AI synthetic monitoring   | Approximately every 30 minutes; allow for cold starts                          |
| Concurrent coding work        | 1 active repair ticket                                                         |
| Newly admitted repair tickets | 2 per day                                                                      |
| Coding attempts               | At most 2 per ticket                                                           |
| Coding job duration           | At most 20 minutes per job                                                     |
| Review                        | One fresh reviewer for each proposed repair revision, within the attempt limit |
| Additional paid API usage     | USD 0                                                                          |

These values are a proposed starting policy, not an active enforcement mechanism.
On an AI limit, monitoring continues and incidents remain queued until the quota
resets. Deduplicate repeated failures so the same incident does not create a new
AI task at every check. The application keeps serving users within its hosting
quotas. Hosting quota exhaustion can suspend the app independently of the AI
limit, so both sets of limits need monitoring.

Sources: [Render quota behavior](https://render.com/docs/free),
[GitHub budgets](https://docs.github.com/en/billing/concepts/budgets-and-alerts),
and [Codex usage](https://learn.chatgpt.com/docs/pricing).

## 6. Connect the approved deployment

Create a GitHub environment called `production` with a named required reviewer.
Keep the Render deploy hook in that environment's secrets. A trusted deployment
job must wait for approval, deploy the exact checked commit, and verify the live
app. Record the ticket, commit, approving person, deployment, and smoke-test
result. Scheduled synthetic traffic can then report failures back to Issues.

Sources: [GitHub environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
and [Render deploy hooks](https://render.com/docs/deploy-hooks).
