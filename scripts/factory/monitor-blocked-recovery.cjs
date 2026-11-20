const { Ledger, ROOT } = require("./github.cjs");
const { OWNER, REPOSITORY, SHA } = require("./policy.cjs");
const { activeFor } = require("./active-tickets.cjs");
const { MONITOR_WORKFLOW, verifyMonitorIssue } = require("./monitor-origin.cjs");
const { proofFromIncident } = require("./monitor-proof.cjs");
const {
  MAX_LATEST_AGE,
  followsRecovery,
  sameRepair,
  validateBlockedRecovery,
} = require("./monitor-blocked-recovery-contract.cjs");

const REPAIR_WORKFLOW = ".github/workflows/factory-automatic.yml";
const assertEvidence = (condition) => {
  if (!condition) throw Error("Blocked monitor recovery evidence unavailable");
};

function matchesRun(run, { workflow, runId, runAttempt, sha }) {
  return (
    run?.id === Number(runId) &&
    run.run_attempt === runAttempt &&
    run.path === workflow &&
    run.head_branch === "main" &&
    run.head_sha === sha &&
    run.repository?.full_name === REPOSITORY &&
    run.head_repository?.full_name === REPOSITORY &&
    run.status === "completed"
  );
}

async function verifyFailedRepair(api, state, incident) {
  const issue = incident.issue;
  const ticket = state.tickets[issue];
  const proof = proofFromIncident(incident);
  const grants = Object.values(state.grants).filter((row) => row.ticket === issue);
  const grant = grants.sort((a, b) => b.at.localeCompare(a.at))[0];
  assertEvidence(
    ticket?.origin === "factory" &&
      ticket.automatic &&
      ticket.status === "blocked" &&
      ticket.pr === null &&
      ticket.approval === null &&
      !activeFor(state, issue) &&
      ticket.criteriaHash === proof.criteriaHash &&
      Object.keys(proof).every((key) => ticket.monitor?.[key] === proof[key]) &&
      [
        "branch",
        "merge",
        "ci",
        "pendingCi",
        "publication",
        "delayedRetry",
        "recovery",
        "reviewRecovery",
      ].every((key) => ticket[key] === undefined) &&
      ticket.reviews === 0 &&
      ticket.coding === grants.length &&
      grant?.head === ticket.head &&
      grants.every(
        (row) => row.phase === "code" && row.status === "finished" && row.outcome === "blocked"
      )
  );
  const branch = "agent/factory-" + issue;
  const [ref, prs, run] = await Promise.all([
    api.request("GET", ROOT + "/git/ref/heads/" + branch).catch((error) => {
      if (error.status === 404) return null;
      throw error;
    }),
    api.request(
      "GET",
      ROOT + "/pulls?state=all&per_page=1&head=" + encodeURIComponent(OWNER + ":" + branch)
    ),
    api.request("GET", ROOT + "/actions/runs/" + grant.runId + "/attempts/" + grant.runAttempt),
  ]);
  assertEvidence(
    ref === null &&
      Array.isArray(prs) &&
      prs.length === 0 &&
      matchesRun(run, {
        workflow: REPAIR_WORKFLOW,
        runId: grant.runId,
        runAttempt: grant.runAttempt,
        sha: grant.head,
      }) &&
      ["failure", "success", "cancelled", "timed_out"].includes(run.conclusion) &&
      Number.isFinite(Date.parse(run.updated_at)) &&
      Date.parse(run.updated_at) >= Date.parse(grant.at)
  );
  return {
    identity: {
      grantId: grant.id,
      head: grant.head,
      runId: grant.runId,
      runAttempt: grant.runAttempt,
    },
    finishedAt: Date.parse(run.updated_at),
  };
}

