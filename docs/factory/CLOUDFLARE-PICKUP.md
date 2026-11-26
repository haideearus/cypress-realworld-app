# Cloudflare pickup timer

The timer requests an **Automatic factory** queue check at minutes
`03, 13, 23, 33, 43, 53` each hour. It sends one GitHub request per tick.
The existing pickup code handles app tickets and, after a verified idle app
check, lets **Factory event wake** look for dependency work. GitHub still
controls when the runner starts.

The timer is opt-in. It requires the existing single-ticket limit and shares
the factory ledger lock. GitHub deduplicates overlapping timer and native cron
checks created in the same ten-minute window. Issue and CI events still wake
the factory immediately. Each tick can select a ticket, reconcile a merge,
report that the slot is busy or the queue is empty, or record why evidence was
held. Any selected work must still pass the usual factory gates.

## Set up after merge

1. On GitHub, open **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token** while signed in as the repository
   owner `haideearus`. Use a name such as `Cloudflare factory pickup`, set an
   expiration you can rotate before, and select **Only select repositories →
   cypress-realworld-app** under repository access. Grant **Actions: Read and
   write**. GitHub adds **Metadata: Read** automatically. Actions write applies
   to the selected repository. This owner credential can dispatch other
   workflows and manage workflow runs there. Keep the token in Cloudflare's
   encrypted Worker secret. [GitHub token settings](https://github.com/settings/personal-access-tokens/new)
2. Use an account on **Cloudflare Workers Free**. In PowerShell at the root of
   your updated local copy of `cypress-realworld-app`, run these commands. The
   deploy reads the cron from `wrangler.toml`. The Worker has no public URL.

   ```powershell
   Set-Location .\ops\cloudflare-pickup
   npx --yes wrangler@4 login
   npx --yes wrangler@4 deploy
   npx --yes wrangler@4 secret put GITHUB_DISPATCH_TOKEN
   ```

   Paste the fine-grained token only into the Wrangler secret prompt.

3. In Cloudflare **Workers & Pages → haide-factory-pickup**, check **Settings →
   Triggers** for `3,13,23,33,43,53 * * * *`. Open **Observability → Logs** and
   wait for a `requested` entry. While the GitHub opt-in is absent or false, the
   matching GitHub run's **Check the pickup timer** step reports `disabled` if
   factory pickup is on. If factory pickup is off, GitHub skips the entire
   `pick` job. Cron changes may take up to 15 minutes to propagate.
4. When ready, in the main repository open **Settings → Secrets and variables →
   Actions → Variables**. Confirm `FACTORY_MAX_CONCURRENT_TICKETS=1`.
   `FACTORY_ENABLED` and `FACTORY_AUTOMATION_ENABLED` must already be true for
   pickup. `FACTORY_EVENT_PICKUP_ENABLED` must already be true for the
   dependency handoff. Add the repository variable
   `FACTORY_EXTERNAL_PICKUP_ENABLED` with value `true`.
   [Main repository Actions variables](https://github.com/haideearus/cypress-realworld-app/settings/variables/actions)
5. Check the next two ticks. Cloudflare should log one `requested` entry per
   tick. In **Automatic factory**, open the matching **timer** run and read the
   summary. A duplicate means a pickup check already started in that window.
   When there is eligible work, the existing worker can start Claude Pro under
   its normal limits. Keep Claude Extra Usage off.
   [Automatic factory history](https://github.com/haideearus/cypress-realworld-app/actions/workflows/factory-automatic.yml)

To pause the external timer, set `FACTORY_EXTERNAL_PICKUP_ENABLED=false`.
To stop the calls from Cloudflare too, change `crons` to `[]` in your deployed
Wrangler configuration and run the same `wrangler deploy` command. The issue
and CI event wakes and GitHub's native fallback schedule continue under their
own switches. When rotating the GitHub token, replace the Worker secret with
the same `wrangler secret put` command.
