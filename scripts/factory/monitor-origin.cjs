const { createHash } = require("node:crypto");
const { ROOT } = require("./github.cjs");
const { REPOSITORY, OWNER } = require("./policy.cjs");
const { MonitorStore } = require("./monitor-state.cjs");
const { validateMonitorProof, proofFromIncident } = require("./monitor-proof.cjs");
const MONITOR_WORKFLOW = ".github/workflows/factory-monitor.yml";
const criteriaHash = (issue) =>
  createHash("sha256")
    .update(JSON.stringify([issue.title, issue.body || ""]))
    .digest("hex");
async function verifyMonitorIssue(api, issue, { proof, requireActive = true } = {}) {
  if (
    issue?.user?.login !== "github-actions[bot]" ||
    issue.user.type !== "Bot" ||
    !Number.isSafeInteger(issue.number) ||
    (proof !== undefined && !validateMonitorProof(proof))
  )
    return null;
  const { state } = await new MonitorStore(api).read();
  const matches = Object.values(state.incidents).filter(
    (item) => item.issue === issue.number && item.phase === "open"
  );
  if (matches.length !== 1) return null;
  const incident = matches[0];
  const actual = proofFromIncident(incident);
  if (
    !validateMonitorProof(actual) ||
    actual.criteriaHash !== criteriaHash(issue) ||
    (requireActive && (state.active !== incident.id || incident.recovered)) ||
    (proof && Object.keys(actual).some((key) => actual[key] !== proof[key]))
  )
    return null;
  let workflow, run, jobs;
  try {
    workflow = await api.request("GET", `${ROOT}/actions/workflows/factory-monitor.yml`);
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
    workflow.path !== MONITOR_WORKFLOW ||
    !Number.isSafeInteger(workflow.id) ||
    run.id !== Number(actual.runId) ||
    run.workflow_id !== workflow.id ||
    run.path !== MONITOR_WORKFLOW ||
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
  const publisher = Array.isArray(jobs.jobs) && jobs.jobs.filter((job) => job.name === "monitor");
  if (
    !publisher ||
    publisher.length !== 1 ||
    publisher[0].status !== "completed" ||
    publisher[0].conclusion !== "success" ||
    publisher[0].steps?.filter(
      (step) =>
        step.name === "Observe production and publish incident" && step.conclusion === "success"
    ).length !== 1
  )
    return null;
  return actual;
}
module.exports = { MONITOR_WORKFLOW, validateMonitorProof, proofFromIncident, verifyMonitorIssue };
