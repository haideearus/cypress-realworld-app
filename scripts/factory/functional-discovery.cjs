const { readFileSync } = require("node:fs");
const { GitHub, ROOT } = require("./github.cjs");
const { REPOSITORY, SHA, assertSubscriptionEnv } = require("./policy.cjs");
const { actorAllowed, runActorOK } = require("./discovery-contract.cjs");
const {
  CHECKS,
  WORKFLOW_PATH,
  PROBE_MODE,
  validAssertion,
  validateFunctionalResult,
} = require("./functional-discovery-contract.cjs");
const { MonitorStore } = require("./monitor-state.cjs");
const { monitorContext } = require("./app-checks-contract.cjs");
const { observeIncident } = require("./monitor.cjs");
const { writeSummary, issueLink, statusText } = require("./discovery-summary.cjs");

const CI_WORKFLOW = ".github/workflows/factory-ci.yml";

function assertContext(context) {
  if (
    context.repository !== REPOSITORY ||
    context.ref !== "refs/heads/main" ||
    context.workflowRef !== `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main` ||
    !SHA.test(context.workflowSha || "") ||
    context.sha !== context.workflowSha ||
    !/^[1-9]\d*$/.test(context.runId || "") ||
    context.runAttempt !== 1 ||
    !["schedule", "workflow_dispatch", "workflow_run"].includes(context.eventName) ||
    !actorAllowed(context.eventName, context.actor, context.triggeringActor)
  )
    throw Error("Untrusted functional discovery context");
}

async function assertCurrentMain(api, context) {
  const main = await api.request("GET", `${ROOT}/branches/main`);
  if (main.commit?.sha !== context.workflowSha)
    throw Error("Functional check is stale for current main");
}

function trustedPush(run, head) {
  return (
    Number.isSafeInteger(run?.id) &&
    run.id > 0 &&
    run.path === CI_WORKFLOW &&
    run.event === "push" &&
    run.head_branch === "main" &&
    run.head_sha === head &&
    run.repository?.full_name === REPOSITORY &&
    run.head_repository?.full_name === REPOSITORY &&
    run.run_attempt === 1 &&
    run.status === "completed" &&
    run.conclusion === "success"
  );
}

async function verifyCITrigger(api, context, event) {
  assertContext(context);
  const source = event?.workflow_run;
  const head = context.workflowSha;
  if (
    context.eventName !== "workflow_run" ||
    event?.action !== "completed" ||
    event.repository?.full_name !== REPOSITORY ||
    !trustedPush(source, head) ||
    event.workflow?.path !== CI_WORKFLOW ||
    !Number.isSafeInteger(source.workflow_id) ||
    source.workflow_id < 1 ||
    event.workflow.id !== source.workflow_id
  )
    throw Error("Untrusted functional discovery CI event");
  const attempt = `${ROOT}/actions/runs/${source.id}/attempts/1`;
  const [workflow, run, { jobs }] = await Promise.all([
    api.request("GET", `${ROOT}/actions/workflows/factory-ci.yml`),
    api.request("GET", attempt),
    api.request("GET", `${attempt}/jobs?per_page=100`),
  ]);
  if (
    workflow.path !== CI_WORKFLOW ||
    workflow.id !== source.workflow_id ||
    !trustedPush(run, head) ||
    run.id !== source.id ||
    run.workflow_id !== workflow.id ||
    run.actor?.login !== context.actor ||
    run.triggering_actor?.login !== context.triggeringActor ||
    !runActorOK(run, "workflow_run")
  )
    throw Error("Untrusted functional discovery CI run");
  const verify = Array.isArray(jobs) ? jobs.filter((job) => job.name === "verify") : [];
  if (
    verify.length !== 1 ||
    verify[0].run_id !== run.id ||
    verify[0].run_attempt !== 1 ||
    verify[0].head_sha !== head ||
    verify[0].status !== "completed" ||
    verify[0].conclusion !== "success"
  )
    throw Error("Untrusted functional discovery CI verify job");
}

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
  event,
  status,
  check,
  assertion,
  enabled,
  dryRun,
  store = new MonitorStore(api, "functional"),
}) {
  assertContext(context);
  if (
    typeof enabled !== "boolean" ||
    typeof dryRun !== "boolean" ||
    (context.eventName !== "workflow_dispatch" && dryRun)
  )
    throw Error("Untrusted functional discovery context");
  const observation = validateFunctionalResult(status, check, assertion);
  if (dryRun) return { outcome: "preview", observation, modelCalls: 0 };
  if (!enabled) return { outcome: "disabled", modelCalls: 0 };
  if (observation.status === "inconclusive") return { outcome: "inconclusive", modelCalls: 0 };
  if (context.eventName === "workflow_run") await verifyCITrigger(api, context, event);
  await assertCurrentMain(api, context);
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

function publicationSummary({ outcome, issue, observation }) {
  const link = issueLink(issue);
  const ticketLabel =
    outcome === "incident_created" ? "Ready ticket published" : "Existing functional incident";
  const failure = validAssertion(observation?.check, observation?.assertion)
    ? `- Confirmed finding — ${CHECKS[observation.check]} at \`${observation.assertion}\``
    : null;
  return [
    "## Functional finding publication",
    "",
    `- Outcome — ${statusText(outcome)}`,
    ...(failure ? [failure] : []),
    link ? `- ${ticketLabel} — ${link}` : "- No ticket published by this run.",
  ].join("\n");
}

async function main(env = process.env) {
  assertSubscriptionEnv(env);
  const api = new GitHub({ token: env.GITHUB_TOKEN });
  const context = monitorContext(env);
  const event =
    context.eventName === "workflow_run"
      ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"))
      : undefined;
  if (env.FACTORY_FUNCTIONAL_OPERATION === "verify-trigger") {
    await verifyCITrigger(api, context, event);
    await assertCurrentMain(api, context);
    return;
  }
  const result = await publishFunctional({
    api,
    context,
    event,
    status: env.FACTORY_FUNCTIONAL_STATUS,
    check: env.FACTORY_FUNCTIONAL_CHECK || "",
    assertion: env.FACTORY_FUNCTIONAL_ASSERTION || "",
    enabled: env.FACTORY_FUNCTIONAL_DISCOVERY_ENABLED === "true",
    dryRun:
      !["schedule", "workflow_run"].includes(context.eventName) &&
      env.FACTORY_FUNCTIONAL_DRY_RUN !== "false",
  });
  writeSummary(env, publicationSummary(result));
  console.log(JSON.stringify(result));
}

if (require.main === module)
  main().catch(() => {
    console.error(
      "Functional discovery held; inspect the workflow and retained publication intent."
    );
    process.exitCode = 1;
  });

module.exports = { publishFunctional, publicationSummary };
