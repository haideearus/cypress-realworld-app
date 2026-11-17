const c = require("./discovery-contract.cjs");
const f = require("./discovery-finding-contract.cjs");
const { ROOT, Ledger } = require("./github.cjs");
const { DiscoveryStore } = require("./discovery-store.cjs");
const { FindingStore } = require("./discovery-finding-store.cjs");

async function producer(api, context, { complete = true } = {}) {
  if (!f.contextOK(context)) throw Error("Untrusted finding producer context");
  const file = f.WORKFLOW.split("/").at(-1);
  const run = await api.request("GET", `${ROOT}/actions/runs/${context.runId}/attempts/1`);
  const workflow = await api.request("GET", `${ROOT}/actions/workflows/${file}`);
  if (
    workflow.path !== f.WORKFLOW ||
    run.workflow_id !== workflow.id ||
    run.id !== Number(context.runId) ||
    run.run_attempt !== 1 ||
    run.path !== f.WORKFLOW ||
    run.head_branch !== "main" ||
    run.head_sha !== context.workflowSha ||
    run.repository?.full_name !== c.REPOSITORY ||
    run.head_repository?.full_name !== c.REPOSITORY ||
    run.actor?.login !== "haideearus" ||
    run.actor.id !== 101267861 ||
    run.triggering_actor?.login !== "haideearus" ||
    run.triggering_actor.id !== 101267861 ||
    run.event !== context.event ||
    (complete ? run.status !== "completed" : run.status !== "in_progress")
  )
    throw Error("Finding producer identity mismatch");
  return run;
}
async function successfulJob(api, runId, name, step) {
  const rows = await api.pages(
    `${ROOT}/actions/runs/${runId}/attempts/1/jobs?per_page=100`,
    "jobs"
  );
  const matches = rows.filter((j) => j.name === name);
  return (
    matches.length === 1 &&
    matches[0].status === "completed" &&
    matches[0].conclusion === "success" &&
    (!step ||
      matches[0].steps?.filter((s) => s.name === step && s.conclusion === "success").length === 1)
  );
}
async function verifySource(
  api,
  candidate,
  { ledger = new Ledger(api), discovery = new DiscoveryStore(api) } = {}
) {
  f.validateCandidate(candidate);
  const proof = f.sourceProof(candidate.source);
  const { state } = await ledger.read();
  const grant = state.grants[candidate.source.grantId];
  const ticket = grant && state.tickets[String(grant.ticket)];
  if (
    !grant ||
    grant.phase !== "discover" ||
    grant.slot !== "discovery" ||
    grant.status !== "finished" ||
    grant.outcome !== "discovery_complete" ||
    grant.head !== proof.head ||
    grant.runId !== proof.runId ||
    grant.runAttempt !== 1 ||
    ticket?.origin !== "discovery-sweep" ||
    ticket.status !== "discovery_complete" ||
    c.digest(ticket.discovery) !== c.digest(proof)
  )
    return false;
  const source = (await discovery.read()).state.sources[proof.key];
  if (
    !source ||
    source.status !== "created" ||
    source.issue !== grant.ticket ||
    c.digest(source.proof) !== c.digest(proof)
  )
    return false;
  const audit = await api.request("GET", `${ROOT}/issues/${source.issue}`);
  if (
    audit.user?.id !== 41898282 ||
    audit.user?.login !== "github-actions[bot]" ||
    audit.pull_request ||
    audit.body !== require("./discovery-run.cjs").sourceBody(proof) ||
    audit.labels?.length !== 0
  )
    return false;
  const run = await api.request("GET", `${ROOT}/actions/runs/${proof.runId}/attempts/1`);
  const workflow = await api.request("GET", `${ROOT}/actions/workflows/factory-discovery.yml`);
  if (
    workflow.path !== ".github/workflows/factory-discovery.yml" ||
    run.workflow_id !== workflow.id ||
    run.id !== Number(proof.runId) ||
    run.path !== workflow.path ||
    run.run_attempt !== 1 ||
    run.head_sha !== proof.head ||
    run.head_branch !== "main" ||
    run.repository?.full_name !== c.REPOSITORY ||
    run.head_repository?.full_name !== c.REPOSITORY ||
    run.actor?.login !== "haideearus" ||
    run.actor.id !== 101267861 ||
    run.triggering_actor?.login !== "haideearus" ||
    !["schedule", "workflow_run", "workflow_dispatch"].includes(run.event) ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  )
    return false;
  if (
    !(await successfulJob(
      api,
      proof.runId,
      "discover",
      "Run the one reserved Claude discovery session"
    )) ||
    !(await successfulJob(
      api,
      proof.runId,
      "replay",
      "Rebuild baseline and replay twice without a model credential"
    )) ||
    !(await successfulJob(api, proof.runId, "finalize"))
  )
    return false;
  const ci = await api.request("GET", `${ROOT}/actions/runs/${proof.ciRunId}`);
  if (
    ci.path !== ".github/workflows/factory-ci.yml" ||
    ci.event !== "push" ||
    ci.head_sha !== proof.head ||
    ci.head_branch !== "main" ||
    ci.status !== "completed" ||
    ci.conclusion !== "success" ||
    ci.repository?.full_name !== c.REPOSITORY
  )
    return false;
  const artifact = await api.request("GET", `${ROOT}/actions/artifacts/${candidate.artifact.id}`);
  return (
    artifact.id === candidate.artifact.id &&
    artifact.name === candidate.artifact.name &&
    artifact.expired === false &&
    artifact.digest === candidate.artifact.digest &&
    artifact.workflow_run?.id === Number(proof.runId) &&
    artifact.workflow_run?.head_sha === proof.head &&
    Number.isSafeInteger(artifact.size_in_bytes) &&
    artifact.size_in_bytes > 0 &&
    artifact.size_in_bytes <= 4000000
  );
}
async function verifyDiscoveryIssue(
  api,
  issue,
  { proof, requireCurrent = true, store = new FindingStore(api), verify = verifySource } = {}
) {
  if (
    issue?.user?.id !== 41898282 ||
    issue.user.login !== "github-actions[bot]" ||
    issue.user.type !== "Bot" ||
    issue.pull_request ||
    !Number.isSafeInteger(issue.number)
  )
    return null;
  if (proof) f.validateOriginProof(proof);
  let state;
  try {
    state = (await store.read()).state;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
  const matches = Object.values(state.records).filter((r) => r.publication?.issue === issue.number);
  if (matches.length !== 1) return null;
  const r = matches[0];
  if (
    !require("./discovery-publication.cjs").issueMatches(issue, r) ||
    !["published", "held-evidence"].includes(r.status) ||
    !(await verify(api, r.candidate))
  )
    return null;
  const actual = f.originProof(r);
  if (proof && c.digest(actual) !== c.digest(proof)) return null;
  // The issue is not trusted until the real publisher job has finished successfully.
  await producer(api, r.publication.context);
  if (!r.publication.confirmation) return null;
  await producer(api, r.publication.confirmation);
  if (
    !(await successfulJob(
      api,
      r.publication.confirmation.runId,
      "publish",
      "Publish verified findings without a model"
    ))
  )
    return null;
  if (!r.intake || r.intake.outcome !== "ready") return null;
  await producer(api, r.intake.context);
  if (
    !(await successfulJob(
      api,
      r.intake.context.runId,
      "replay",
      "Replay current main without credentials"
    )) ||
    !(await successfulJob(
      api,
      r.intake.context.runId,
      "finalize",
      "Retain current-head intake or a visible hold"
    ))
  )
    return null;
  if (requireCurrent) {
    const main = await api.request("GET", `${ROOT}/branches/main`);
    if (r.intake.head !== main.commit?.sha) return null;
    const ci = await api.request("GET", `${ROOT}/actions/runs/${r.intake.ciRunId}`);
    if (
      ci.path !== ".github/workflows/factory-ci.yml" ||
      ci.event !== "push" ||
      ci.head_sha !== r.intake.head ||
      ci.head_branch !== "main" ||
      ci.status !== "completed" ||
      ci.conclusion !== "success" ||
      ci.repository?.full_name !== c.REPOSITORY
    )
      return null;
  }
  return actual;
}
async function findingForAdmission(api, issue) {
  const origin = await verifyDiscoveryIssue(api, issue);
  if (!origin) return null;
  const record = (await new FindingStore(api).read()).state.records[origin.key];
  if (!record?.intake || record.intake.outcome !== "ready") return null;
  return { origin, intake: structuredClone(record.intake) };
}
async function verifyRepairOrigin(api, issue, finding, { requireCurrent = false } = {}) {
  f.validateOriginProof(finding.origin);
  f.validateReplay(finding.intake);
  if (finding.intake.outcome !== "ready" || finding.intake.key !== finding.origin.key) return false;
  const proof = await verifyDiscoveryIssue(api, issue, { proof: finding.origin, requireCurrent });
  if (!proof) return false;
  const record = (await new FindingStore(api).read()).state.records[proof.key];
  return c.digest(record.intake) === c.digest(finding.intake);
}
module.exports = {
  producer,
  successfulJob,
  verifySource,
  verifyDiscoveryIssue,
  findingForAdmission,
  verifyRepairOrigin,
};
