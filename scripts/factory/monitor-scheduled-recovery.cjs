const { randomUUID } = require("node:crypto");
const { Ledger, ROOT } = require("./github.cjs");
const { verifyMonitorIssue } = require("./monitor-origin.cjs");
const { proofFromIncident } = require("./monitor-proof.cjs");
const { REASON, SCHEDULED_KIND, validateAcknowledgment } = require("./monitor-ack-contract.cjs");
const { MAX_LATEST_AGE, sameRepair } = require("./monitor-blocked-recovery-contract.cjs");
const {
  healthyFeedObservation,
  verifyFailedRepair,
  verifyRecovery,
} = require("./monitor-blocked-recovery.cjs");

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const requireEvidence = (ok) => {
  if (!ok) throw Error("Scheduled recovery changed or closure unconfirmed");
};

async function closeBlockedRepair({
  api,
  context,
  store,
  state,
  commit,
  incident,
  issue,
  observation,
  at,
  now,
}) {
  const intent = incident.acknowledgment;
  const proof = proofFromIncident(incident);
  const closed = (row) => row.state === "closed" && row.state_reason === "not_planned";
  const matches = (row) =>
    row?.number === incident.issue &&
    !row.pull_request &&
    row.user?.login === "github-actions[bot]" &&
    row.user.type === "Bot" &&
    row.title === issue.title &&
    row.body === issue.body;
  if (
    context.eventName !== "schedule" ||
    state.active !== incident.id ||
    incident.probeMode !== "feed-contract" ||
    incident.retirement ||
    (intent && (intent.kind !== SCHEDULED_KIND || intent.phase !== "intent")) ||
    incident.blockedRecovery?.observations.length !== 2 ||
    !matches(issue) ||
    (issue.state !== "open" && !(intent && closed(issue))) ||
    !healthyFeedObservation(observation)
  )
    return null;
  require("./monitor.cjs").assertMonitorContext(context);
  const ledger = new Ledger(api);
  const { state: ledgerState } = await ledger.read();
  if (ledgerState.stop) return { deferred: "Factory emergency stop is active" };
  const recovery = await verifyRecovery({
    api,
    state: ledgerState,
    incident,
    release: observation.release,
    now: at,
    runId: context.runId,
  }).catch(() => null);
  if (!recovery || !(await verifyMonitorIssue(api, issue, { proof, requireActive: false })))
    return {
      deferred:
        "Fresh completed recovery observations or exact issue and repair evidence are unavailable",
    };

  const verification = (observedAt) => ({
    runId: context.runId,
    runAttempt: context.runAttempt,
    workflowSha: context.workflowSha,
    at: observedAt,
    release: observation.release,
  });
  const acknowledgment =
    intent ||
    validateAcknowledgment({
      version: 1,
      kind: SCHEDULED_KIND,
      phase: "intent",
      operationId: randomUUID(),
      reason: REASON,
      proof,
      request: verification(at),
      blockedRecovery: recovery,
    });
  if (!intent) {
    incident.acknowledgment = acknowledgment;
    await store.save(state, commit);
  }
  const path = `${ROOT}/issues/${incident.issue}`;
  const current = async () => {
    const [snapshot, { state: latestLedger }, target] = await Promise.all([
      store.read(),
      ledger.read(),
      api.request("GET", path),
    ]);
    const active = snapshot.state.incidents[snapshot.state.active];
    requireEvidence(
      !latestLedger.stop &&
        active?.id === incident.id &&
        same(proofFromIncident(active), proof) &&
        same(active.acknowledgment, acknowledgment) &&
        same(active.blockedRecovery, recovery) &&
        matches(target) &&
        (target.state === "open" || closed(target)) &&
        Date.parse(now()) - Date.parse(recovery.observations.at(-1).at) <= MAX_LATEST_AGE
    );
    const { identity } = await verifyFailedRepair(api, latestLedger, active);
    requireEvidence(sameRepair(identity, recovery.repair));
    return { ...snapshot, active, target };
  };

  const before = await current();
  if (before.target.state === "open") {
    const result = await api.request("PATCH", path, {
      state: "closed",
      state_reason: "not_planned",
    });
    requireEvidence(matches(result) && closed(result));
  }
  const confirmed = await current();
  requireEvidence(closed(confirmed.target));
  confirmed.active.acknowledgment = validateAcknowledgment({
    ...acknowledgment,
    phase: "complete",
    verification: {
      ...verification(now()),
      ...(!same(acknowledgment.blockedRecovery, recovery) ? { blockedRecovery: recovery } : {}),
    },
  });
  delete confirmed.active.blockedRecovery;
  confirmed.state.active = null;
  await store.save(confirmed.state, confirmed.commit);
  return {
    outcome: "blocked_repair_recovery_closed",
    issue: incident.issue,
    incident: incident.id,
    observation,
    reason: REASON,
    operationId: acknowledgment.operationId,
    recovery,
  };
}

module.exports = { closeBlockedRepair };
