const slots = require("./active-tickets.cjs");
const { isDeepStrictEqual } = require("node:util");
const { CASE } = require("./quarantine-contract.cjs");
const { validateState } = require("./policy.cjs");
const ROOT = `/repos/${CASE.repository}`;
function hasContainment(state) {
  try {
    validateState(state);
    const ticket = state.tickets[38];
    const grant = state.grants["2e9200c0-e2b6-4684-ae37-80ddd128504a"];
    return Boolean(
      !slots.activeEntries(state).some((entry) => String(entry.runId) === String(CASE.id)) &&
        !Object.values(state.grants).some((g) => String(g.runId) === String(CASE.id)) &&
        ticket?.origin === "drill" &&
        ticket.status === "drill_complete" &&
        ticket.criteriaHash ===
          "bb5da512fde05c7fa19921e542a8df811239ebe22141562abf08195ef1b35c76" &&
        isDeepStrictEqual(ticket.drill, {
          runId: "43581712040",
          runAttempt: 1,
          workflowRef: `${CASE.repository}/.github/workflows/factory-monitor-drill.yml@refs/heads/main`,
          workflowSha: "487a11c03d980f35557c462cb75c68b60e39fe78",
          seedSha: "63ce8d08c28977125333fc0ba4d0f0b879dd71f6",
          incidentId: "19278615-0033-4146-a5a4-46b9296c1c5f",
        }) &&
        grant?.ticket === 38 &&
        grant.status === "finished" &&
        grant.outcome === "drill_complete" &&
        state.days["2026-11-14"]?.includes(38)
    );
  } catch {
    return false;
  }
}
function matchesRun(run) {
  return Boolean(
    run &&
      Object.entries(CASE).every(
        ([key, value]) => (key === "repository" ? run.repository?.full_name : run[key]) === value
      ) &&
      run.actor?.login === "haideearus" &&
      run.triggering_actor?.login === "haideearus" &&
      isDeepStrictEqual(
        run.referenced_workflows,
        ["cycle", "model"].map((name) => ({
          path: `${CASE.repository}/.github/workflows/factory-${name}.yml@${CASE.head_sha}`,
          sha: CASE.head_sha,
          ref: "refs/heads/main",
        }))
      )
  );
}
function empty(data, key) {
  return data?.total_count === 0 && Array.isArray(data[key]) && data[key].length === 0;
}
async function inspectQuarantine(api, state, run) {
  // Absence, changed evidence and outages all restore ordinary cancellation.
  if (!matchesRun(run) || !hasContainment(state)) return null;
  try {
    const [jobs, suite, checks, artifacts, deployments] = await Promise.all([
      api.request("GET", `${ROOT}/actions/runs/${CASE.id}/jobs?filter=all&per_page=100`),
      api.request("GET", `${ROOT}/check-suites/${CASE.check_suite_id}`),
      api.request("GET", `${ROOT}/check-suites/${CASE.check_suite_id}/check-runs?per_page=100`),
      api.request("GET", `${ROOT}/actions/runs/${CASE.id}/artifacts?per_page=100`),
      api.request("GET", `${ROOT}/actions/runs/${CASE.id}/pending_deployments`),
    ]);
    if (
      !(
        empty(jobs, "jobs") &&
        empty(checks, "check_runs") &&
        empty(artifacts, "artifacts") &&
        Array.isArray(deployments) &&
        deployments.length === 0 &&
        suite?.id === CASE.check_suite_id &&
        suite.app?.id === 15368 &&
        suite.repository?.full_name === CASE.repository &&
        suite.head_sha === CASE.head_sha &&
        suite.head_branch === CASE.head_branch &&
        suite.status === "queued" &&
        suite.conclusion === null &&
        suite.created_at === CASE.created_at &&
        suite.updated_at === CASE.updated_at &&
        suite.latest_check_runs_count === 0
      )
    )
      return null;
    // Re-read after the collections; never cache an exemption across attempts.
    if (!matchesRun(await api.request("GET", `${ROOT}/actions/runs/${CASE.id}`))) return null;
    return {
      id: CASE.id,
      runAttempt: CASE.run_attempt,
      status: "queued",
      head: CASE.head_sha,
      containmentTicket: 38,
      reason: "Frozen pre-job controller rejects retained drill history before admission",
    };
  } catch {
    return null;
  }
}
async function partitionRuns(api, state, runs) {
  const pending = [],
    quarantined = [];
  for (const run of runs) {
    const proof = await inspectQuarantine(api, state, run);
    if (proof) quarantined.push(proof);
    else pending.push(run);
  }
  return { pending, quarantined, quarantinedRunIds: quarantined.map((run) => run.id) };
}
module.exports = { hasContainment, inspectQuarantine, partitionRuns };
