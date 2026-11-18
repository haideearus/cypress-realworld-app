const c = require("./discovery-contract.cjs");
const { ROOT } = require("./github.cjs");

const OWNER_ID = 101267861;
const MAX_ARTIFACT = 4 * 1024 * 1024;
function requireThat(condition, message) {
  if (!condition) throw Error(message);
}
function owner(actor) {
  return actor?.login === "haideearus" && actor.id === OWNER_ID;
}
function identity(run, context, workflow) {
  return Boolean(
    Number.isSafeInteger(workflow.id) &&
      workflow.id > 0 &&
      run.id === Number(context.runId) &&
      run.workflow_id === workflow.id &&
      run.path === workflow.path &&
      run.run_attempt === 1 &&
      run.head_sha === context.workflowSha &&
      run.head_branch === "main" &&
      run.repository?.full_name === c.REPOSITORY &&
      run.head_repository?.full_name === c.REPOSITORY &&
      owner(run.actor) &&
      owner(run.triggering_actor) &&
      run.event === context.event
  );
}
async function pushCI(api, runId, head) {
  const run = await api.request("GET", `${ROOT}/actions/runs/${runId}`);
  const workflow = await api.request("GET", `${ROOT}/actions/workflows/factory-ci.yml`);
  requireThat(
    workflow.path === ".github/workflows/factory-ci.yml" &&
      Number.isSafeInteger(workflow.id) &&
      workflow.id > 0 &&
      run.id === Number(runId) &&
      run.workflow_id === workflow.id &&
      run.path === workflow.path &&
      run.event === "push" &&
      run.run_attempt === 1 &&
      run.head_sha === head &&
      run.head_branch === "main" &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      run.repository?.full_name === c.REPOSITORY &&
      run.head_repository?.full_name === c.REPOSITORY,
    "Recovery requires exact trusted main push CI"
  );
}
async function jobsFor(api, runId) {
  const rows = await api.pages(
    `${ROOT}/actions/runs/${runId}/attempts/1/jobs?per_page=100`,
    "jobs"
  );
  requireThat(Array.isArray(rows), "Invalid recovery producer jobs");
  return rows;
}
function successfulJob(rows, run, name, step) {
  const matches = rows.filter((row) => row.name === name);
  if (matches.length !== 1) return false;
  const job = matches[0];
  if (
    job.status !== "completed" ||
    job.conclusion !== "success" ||
    job.run_id !== run.id ||
    job.run_attempt !== 1 ||
    job.head_sha !== run.head_sha
  )
    return false;
  const steps = job.steps?.filter((row) => row.name === step);
  return (
    steps?.length === 1 && steps[0].status === "completed" && steps[0].conclusion === "success"
  );
}
function artifactOK(artifact, expected, runId, head, size) {
  return Boolean(
    artifact?.id === expected.id &&
      artifact.name === expected.name &&
      artifact.digest === expected.digest &&
      artifact.expired === false &&
      artifact.workflow_run?.id === Number(runId) &&
      artifact.workflow_run.head_sha === head &&
      Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= MAX_ARTIFACT &&
      (size === undefined || artifact.size_in_bytes === size)
  );
}

async function verifyOriginal(api, options = {}) {
  const r = require("./discovery-recovery-contract.cjs");
  const { SOURCE } = r;
  const ledger = options.ledger || new (require("./github.cjs").Ledger)(api);
  const discovery = options.discovery || new (require("./discovery-store.cjs").DiscoveryStore)(api);
  const { state } = await ledger.read();
  const grant = state.grants?.[SOURCE.grantId];
  const ticket = state.tickets?.[String(SOURCE.ticket)];
  requireThat(
    grant?.id === SOURCE.grantId &&
      grant.ticket === SOURCE.ticket &&
      grant.phase === "discover" &&
      grant.slot === "discovery" &&
      grant.status === "finished" &&
      grant.outcome === "blocked" &&
      grant.head === SOURCE.head &&
      grant.runId === SOURCE.runId &&
      grant.runAttempt === 1 &&
      ticket?.origin === "discovery-sweep" &&
      ticket.status === "blocked" &&
      ticket.head === SOURCE.head &&
      ticket.coding === 0 &&
      ticket.reviews === 0 &&
      ticket.retries === 0 &&
      ticket.pr === null &&
      ticket.approval === null,
    "Pinned original discovery source must remain blocked and consumed"
  );
  const proof = c.validateProof(ticket.discovery);
  requireThat(
    proof.head === SOURCE.head &&
      proof.runId === SOURCE.runId &&
      proof.ciRunId === SOURCE.ciRunId &&
      proof.key === SOURCE.sweepHash &&
      state.days?.[proof.day]?.filter((id) => id === SOURCE.ticket).length === 1 &&
      Object.values(state.grants).filter((row) => row.ticket === SOURCE.ticket).length === 1,
    "Original discovery source identity or retained usage changed"
  );
  const source = (await discovery.read()).state.sources?.[SOURCE.sweepHash];
  requireThat(
    source?.status === "created" &&
      source.issue === SOURCE.ticket &&
      c.digest(source.proof) === c.digest(proof),
    "Original discovery audit source mismatch"
  );
  const audit = await api.request("GET", `${ROOT}/issues/${SOURCE.ticket}`);
  requireThat(
    audit.number === SOURCE.ticket &&
      audit.user?.id === 41898282 &&
      audit.user.login === "github-actions[bot]" &&
      audit.user.type === "Bot" &&
      !audit.pull_request &&
      Array.isArray(audit.labels) &&
      audit.labels.length === 0 &&
      audit.body === require("./discovery-run.cjs").sourceBody(proof),
    "Original source audit issue mismatch"
  );
  const workflow = await api.request("GET", `${ROOT}/actions/workflows/factory-discovery.yml`);
  const run = await api.request("GET", `${ROOT}/actions/runs/${SOURCE.runId}/attempts/1`);
  requireThat(
    workflow.path === ".github/workflows/factory-discovery.yml" &&
      identity(
        run,
        { runId: SOURCE.runId, workflowSha: SOURCE.head, event: "workflow_dispatch" },
        workflow
      ) &&
      run.status === "completed" &&
      run.conclusion === "failure",
    "Original failed producer identity mismatch"
  );
  requireThat(
    successfulJob(
      await jobsFor(api, SOURCE.runId),
      run,
      "discover",
      "Run the one reserved Claude discovery session"
    ),
    "Original model job did not succeed"
  );
  await pushCI(api, SOURCE.ciRunId, SOURCE.head);
  const artifact = await api.request("GET", `${ROOT}/actions/artifacts/${SOURCE.artifactId}`);
  requireThat(
    artifactOK(
      artifact,
      { id: SOURCE.artifactId, name: SOURCE.artifactName, digest: SOURCE.artifactDigest },
      SOURCE.runId,
      SOURCE.head,
      SOURCE.artifactSize
    ),
    "Pinned original artifact metadata mismatch"
  );
  return { artifact, proof: structuredClone(proof) };
}

