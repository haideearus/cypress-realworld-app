const fs = require("node:fs"),
  { randomUUID } = require("node:crypto");
const { GitHub, Ledger, ROOT } = require("./github.cjs");
const { OWNER, assertSubscriptionEnv } = require("./policy.cjs");
const { activeEntries } = require("./active-tickets.cjs");
const { MonitorStore } = require("./monitor-state.cjs");
const { verifyMonitorIssue } = require("./monitor-origin.cjs");
const { proofFromIncident } = require("./monitor-proof.cjs");
const { probeApp } = require("./monitor-probe.cjs");
const { monitorContext } = require("./app-checks-contract.cjs");
const { publisherFetch } = require("./app-checks-budget.cjs");
const { verifyOwnerRecovery } = require("./monitor-blocked-recovery.cjs");
const {
  REASON,
  requireAck,
  assertAckContext,
  assertAckSettings,
  validateAckReport,
  readAckReport,
  validateAcknowledgment,
} = require("./monitor-ack-contract.cjs");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function acknowledge({
  api,
  context,
  settings,
  issueNumber,
  dryRun = true,
  blockedRepair = false,
  report,
  store = new MonitorStore(api),
  ledger = new Ledger(api),
  probe = probeApp,
  now = () => new Date().toISOString(),
}) {
  assertAckContext(context);
  assertAckSettings(settings, blockedRepair);
  requireAck(Number.isSafeInteger(issueNumber) && issueNumber > 0 && typeof dryRun === "boolean");
  async function stopped() {
    const { state } = await ledger.read();
    requireAck(
      state.stop &&
        activeEntries(state).length === 0 &&
        !Object.values(state.grants).some((g) => g.status === "reserved") &&
        (blockedRepair ||
          (!Object.hasOwn(state.tickets, String(issueNumber)) &&
            !Object.values(state.grants).some((g) => g.ticket === issueNumber)))
    );
    return state;
  }
  async function target({ complete = false } = {}) {
    const { state, commit } = await store.read();
    const matches = Object.values(state.incidents).filter((i) => i.issue === issueNumber);
    requireAck(matches.length === 1);
    const incident = matches[0];
    requireAck(
      incident.phase === "open" &&
        (blockedRepair
          ? incident.probeMode === "feed-contract"
          : !Object.hasOwn(incident, "probeMode")) &&
        !Object.hasOwn(incident, "retirement")
    );
    const issue = await api.request("GET", `${ROOT}/issues/${issueNumber}`);
    requireAck(
      issue.number === issueNumber &&
        !issue.pull_request &&
        ["open", "closed"].includes(issue.state)
    );
    const proof = await verifyMonitorIssue(api, issue, {
      proof: proofFromIncident(incident),
      requireActive: false,
    });
    requireAck(proof);
    if (incident.acknowledgment?.phase === "complete") {
      requireAck(
        complete &&
          state.active !== incident.id &&
          issue.state === "closed" &&
          issue.state_reason === "not_planned"
      );
      validateAcknowledgment(incident.acknowledgment);
    } else {
      requireAck(
        state.active === incident.id &&
          (issue.state === "open" ||
            (incident.acknowledgment?.phase === "intent" && issue.state_reason === "not_planned"))
      );
    }
    return { state, commit, incident, issue };
  }
  validateAckReport(report, context, now(), blockedRepair);
  requireAck(report.result.healthy);
  const observation = await probe();
  requireAck(
    observation.healthy === true &&
      Object.keys(observation.checks || {})
        .sort()
        .join(",") === "frontend,health,readiness" &&
      Object.values(observation.checks).every((v) => v === "ok") &&
      observation.release === report.result.releases.before
  );
  // Availability has its own retry budget. Start GitHub's shared metadata/
  // publication deadline only after these public reads have finished.
  const assertFreshReport = () => validateAckReport(report, context, now(), blockedRepair);
  const blockedEvidence = (state, incident) =>
    blockedRepair
      ? verifyOwnerRecovery({
          api,
          state,
          incident,
          release: observation.release,
          now: now(),
          runId: context.runId,
        })
      : undefined;
  assertFreshReport();
  let stoppedState = await stopped();
  let current = await target({ complete: true });
  if (current.incident.acknowledgment?.phase === "complete")
    return { outcome: "already_acknowledged", issue: issueNumber };
  const blockedRecovery = await blockedEvidence(stoppedState, current.incident);
  assertFreshReport();
  const verification = () => ({
    runId: context.runId,
    runAttempt: 1,
    workflowSha: context.workflowSha,
    at: now(),
    reportAt: report.at,
    release: observation.release,
  });
  const result = {
    issue: issueNumber,
    incident: current.incident.id,
    actor: OWNER,
    reason: REASON,
    scope: blockedRepair ? "feed-contract" : "standard-only",
    release: observation.release,
    ...(blockedRecovery ? { blockedRecovery } : {}),
  };
  if (dryRun) return { outcome: "acknowledgment_preview", ...result };
  const proof = proofFromIncident(current.incident);
  stoppedState = await stopped();
  current = await target();
  requireAck(
    same(proofFromIncident(current.incident), proof) &&
      same(await blockedEvidence(stoppedState, current.incident), blockedRecovery)
  );
  const intent =
    current.incident.acknowledgment ||
    validateAcknowledgment({
      version: 1,
      kind: "owner-observed-recovery",
      phase: "intent",
      operationId: randomUUID(),
      actor: OWNER,
      reason: REASON,
      at: now(),
      proof,
      request: { runId: context.runId, runAttempt: 1, workflowSha: context.workflowSha },
      verification: verification(),
      ...(blockedRecovery ? { blockedRecovery } : {}),
    });
  if (!current.incident.acknowledgment) {
    assertFreshReport();
    current.incident.acknowledgment = intent;
    await store.save(current.state, current.commit);
  }
  stoppedState = await stopped();
  current = await target();
  requireAck(
    same(current.incident.acknowledgment, intent) &&
      same(proofFromIncident(current.incident), proof) &&
      same(await blockedEvidence(stoppedState, current.incident), blockedRecovery)
  );
  assertFreshReport();
  if (current.issue.state === "open") {
    const closed = await api.request("PATCH", `${ROOT}/issues/${issueNumber}`, {
      state: "closed",
      state_reason: "not_planned",
    });
    requireAck(
      closed.number === issueNumber &&
        closed.state === "closed" &&
        closed.state_reason === "not_planned" &&
        closed.title === current.issue.title &&
        closed.body === current.issue.body
    );
  }
  stoppedState = await stopped();
  current = await target();
  requireAck(
    current.issue.state === "closed" &&
      current.issue.state_reason === "not_planned" &&
      same(current.incident.acknowledgment, intent) &&
      same(proofFromIncident(current.incident), proof) &&
      same(await blockedEvidence(stoppedState, current.incident), blockedRecovery)
  );
  assertFreshReport();
  current.incident.acknowledgment = validateAcknowledgment({
    ...intent,
    phase: "complete",
    verification: {
      ...verification(),
      ...(blockedRecovery && !same(blockedRecovery, intent.blockedRecovery)
        ? { blockedRecovery }
        : {}),
    },
  });
  current.incident.recovered = true;
  delete current.incident.blockedRecovery;
  current.state.active = null;
  await store.save(current.state, current.commit);
  return { outcome: "incident_acknowledged", ...result, operationId: intent.operationId };
}
async function main(env = process.env) {
  let result;
  try {
    assertSubscriptionEnv(env);
    requireAck(
      !env.FACTORY_MONITOR_USERNAME &&
        !env.FACTORY_MONITOR_PASSWORD &&
        ["true", "false"].includes(env.ACK_DRY_RUN) &&
        [undefined, "true", "false"].includes(env.ACK_BLOCKED_REPAIR) &&
        /^[1-9]\d{0,15}$/.test(env.ACK_ISSUE || "")
    );
    const context = monitorContext(env);
    assertAckContext(context);
    const settings = JSON.parse(env.ACK_SETTINGS || "{}");
    const blockedRepair = env.ACK_BLOCKED_REPAIR === "true";
    assertAckSettings(settings, blockedRepair);
    const report = readAckReport(env, context, undefined, blockedRepair);
    result = await acknowledge({
      api: new GitHub({ token: env.GITHUB_TOKEN, fetch: publisherFetch() }),
      context,
      settings,
      issueNumber: Number(env.ACK_ISSUE),
      dryRun: env.ACK_DRY_RUN === "true",
      blockedRepair,
      report,
    });
  } catch {
    result = {
      outcome: "acknowledgment_held",
      reason: "Eligibility or fresh evidence unavailable; preserve intent and inspect before retry",
    };
    process.exitCode = 1;
  }
  console.log(JSON.stringify(result));
  if (env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `## Owner monitor acknowledgment\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n\nOwner acknowledgment records observed recovery. No AI code repair or deployment credited. No model invocation.\n`
    );
  return result;
}
if (require.main === module)
  main().catch(() => {
    console.error("Acknowledgment output unavailable");
    process.exitCode = 1;
  });
module.exports = { acknowledge, main };
