const fs = require("node:fs");
const { createHash, randomUUID } = require("node:crypto");
const { GitHub, ROOT } = require("./github.cjs");
const { REPOSITORY, OWNER, SHA, assertSubscriptionEnv } = require("./policy.cjs");
const { MonitorStore, MAX_INCIDENTS, MAX_CREATIONS_PER_DAY } = require("./monitor-state.cjs");
const { MONITOR_WORKFLOW } = require("./monitor-origin.cjs");
const { probeApp } = require("./monitor-probe.cjs");
function assertMonitorContext(context) {
  if (
    context.repository !== REPOSITORY ||
    context.ref !== "refs/heads/main" ||
    context.workflowRef !== `${REPOSITORY}/${MONITOR_WORKFLOW}@refs/heads/main` ||
    !SHA.test(context.workflowSha || "") ||
    context.sha !== context.workflowSha ||
    !/^[1-9]\d*$/.test(context.runId || "") ||
    context.runAttempt !== 1 ||
    !["schedule", "workflow_dispatch"].includes(context.eventName) ||
    context.actor !== OWNER ||
    context.triggeringActor !== OWNER
  )
    throw new Error("Untrusted monitor context");
}
function validateObservation(observation) {
  const checks = observation?.checks;
  if (
    typeof observation?.healthy !== "boolean" ||
    !checks ||
    Object.keys(checks).sort().join(",") !== "frontend,health,readiness" ||
    Object.values(checks).some((value) => !["ok", "failed"].includes(value)) ||
    observation.healthy !== Object.values(checks).every((value) => value === "ok") ||
    !Number.isInteger(observation.attempts) ||
    observation.attempts < 1 ||
    observation.attempts > 3 ||
    (observation.release !== undefined && !SHA.test(observation.release))
  )
    throw new Error("Invalid monitor observation");
  return {
    healthy: observation.healthy,
    checks: { ...checks },
    attempts: observation.attempts,
    ...(observation.release ? { release: observation.release } : {}),
  };
}
function issueText(incident, observation) {
  return {
    title: "Production monitor: investigate failed public checks",
    body: `## Observed incident\n\nThe fixed public production probes failed after bounded cold-start retries.\n\nIncident: ${incident.id}\nObserved at: ${incident.at}\nChecks: health=${observation.checks.health}; readiness=${observation.checks.readiness}; frontend=${observation.checks.frontend}.\nEvidence: https://github.com/${REPOSITORY}/actions/runs/${incident.source.runId}\n\n## Bounded maintenance task\n\nInvestigate the application cause using repository code and disposable local tests. A provider outage, free-plan quota, cold start, credential problem or configuration issue may have no code fix. If so, stop with evidence and request owner attention; do not invent a repair.\n\nFor a reproducible application bug, demonstrate a failing regression test, implement the smallest repair and show it passing. Preserve independent review, existing scope restrictions and named human production approval.\n\nDo not change the harness, limits, hosting plan, credentials or production data. Do not run database-seeding tests against production. Do not enable paid APIs. Do not edit this issue's title or body after admission; put additional observations in comments.\n\n## Acceptance criteria\n\n- Explain the reproducible application failure or the evidence for an operator/provider issue.\n- For code changes, preserve failing-before and passing-after test evidence and relevant existing tests.\n- No unverified recovery claim: deployment still requires the owner's approval and public checks afterward.\n`,
  };
}
async function monitor({
  api,
  context,
  enabled = false,
  dryRun = true,
  store = new MonitorStore(api),
  probe = probeApp,
  now = () => new Date().toISOString(),
}) {
  assertMonitorContext(context);
  if (typeof enabled !== "boolean" || typeof dryRun !== "boolean")
    throw new Error("Invalid monitor switches");
  if (!enabled && !dryRun) return { outcome: "disabled" };
  const observation = validateObservation(await probe());
  if (dryRun) return { outcome: "preview", observation };
  const at = now();
  if (
    typeof at !== "string" ||
    !Number.isFinite(Date.parse(at)) ||
    new Date(at).toISOString() !== at
  )
    throw new Error("Invalid monitor time");
  const { state, commit } = await store.read();
  const active = state.active && state.incidents[state.active];
  if (active?.phase === "pending")
    return { outcome: "publication_needs_owner_recovery", incident: active.id, observation };
  if (active) {
    const issue = await api.request("GET", `${ROOT}/issues/${active.issue}`);
    if (
      issue.number !== active.issue ||
      !["open", "closed"].includes(issue.state) ||
      issue.pull_request
    )
      throw new Error("Monitor issue identity changed");
    const changed = active.recovered !== observation.healthy;
    active.recovered = observation.healthy;
    if (observation.healthy && issue.state === "closed") state.active = null;
    if (changed || state.active === null) await store.save(state, commit);
    return {
      outcome: observation.healthy ? "recovered" : "incident_existing",
      issue: active.issue,
      observation,
    };
  }
  if (observation.healthy) return { outcome: "healthy", observation };
  if (Object.keys(state.incidents).length >= MAX_INCIDENTS)
    return { outcome: "registry_needs_owner_maintenance", observation };
  const day = at.slice(0, 10);
  if (
    Object.values(state.incidents).filter((item) => item.day === day).length >=
    MAX_CREATIONS_PER_DAY
  )
    return { outcome: "incident_creation_limit", observation };
  const incident = {
    id: randomUUID(),
    at,
    day,
    phase: "pending",
    recovered: false,
    source: {
      runId: context.runId,
      runAttempt: context.runAttempt,
      workflowSha: context.workflowSha,
    },
    criteriaHash: "",
    issue: null,
  };
  const text = issueText(incident, observation);
  incident.criteriaHash = createHash("sha256")
    .update(JSON.stringify([text.title, text.body]))
    .digest("hex");
  state.active = incident.id;
  state.incidents[incident.id] = incident;
  // Durable intent precedes the one non-idempotent operation. Never retry an
  // ambiguous POST or discard its receipt to obtain another repair allowance.
  const intentCommit = await store.save(state, commit);
  const created = await api.request("POST", `${ROOT}/issues`, {
    ...text,
    labels: ["factory-ready"],
  });
  if (
    !Number.isSafeInteger(created.number) ||
    created.number < 1 ||
    created.user?.login !== "github-actions[bot]" ||
    created.user.type !== "Bot" ||
    created.title !== text.title ||
    created.body !== text.body
  )
    throw new Error("Unacknowledged monitor publication");
  incident.phase = "open";
  incident.issue = created.number;
  await store.save(state, intentCommit);
  return { outcome: "incident_created", issue: created.number, observation };
}
function boolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("Invalid monitor boolean");
}
async function main(env = process.env) {
  let result = {
    outcome: "monitor_failed",
    reason: "monitor_operation_failed; inspect trusted state before retrying publication",
  };
  try {
    assertSubscriptionEnv(env);
    result = await monitor({
      api: new GitHub({ token: env.GITHUB_TOKEN }),
      context: {
        repository: env.GITHUB_REPOSITORY,
        ref: env.GITHUB_REF,
        workflowRef: env.GITHUB_WORKFLOW_REF,
        workflowSha: env.GITHUB_WORKFLOW_SHA,
        sha: env.GITHUB_SHA,
        runId: env.GITHUB_RUN_ID,
        runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
        eventName: env.GITHUB_EVENT_NAME,
        actor: env.GITHUB_ACTOR,
        triggeringActor: env.GITHUB_TRIGGERING_ACTOR,
      },
      enabled: boolean(env.FACTORY_MONITOR_ENABLED, false),
      dryRun: env.GITHUB_EVENT_NAME === "schedule" ? false : boolean(env.MONITOR_DRY_RUN, true),
    });
  } catch {
    // Never print remote exception text, response bodies or request headers.
    process.exitCode = 1;
  }
  const summary = `## Production monitor\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n\nNo model invocation. An unhealthy app can be reported by a successful monitor run.\n`;
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  console.log(JSON.stringify(result));
  return result;
}
if (require.main === module)
  main().catch(() => {
    console.error("Could not write sanitized monitor summary");
    process.exitCode = 1;
  });
module.exports = { assertMonitorContext, validateObservation, issueText, monitor, main };
