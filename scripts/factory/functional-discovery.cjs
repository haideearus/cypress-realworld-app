const fs = require("node:fs");
const { GitHub, ROOT } = require("./github.cjs");
const { REPOSITORY, OWNER, SHA, assertSubscriptionEnv } = require("./policy.cjs");
const {
  CHECKS,
  WORKFLOW_PATH,
  PROBE_MODE,
  validateFunctionalResult,
} = require("./functional-discovery-contract.cjs");
const { MonitorStore } = require("./monitor-state.cjs");
const { monitorContext } = require("./app-checks-contract.cjs");
const { observeIncident } = require("./monitor.cjs");

function renderIssueText(incident, { check, assertion }) {
  return {
    title: `Functional discovery: ${CHECKS[check]} failed`,
    body: `## Confirmed functional failure

The checked-in browser discovery suite reported the same failed assertion in two runs against a disposable app.

Check ID: ${check}
Failed assertion: ${assertion}

Tested main: ${incident.source.workflowSha}
Evidence: https://github.com/${REPOSITORY}/actions/runs/${incident.source.runId}

## Acceptance criteria

- Reproduce the named check on current main with synthetic data in a disposable app. Hold the ticket if it no longer fails.
- Fix the smallest application cause and show passing regression evidence. Preserve CI, independent review, and production approval.
- Keep the discovery checks and their evidence, harness, credentials, limits, and production data intact.
`,
  };
}

async function publishFunctional({
  api,
  context,
  status,
  check,
  assertion,
  enabled,
  dryRun,
  store = new MonitorStore(api, "functional"),
}) {
  if (
    context.repository !== REPOSITORY ||
    context.ref !== "refs/heads/main" ||
    context.workflowRef !== `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main` ||
    !SHA.test(context.workflowSha || "") ||
    context.sha !== context.workflowSha ||
    !/^[1-9]\d*$/.test(context.runId || "") ||
    context.runAttempt !== 1 ||
    !["schedule", "workflow_dispatch"].includes(context.eventName) ||
    context.actor !== OWNER ||
    context.triggeringActor !== OWNER ||
    typeof enabled !== "boolean" ||
    typeof dryRun !== "boolean" ||
    (context.eventName === "schedule" && dryRun)
  )
    throw Error("Untrusted functional discovery context");
  const observation = validateFunctionalResult(status, check, assertion);
  if (dryRun) return { outcome: "preview", observation, modelCalls: 0 };
  if (!enabled) return { outcome: "disabled", modelCalls: 0 };
  if (observation.status === "inconclusive") return { outcome: "inconclusive", modelCalls: 0 };
  const main = await api.request("GET", `${ROOT}/branches/main`);
  if (main.commit?.sha !== context.workflowSha)
    throw Error("Functional check is stale for current main");
  const result = await observeIncident({
    api,
    context,
    store,
    observation,
    probeMode: PROBE_MODE,
    issueText: renderIssueText,
  });
  return { ...result, modelCalls: 0 };
}

async function main(env = process.env) {
  assertSubscriptionEnv(env);
  const result = await publishFunctional({
    api: new GitHub({ token: env.GITHUB_TOKEN }),
    context: monitorContext(env),
    status: env.FACTORY_FUNCTIONAL_STATUS,
    check: env.FACTORY_FUNCTIONAL_CHECK || "",
    assertion: env.FACTORY_FUNCTIONAL_ASSERTION || "",
    enabled: env.FACTORY_FUNCTIONAL_DISCOVERY_ENABLED === "true",
    dryRun: env.GITHUB_EVENT_NAME !== "schedule" && env.FACTORY_FUNCTIONAL_DRY_RUN !== "false",
  });
  if (env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `## Safe functional discovery\n\n${JSON.stringify(result)}\n`
    );
  console.log(JSON.stringify(result));
}

if (require.main === module)
  main().catch(() => {
    console.error(
      "Functional discovery held; inspect the workflow and retained publication intent."
    );
    process.exitCode = 1;
  });

module.exports = { publishFunctional };
