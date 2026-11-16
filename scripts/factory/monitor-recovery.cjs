const { Ledger, ROOT } = require("./github.cjs");
const { REPOSITORY, OWNER, SHA, reviewGate } = require("./policy.cjs");
const { verifyMonitorIssue } = require("./monitor-origin.cjs");
const { proofFromIncident } = require("./monitor-proof.cjs");
const { validateRetirement } = require("./monitor-recovery-contract.cjs");
const { validateAppChecks } = require("./app-checks-contract.cjs");
const same = (a, b) =>
  a &&
  b &&
  Object.keys(a).length === Object.keys(b).length &&
  Object.keys(a).every((k) => a[k] === b[k]);
const requireProof = (ok) => {
  if (!ok) throw Error("Monitor repair proof unavailable or inconsistent");
};
function matchesIssue(issue, original) {
  return (
    issue?.number === original.number &&
    !issue.pull_request &&
    issue.user?.login === "github-actions[bot]" &&
    issue.user.type === "Bot" &&
    issue.title === original.title &&
    issue.body === original.body &&
    ["open", "closed"].includes(issue.state)
  );
}
async function jobList(api, run) {
  const r = await api.request(
    "GET",
    `${ROOT}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`
  );
  requireProof(
    Array.isArray(r.jobs) &&
      Number.isSafeInteger(r.total_count) &&
      r.total_count === r.jobs.length &&
      r.jobs.length <= 100
  );
  return r.jobs;
}
function successfulJob(jobs, name, sha, step) {
  const matches = jobs.filter((j) => j.name === name);
  requireProof(matches.length === 1);
  const j = matches[0];
  requireProof(j.status === "completed" && j.conclusion === "success" && j.head_sha === sha);
  if (step)
    requireProof(
      j.steps?.filter(
        (s) => s.name === step && s.status === "completed" && s.conclusion === "success"
      ).length === 1
    );
}
async function workflowRun(api, run, file, sha, { firstAttempt = false, event } = {}) {
  const w = await api.request("GET", `${ROOT}/actions/workflows/${file}`);
  requireProof(
    w.path === `.github/workflows/${file}` &&
      Number.isSafeInteger(w.id) &&
      w.id > 0 &&
      run?.workflow_id === w.id &&
      run.path === w.path &&
      run.head_sha === sha &&
      run.head_branch === "main" &&
      run.repository?.full_name === REPOSITORY &&
      run.head_repository?.full_name === REPOSITORY &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      Number.isSafeInteger(run.id) &&
      run.id > 0 &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0 &&
      (!firstAttempt || run.run_attempt === 1) &&
      (!event || event.includes(run.event))
  );
}
async function trustedSource(api, file, sha, current) {
  const a = await api.request("GET", `${ROOT}/contents/.github/workflows/${file}?ref=${sha}`);
  const b = await api.request("GET", `${ROOT}/contents/.github/workflows/${file}?ref=${current}`);
  requireProof(a.type === "file" && b.type === "file" && SHA.test(a.sha || "") && a.sha === b.sha);
}
async function approvedDeployment(api, merge, context) {
  const rows = await api.request(
    "GET",
    `${ROOT}/actions/workflows/factory-deploy.yml/runs?head_sha=${merge}&status=completed&per_page=100`
  );
  requireProof(
    Array.isArray(rows.workflow_runs) &&
      Number.isSafeInteger(rows.total_count) &&
      rows.total_count === rows.workflow_runs.length &&
      rows.total_count <= 100
  );
  const candidates = rows.workflow_runs
    .filter((r) => r.head_sha === merge && r.conclusion === "success")
    .sort((a, b) => b.id - a.id);
  requireProof(candidates.length > 0);
  const listed = candidates[0];
  const run = await api.request("GET", `${ROOT}/actions/runs/${listed.id}`);
  requireProof(run.id === listed.id);
  await workflowRun(api, run, "factory-deploy.yml", merge, {
    firstAttempt: true,
    event: ["workflow_run", "workflow_dispatch"],
  });
  if (run.event === "workflow_dispatch")
    requireProof(run.actor?.login === OWNER && run.triggering_actor?.login === OWNER);
  await trustedSource(api, "factory-deploy.yml", merge, context.workflowSha);
  const match = /^Production deployment \/ CI ([1-9]\d{0,15})$/.exec(run.display_title || "");
  requireProof(match);
  const ci = await api.request("GET", `${ROOT}/actions/runs/${match[1]}`);
  requireProof(String(ci.id) === match[1]);
  await workflowRun(api, ci, "factory-ci.yml", merge, { event: ["push"] });
  await trustedSource(api, "factory-ci.yml", merge, context.workflowSha);
  successfulJob(await jobList(api, ci), "verify", merge);
  const jobs = await jobList(api, run);
  successfulJob(jobs, "prepare", merge, "Validate tested commit without deployment credentials");
  successfulJob(
    jobs,
    `Deploy tested commit ${merge}`,
    merge,
    "Revalidate human approval, deploy once, and verify the live release"
  );
  const decisions = await api.request("GET", `${ROOT}/actions/runs/${run.id}/approvals`);
  requireProof(Array.isArray(decisions) && decisions.length <= 100);
  const production = decisions.filter(
    (r) => Array.isArray(r.environments) && r.environments.some((e) => e.name === "production")
  );
  requireProof(
    production.length === 1 &&
      production[0].state === "approved" &&
      production[0].user?.login === OWNER &&
      production[0].user.type === "User" &&
      production[0].environments.some(
        (e) => e.name === "production" && Number.isSafeInteger(e.id) && e.id > 0
      )
  );
  return { deployRunId: String(run.id), ciRunId: String(ci.id) };
}
async function ledgerTicket(api, incident) {
  const { state } = await new Ledger(api).read();
  const t = state.tickets[String(incident.issue)];
  const grant = state.grants[t?.approval?.grant];
  requireProof(
    t?.origin === "factory" &&
      t.automatic &&
      t.status === "reviewed" &&
      state.active === null &&
      !Object.values(state.grants).some((g) => g.status === "reserved") &&
      same(t.monitor, proofFromIncident(incident)) &&
      reviewGate(state, { number: t.pr, head: t.head }).ok &&
      t.approval?.head === t.head &&
      t.approval.pr === t.pr &&
      t.approval.verdict === "pass" &&
      t.approval.source === "claude-subscription" &&
      t.approval.fixture === false &&
      grant?.ticket === incident.issue &&
      grant.phase === "review" &&
      grant.status === "finished" &&
      grant.outcome === "reviewed" &&
      grant.head === t.head &&
      t.ci?.head === t.head &&
      t.ci.passed === true &&
      t.merge?.status === "merged" &&
      t.merge.pr === t.pr &&
      t.merge.head === t.head &&
      SHA.test(t.merge.mergeCommit)
  );
  return { t, grant };
}
async function verifyRepair({
  api,
  incident,
  issue,
  observation,
  context,
  now = () => new Date().toISOString(),
}) {
  requireProof(
    context.repository === REPOSITORY &&
      context.actor === OWNER &&
      context.triggeringActor === OWNER &&
      context.ref === "refs/heads/main" &&
      context.workflowRef ===
        `${REPOSITORY}/.github/workflows/factory-monitor.yml@refs/heads/main` &&
      SHA.test(context.workflowSha || "") &&
      context.sha === context.workflowSha &&
      context.runAttempt === 1 &&
      ["schedule", "workflow_dispatch"].includes(context.eventName) &&
      /^[1-9]\d{0,15}$/.test(context.runId || "")
  );
  requireProof(
    observation.healthy === true &&
      Object.keys(observation.checks || {})
        .sort()
        .join(",") === "frontend,health,readiness" &&
      Object.values(observation.checks).every((v) => v === "ok") &&
      matchesIssue(issue, { ...issue, number: incident.issue }) &&
      (incident.probeMode !== "feed-contract" || observation.appChecks?.feedContract === "ok")
  );
  requireProof(validateAppChecks(observation.appChecks).healthy);
  requireProof(
    observation.appChecks.releases?.before === observation.release &&
      observation.appChecks.releases.after === observation.release
  );
  const proof = await verifyMonitorIssue(api, issue, {
    proof: proofFromIncident(incident),
    requireActive: false,
  });
  requireProof(proof);
  const { t, grant } = await ledgerTicket(api, incident);
  requireProof(
    t.merge.mergeCommit === observation.release &&
      grant.runId === t.automatic.runId &&
      grant.runAttempt === t.automatic.runAttempt &&
      /^cycle[1-5]$/.test(grant.slot) &&
      t.approval.evidence === `https://github.com/${REPOSITORY}/actions/runs/${grant.runId}`
  );
  const parent = await api.request(
    "GET",
    `${ROOT}/actions/runs/${grant.runId}/attempts/${grant.runAttempt}`
  );
  requireProof(
    String(parent.id) === grant.runId &&
      parent.run_attempt === grant.runAttempt &&
      parent.actor?.login === OWNER &&
      parent.triggering_actor?.login === OWNER
  );
  await workflowRun(api, parent, "factory-automatic.yml", t.automatic.workflowSha, {
    event: ["schedule", "workflow_dispatch"],
  });
  const jobs = await jobList(api, parent);
  successfulJob(
    jobs,
    `${grant.slot} / review / agent`,
    parent.head_sha,
    "Run the one reserved Claude subscription session"
  );
  successfulJob(jobs, `${grant.slot} / assess`, parent.head_sha);
  const pr = await api.request("GET", `${ROOT}/pulls/${t.pr}`);
  requireProof(
    pr.number === t.pr &&
      pr.state === "closed" &&
      pr.merged === true &&
      pr.merge_commit_sha === t.merge.mergeCommit &&
      pr.head?.sha === t.head &&
      pr.head.ref === `agent/factory-${incident.issue}` &&
      pr.head.repo?.full_name === REPOSITORY &&
      pr.base?.repo?.full_name === REPOSITORY &&
      pr.base.ref === "main" &&
      pr.user?.login === `${t.automatic.appSlug}[bot]`
  );
  const deployment = await approvedDeployment(api, t.merge.mergeCommit, context);
  const latest = await ledgerTicket(api, incident);
  requireProof(
    latest.t.head === t.head &&
      latest.t.approval.grant === grant.id &&
      latest.t.merge.mergeCommit === t.merge.mergeCommit
  );
  const at = now();
  return validateRetirement({
    version: 1,
    phase: "intent",
    at,
    verifiedAt: at,
    pr: t.pr,
    head: t.head,
    mergeCommit: t.merge.mergeCommit,
    grantId: grant.id,
    ...deployment,
    approvalActor: OWNER,
    monitorRunId: context.runId,
    workflowSha: context.workflowSha,
    probeMode: incident.probeMode || "standard",
  });
}
async function retireIncident(options) {
  const {
    api,
    store,
    incident,
    issue,
    context,
    observation,
    now = () => new Date().toISOString(),
  } = options;
  const verified = await verifyRepair(options);
  let { state, commit } = await store.read();
  let current = state.incidents[incident.id];
  requireProof(
    state.active === incident.id && same(proofFromIncident(current), proofFromIncident(incident))
  );
  if (current.retirement)
    requireProof(
      ["pr", "head", "mergeCommit", "grantId", "probeMode"].every(
        (k) => current.retirement[k] === verified[k]
      )
    );
  const intent = { ...verified, at: current.retirement?.at || verified.at };
  current.retirement = intent;
  commit = await store.save(state, commit);
  const before = await api.request("GET", `${ROOT}/issues/${incident.issue}`);
  requireProof(matchesIssue(before, issue));
  if (before.state === "open") {
    const closed = await api.request("PATCH", `${ROOT}/issues/${incident.issue}`, {
      state: "closed",
      state_reason: "completed",
    });
    requireProof(
      matchesIssue(closed, issue) &&
        closed.state === "closed" &&
        closed.state_reason === "completed"
    );
  }
  const confirmed = await api.request("GET", `${ROOT}/issues/${incident.issue}`);
  requireProof(
    matchesIssue(confirmed, issue) &&
      confirmed.state === "closed" &&
      confirmed.state_reason === "completed"
  );
  ({ state, commit } = await store.read());
  current = state.incidents[incident.id];
  requireProof(state.active === incident.id && same(current.retirement, intent));
  await ledgerTicket(api, incident);
  current.recovered = true;
  current.retirement = {
    ...intent,
    phase: "complete",
    verifiedAt: now(),
    monitorRunId: context.runId,
    workflowSha: context.workflowSha,
  };
  state.active = null;
  await store.save(state, commit);
  return { outcome: "incident_retired", issue: incident.issue, observation };
}
module.exports = { verifyRepair, retireIncident };