async function verifyProducer(api, context, { complete = true } = {}) {
  const r = require("./discovery-recovery-contract.cjs");
  requireThat(r.contextOK(context), "Untrusted recovery producer context");
  const workflow = await api.request(
    "GET",
    `${ROOT}/actions/workflows/${r.WORKFLOW.split("/").at(-1)}`
  );
  const run = await api.request("GET", `${ROOT}/actions/runs/${context.runId}/attempts/1`);
  requireThat(
    workflow.path === r.WORKFLOW &&
      identity(run, context, workflow) &&
      (complete
        ? run.status === "completed" && ["success", "failure"].includes(run.conclusion)
        : run.status === "in_progress" && run.conclusion === null),
    "Recovery producer identity mismatch"
  );
  await pushCI(api, context.ciRunId, context.workflowSha);
  return run;
}

async function verifyReceipt(api, candidate, options = {}) {
  const r = require("./discovery-recovery-contract.cjs");
  require("./discovery-finding-contract.cjs").validateCandidate(candidate);
  const recovery = r.validateProof(candidate.source.recovery);
  const original = await verifyOriginal(api, options);
  const { recovery: ignored, grantId, ...source } = candidate.source;
  requireThat(
    grantId === r.SOURCE.grantId && c.digest(source) === c.digest(original.proof),
    "Recovery candidate original source mismatch"
  );
  const store = options.store || new (require("./discovery-finding-store.cjs").FindingStore)(api);
  const entry = (await store.read()).state.imports?.[r.SOURCE.grantId];
  requireThat(entry?.runId === r.SOURCE.runId, "Missing original recovery import receipt");
  const receipts = r.validateRecoveries(entry.recoveries);
  const receipt = receipts.find((row) => row.proof.id === recovery.id);
  requireThat(
    receipt?.outcome === "assessed" &&
      receipt.confirmation &&
      c.digest(receipt.proof) === c.digest(recovery) &&
      c.digest(receipt.artifact) === c.digest(candidate.artifact),
    "Missing matching assessed durable recovery receipt"
  );
  const replayRun = await verifyProducer(api, recovery.context);
  requireThat(
    successfulJob(
      await jobsFor(api, recovery.context.runId),
      replayRun,
      "replay",
      "Replay saved privacy candidates without a model"
    ),
    "Recovery replay job did not succeed"
  );
  const confirmation = await verifyProducer(api, receipt.confirmation);
  const sameRun = receipt.confirmation.runId === recovery.context.runId;
  requireThat(
    confirmation.conclusion === "success" &&
      successfulJob(
        await jobsFor(api, receipt.confirmation.runId),
        confirmation,
        sameRun ? "finalize" : "select",
        sameRun
          ? "Retain recovered proof or a visible hold"
          : "Verify source and reserve or reconcile recovery"
      ),
    "Recovery finalization or reconciliation confirmation did not succeed"
  );
  const artifact = await api.request("GET", `${ROOT}/actions/artifacts/${receipt.artifact.id}`);
  requireThat(
    artifactOK(artifact, receipt.artifact, recovery.context.runId, recovery.context.workflowSha),
    "Recovery evidence artifact metadata mismatch"
  );
  return { artifact, proof: original.proof, receipt: structuredClone(receipt) };
}

module.exports = { verifyOriginal, verifyProducer, verifyReceipt };