async function verifyScheduledObservation(api, receipt) {
  const runPath = ROOT + "/actions/runs/" + receipt.runId + "/attempts/1";
  const [workflow, run, jobs] = await Promise.all([
    api.request("GET", ROOT + "/actions/workflows/factory-monitor.yml"),
    api.request("GET", runPath),
    api.request("GET", runPath + "/jobs?per_page=100"),
  ]);
  assertEvidence(
    workflow.path === MONITOR_WORKFLOW &&
      Number.isSafeInteger(workflow.id) &&
      run?.workflow_id === workflow.id &&
      matchesRun(run, {
        workflow: MONITOR_WORKFLOW,
        runId: receipt.runId,
        runAttempt: 1,
        sha: receipt.workflowSha,
      }) &&
      run.event === "schedule" &&
      run.conclusion === "success" &&
      run.actor?.login === OWNER &&
      run.triggering_actor?.login === OWNER &&
      Date.parse(run.run_started_at) <= Date.parse(receipt.at) &&
      // GitHub run timestamps can omit the receipt's milliseconds.
      Date.parse(receipt.at) < Date.parse(run.updated_at) + 1000 &&
      Array.isArray(jobs.jobs) &&
      jobs.total_count === jobs.jobs.length &&
      jobs.jobs.length <= 100
  );
  const sameJob = jobs.jobs.filter((job) => job.name === "monitor");
  const job = sameJob[0];
  assertEvidence(
    sameJob.length === 1 &&
      job.status === "completed" &&
      job.conclusion === "success" &&
      job.head_sha === receipt.workflowSha &&
      Array.isArray(job.steps) &&
      [
        "Check synthetic-user API journey",
        "Scan credential-free app check report",
        "Observe production and publish incident",
      ].every((name) => {
        const matching = job.steps.filter((step) => step.name === name);
        return (
          matching.length === 1 &&
          matching[0].status === "completed" &&
          matching[0].conclusion === "success"
        );
      })
  );
}

async function observeBlockedRepair({ api, context, incident, issue, observation, at }) {
  const checked = observation.appChecks;
  const intent = incident.acknowledgment?.blockedRecovery;
  if (
    context.eventName !== "schedule" ||
    !observation.healthy ||
    issue.number !== incident.issue ||
    issue.pull_request ||
    (issue.state !== "open" &&
      !(intent && issue.state === "closed" && issue.state_reason === "not_planned")) ||
    incident.retirement ||
    (incident.acknowledgment && !intent) ||
    checked?.feedContract !== "ok" ||
    !SHA.test(observation.release || "") ||
    checked.releases.before !== observation.release ||
    checked.releases.after !== observation.release
  )
    return null;
  require("./monitor.cjs").assertMonitorContext(context);
  const { state } = await new Ledger(api).read();
  const repair = await verifyFailedRepair(api, state, incident);
  assertEvidence(Date.parse(at) > repair.finishedAt);
  assertEvidence(!intent || sameRepair(intent.repair, repair.identity));
  assertEvidence(
    await verifyMonitorIssue(api, issue, {
      proof: proofFromIncident(incident),
      requireActive: false,
    })
  );
  const prior = incident.blockedRecovery;
  const previous = prior?.observations.at(-1);
  const current = {
    runId: context.runId,
    workflowSha: context.workflowSha,
    at,
    release: observation.release,
  };
  if (prior?.observations.some((row) => row.runId === current.runId)) return prior;
  const observations = [current];
  if (
    sameRepair(prior?.repair, repair.identity) &&
    followsRecovery(previous, current) &&
    (await verifyScheduledObservation(api, previous).then(
      () => true,
      () => false
    ))
  ) {
    observations.unshift(previous);
  }
  return validateBlockedRecovery({ repair: repair.identity, observations });
}

async function verifyOwnerRecovery({ api, state, incident, release, now, runId }) {
  const intent = incident.acknowledgment?.blockedRecovery;
  const receipt = validateBlockedRecovery(incident.blockedRecovery);
  const newEvidence = JSON.stringify(receipt) !== JSON.stringify(intent);
  const { identity, finishedAt } = await verifyFailedRepair(api, state, incident);
  const last = receipt.observations.at(-1);
  assertEvidence(
    sameRepair(receipt.repair, identity) &&
      receipt.observations.length === 2 &&
      (!intent || sameRepair(intent.repair, identity)) &&
      receipt.observations.every((row) => row.runId !== runId && Date.parse(row.at) > finishedAt) &&
      last.release === release &&
      Date.parse(last.at) < Date.parse(now) &&
      (!newEvidence || Date.parse(now) - Date.parse(last.at) <= MAX_LATEST_AGE)
  );
  if (newEvidence)
    await Promise.all(receipt.observations.map((row) => verifyScheduledObservation(api, row)));
  return receipt;
}

module.exports = { observeBlockedRepair, verifyOwnerRecovery };
