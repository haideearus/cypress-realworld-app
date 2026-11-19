const { createHash } = require("node:crypto");
const { ROOT } = require("./github.cjs");
const { REPOSITORY, OWNER } = require("./policy.cjs");
const { MonitorStore } = require("./monitor-state.cjs");
const { validateMonitorProof, proofFromIncident } = require("./monitor-proof.cjs");
const functionalDiscovery = require("./functional-discovery-contract.cjs");
const MONITOR_WORKFLOW = ".github/workflows/factory-monitor.yml";
const criteriaHash = (issue) =>
  createHash("sha256")
    .update(JSON.stringify([issue.title, issue.body || ""]))
    .digest("hex");
function successfulJob(jobs, name, step) {
  const matches = jobs.filter((job) => job.name === name);
  return (
    matches.length === 1 &&
    matches[0].status === "completed" &&
    matches[0].conclusion === "success" &&
    matches[0].steps?.filter((entry) => entry.name === step && entry.conclusion === "success")
      .length === 1
  );
}
async function verifyMonitorIssue(api, issue, { proof, requireActive = true } = {}) {
  if (
    issue?.user?.login !== "github-actions[bot]" ||
    issue.user.type !== "Bot" ||
    !Number.isSafeInteger(issue.number) ||
    (proof !== undefined && !validateMonitorProof(proof))
  )
    return null;
  const functionalCheck = functionalDiscovery.functionalIssueCheck(issue);
  const functional = functionalCheck !== undefined;
  const workflowPath = functional ? functionalDiscovery.WORKFLOW_PATH : MONITOR_WORKFLOW;
  const { state } = await new MonitorStore(api, functional ? "functional" : "production").read();
  const matches = Object.values(state.incidents).filter(
    (item) => item.issue === issue.number && item.phase === "open"
  );
  if (matches.length !== 1) return null;
  const incident = matches[0];
  const actual = proofFromIncident(incident);
  if (
    !validateMonitorProof(actual) ||
    (actual.probeMode === functionalDiscovery.PROBE_MODE) !== functional ||
    (functional &&
      (incident.functionalCheck !== functionalCheck ||
        !issue.body?.split("\n").includes(`Failed assertion: ${incident.functionalAssertion}`))) ||
    actual.criteriaHash !== criteriaHash(issue) ||
    (requireActive &&
      (state.active !== incident.id ||
        incident.recovered ||
        incident.acknowledgment !== undefined)) ||
    (proof && Object.keys(actual).some((key) => actual[key] !== proof[key]))
  )
    return null;
  let workflow, run, jobs;
  try {
    workflow = await api.request(
      "GET",
      `${ROOT}/actions/workflows/${workflowPath.split("/").at(-1)}`
    );
    // Preserve the recorded successful attempt even if someone later reruns
    // the workflow (new publication attempts are forbidden by the workflow).
    run = await api.request("GET", `${ROOT}/actions/runs/${actual.runId}/attempts/1`);
    jobs = await api.request(
      "GET",
      `${ROOT}/actions/runs/${actual.runId}/attempts/1/jobs?per_page=100`
    );
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
  if (
    workflow.path !== workflowPath ||
    !Number.isSafeInteger(workflow.id) ||
    run.id !== Number(actual.runId) ||
    run.workflow_id !== workflow.id ||
    run.path !== workflowPath ||
    run.repository?.full_name !== REPOSITORY ||
    run.head_repository?.full_name !== REPOSITORY ||
    run.head_branch !== "main" ||
    run.head_sha !== actual.workflowSha ||
    run.run_attempt !== 1 ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    !["schedule", "workflow_dispatch"].includes(run.event) ||
    run.actor?.login !== OWNER ||
    run.triggering_actor?.login !== OWNER
  )
    return null;
  if (!Array.isArray(jobs.jobs)) return null;
  const verified = functional
    ? successfulJob(jobs.jobs, "browser", "Run approved browser checks") &&
      successfulJob(jobs.jobs, "publish", "Publish confirmed functional failure")
    : successfulJob(jobs.jobs, "monitor", "Observe production and publish incident");
  if (!verified) return null;
  return actual;
}
module.exports = { MONITOR_WORKFLOW, validateMonitorProof, proofFromIncident, verifyMonitorIssue };
