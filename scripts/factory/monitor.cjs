const fs = require("node:fs");
const { createHash, randomUUID } = require("node:crypto");
const { GitHub, ROOT } = require("./github.cjs");
const { REPOSITORY, OWNER, SHA, assertSubscriptionEnv } = require("./policy.cjs");
const { MonitorStore, MAX_INCIDENTS, MAX_CREATIONS_PER_DAY } = require("./monitor-state.cjs");
const { MONITOR_WORKFLOW } = require("./monitor-origin.cjs");
const { probeApp } = require("./monitor-probe.cjs");
const { publisherFetch } = require("./app-checks-budget.cjs");
const {
  validateAppChecks,
  appChecksEnabled,
  monitorContext,
  readReport,
} = require("./app-checks-contract.cjs");
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
  const appChecks =
    observation?.appChecks === undefined ? undefined : validateAppChecks(observation.appChecks);
  if (
    typeof observation?.healthy !== "boolean" ||
    !checks ||
    Object.keys(checks).sort().join(",") !== "frontend,health,readiness" ||
    Object.values(checks).some((value) => !["ok", "failed"].includes(value)) ||
    observation.healthy !==
      (Object.values(checks).every((value) => value === "ok") &&
        (!appChecks || appChecks.healthy)) ||
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
    ...(appChecks ? { appChecks } : {}),
  };
}
function issueText(incident, observation) {
  const signedIn = observation.appChecks
    ? `Signed-in API checks: login=${observation.appChecks.checks.login}; session=${observation.appChecks.checks.session}; feed=${observation.appChecks.checks.feed}; logout=${observation.appChecks.checks.logout}.\n\n`
    : "";
  const contract =
    observation.appChecks?.feedContract !== undefined
      ? `Pagination contract check: ${observation.appChecks.feedContract}. Reproduction: the dedicated signed-in journey reads GET /api/transactions/public?page=1&limit=0 after the normal page=1&limit=5 control. Require bounded JSON 400/422 rejection or coherent positive bounded pagination; HTTP 200 with totalPages=null is invalid.\n\n`
      : "";
  return {
    title: "Production monitor: investigate failed public checks",
    body: `## Observed incident\n\nThe fixed ${observation.appChecks ? "production" : "public production"} probes failed after bounded cold-start retries.\n\nIncident: ${incident.id}\nObserved at: ${incident.at}\nChecks: health=${observation.checks.health}; readiness=${observation.checks.readiness}; frontend=${observation.checks.frontend}.\n${signedIn}${contract}Evidence: https://github.com/${REPOSITORY}/actions/runs/${incident.source.runId}\n\n## Bounded maintenance task\n\nInvestigate the application cause using repository code and disposable local tests. A provider outage, free-plan quota, cold start, credential problem or configuration issue may have no code fix. If so, stop with evidence and request owner attention; do not invent a repair.\n\nFor a reproducible application bug, demonstrate a failing regression test, implement the smallest repair and show it passing. Preserve independent review, existing scope restrictions and named human production approval.\n\nDo not change the harness, limits, hosting plan, credentials or production data. Do not run database-seeding tests against production. Do not enable paid APIs. Do not edit this issue's title or body after admission; put additional observations in comments.\n\n## Acceptance criteria\n\n- Explain the reproducible application failure or the evidence for an operator/provider issue.\n- For code changes, preserve failing-before and passing-after test evidence and relevant existing tests.\n- No unverified recovery claim: deployment still requires the owner's approval and public checks afterward.\n`,
  };
}
async function monitor({
  api,
  context,
  enabled = false,
  dryRun = true,
  store = new MonitorStore(api),
  probe = probeApp,
  appChecks,
  now = () => new Date().toISOString(),
}) {
  assertMonitorContext(context);
  if (typeof enabled !== "boolean" || typeof dryRun !== "boolean")
    throw new Error("Invalid monitor switches");
  if (!enabled && !dryRun) return { outcome: "disabled" };
  const base = validateObservation(await probe());
  const observation =
    appChecks === undefined
      ? base
      : validateObservation({
          ...base,
          healthy: base.healthy && validateAppChecks(appChecks).healthy,
          appChecks,
        });
  if (dryRun) return { outcome: "preview", observation };
  return observeIncident({ api, context, store, observation, now, verifiedRetirement: true });
}
async function observeIncident({
  api,
  context,
  store,
  observation,
  now = () => new Date().toISOString(),
  issueText: renderIssueText = issueText,
  labels = ["factory-ready"],
  verifiedRetirement = false,
}) {
  observation = validateObservation(observation);
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
    if (active.probeMode === "feed-contract" && observation.appChecks?.feedContract === undefined)
      return { outcome: "required_probe_missing", issue: active.issue, observation };
    if (verifiedRetirement && observation.healthy) {
      try {
        const { retireIncident } = require("./monitor-recovery.cjs");
        return await retireIncident({
          api,
          context,
          store,
          incident: active,
          issue,
          observation,
          now,
        });
      } catch {
        // A healthy observation is not evidence that this incident's code repair
        // was reviewed, approved, deployed and observed on its required probes.
        const latest = await store.read();
        const held = latest.state.incidents[active.id];
        if (latest.state.active === active.id && held && !held.retirement && !held.recovered) {
          held.recovered = true;
          await store.save(latest.state, latest.commit);
        }
        return {
          outcome: "recovery_held",
          issue: active.issue,
          observation,
          reason: "Repair/deployment proof missing, changed, or closure unconfirmed",
        };
      }
    }
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
    ...(observation.appChecks?.feedContract !== undefined ? { probeMode: "feed-contract" } : {}),
  };
  const text = renderIssueText(incident, observation);
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
    labels,
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
    if (env.FACTORY_MONITOR_USERNAME || env.FACTORY_MONITOR_PASSWORD)
      throw new Error("Account credentials must not reach the publisher");
    const context = monitorContext(env);
    assertMonitorContext(context);
    const enabled = boolean(env.FACTORY_MONITOR_ENABLED, false);
    const dryRun =
      env.GITHUB_EVENT_NAME === "schedule" ? false : boolean(env.MONITOR_DRY_RUN, true);
    if (
      (enabled || dryRun) &&
      appChecksEnabled(env.FACTORY_FEED_CONTRACT_CHECK_ENABLED) &&
      !appChecksEnabled(env.FACTORY_APP_CHECKS_ENABLED)
    )
      throw Error("Feed contract requires the synthetic API journey");
    const checked =
      appChecksEnabled(env.FACTORY_APP_CHECKS_ENABLED) && (enabled || dryRun)
        ? readReport(env, context)
        : undefined;
    result = await monitor({
      api: new GitHub({ token: env.GITHUB_TOKEN, fetch: publisherFetch() }),
      context,
      enabled,
      dryRun,
      appChecks: checked,
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
module.exports = {
  assertMonitorContext,
  validateObservation,
  issueText,
  observeIncident,
  monitor,
  main,
};
