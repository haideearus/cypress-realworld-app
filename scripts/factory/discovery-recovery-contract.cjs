const c = require("./discovery-contract.cjs");

const WORKFLOW = ".github/workflows/factory-discovery-recovery.yml";
const WORKFLOW_REF = `${c.REPOSITORY}/${WORKFLOW}@refs/heads/main`;
const SOURCE = Object.freeze({
  head: "822b51fb2bb3eaa59d60a109097cc3575e6373d3",
  grantId: "d25c438f-35df-449e-9fe0-ec20d87738f5",
  runId: "44197159640",
  ticket: 92,
  runAttempt: 1,
  ciRunId: "44193429894",
  sweepHash: "a08fb48436040bc3ad2e14967e84098e6e98ab708f2f8913ce89860538721639",
  artifactId: 14380786056,
  artifactName: "discovery-d25c438f-35df-449e-9fe0-ec20d87738f5",
  artifactDigest: "sha256:8fee701b78e201e4a32782633da6163c613b2350320614257aafa477e8ff0a05",
  artifactSize: 4281,
  bundleHash: "6ba3e7d6635a5c747326e76dab7ec640ce82832d7100e09317d37d9aa738eacf",
  sourceHash: "bad7b28832236656c8998da41272536f358ac4debc1985f81ac588a76d49d596",
  reportHash: "5d3e014e9c20f031a24f0f56abf35f553fb366b4feb27b1b1bcd9af7e51db6d6",
});
const CONTEXT_KEYS = [
  "repository",
  "actor",
  "triggeringActor",
  "ref",
  "event",
  "workflowRef",
  "workflowSha",
  "runId",
  "runAttempt",
  "ciRunId",
];
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const runId = (value) =>
  typeof value === "string" && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
const dayOK = (day) =>
  typeof day === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(day) &&
  Number.isFinite(Date.parse(day)) &&
  new Date(day).toISOString().slice(0, 10) === day;

function contextOK(context) {
  return Boolean(
    context &&
      context.repository === c.REPOSITORY &&
      context.actor === "haideearus" &&
      context.triggeringActor === "haideearus" &&
      context.ref === "refs/heads/main" &&
      context.event === "workflow_dispatch" &&
      context.workflowRef === WORKFLOW_REF &&
      c.SHA.test(context.workflowSha || "") &&
      runId(context.runId) &&
      context.runAttempt === 1 &&
      runId(context.ciRunId) &&
      context.ciRunId !== context.runId
  );
}
function normalizedContext(context) {
  if (!contextOK(context)) throw Error("Invalid trusted recovery context");
  return Object.fromEntries(CONTEXT_KEYS.map((key) => [key, context[key]]));
}
function validateContext(context) {
  c.exact(context, CONTEXT_KEYS);
  if (!contextOK(context)) throw Error("Invalid trusted recovery context");
}
function makeProof(context) {
  const trusted = normalizedContext(context);
  return {
    version: 1,
    id: c.digest([SOURCE.grantId, trusted.runId, trusted.workflowSha]),
    source: { ...SOURCE },
    context: trusted,
  };
}
function validateProof(proof) {
  c.exact(proof, ["version", "id", "source", "context"]);
  validateContext(proof.context);
  c.exact(proof.source, Object.keys(SOURCE));
  if (
    proof.version !== 1 ||
    Object.keys(SOURCE).some((key) => proof.source[key] !== SOURCE[key]) ||
    proof.id !== c.digest([SOURCE.grantId, proof.context.runId, proof.context.workflowSha])
  )
    throw Error("Invalid pinned recovery source proof");
  return proof;
}
function artifactName(proof) {
  validateProof(proof);
  return `discovery-recovery-${proof.id}`;
}
function validateArtifact(artifact, proof) {
  c.exact(artifact, ["id", "name", "workflowRunId", "digest"]);
  if (
    !Number.isSafeInteger(artifact.id) ||
    artifact.id < 1 ||
    artifact.name !== artifactName(proof) ||
    artifact.workflowRunId !== proof.context.runId ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest || "")
  )
    throw Error("Invalid recovery artifact identity");
}
function validateReceipt(receipt) {
  c.exact(receipt, ["proof", "day", "outcome", "artifact", "confirmation"]);
  validateProof(receipt.proof);
  if (!dayOK(receipt.day) || !["intent", "held", "assessed"].includes(receipt.outcome))
    throw Error("Invalid recovery receipt");
  if (receipt.outcome === "intent") {
    if (receipt.artifact !== null || receipt.confirmation !== null)
      throw Error("Invalid unfinished recovery receipt");
  } else {
    validateContext(receipt.confirmation);
    if (receipt.outcome === "held") {
      if (receipt.artifact !== null) throw Error("Invalid held recovery receipt");
    } else validateArtifact(receipt.artifact, receipt.proof);
  }
  return receipt;
}
function validateRecoveries(recoveries) {
  if (!Array.isArray(recoveries) || recoveries.length > 2)
    throw Error("Invalid or full recovery receipts");
  const ids = new Set(),
    runs = new Set();
  let pending = 0;
  for (const receipt of recoveries) {
    validateReceipt(receipt);
    if (ids.has(receipt.proof.id) || runs.has(receipt.proof.context.runId))
      throw Error("Duplicate recovery receipt identity");
    ids.add(receipt.proof.id);
    runs.add(receipt.proof.context.runId);
    if (receipt.outcome === "intent") pending++;
  }
  if (pending > 1) throw Error("Unreconciled recovery receipts");
  return recoveries;
}
function validateBundle(bundle) {
  if (
    !record(bundle) ||
    bundle.version !== 1 ||
    bundle.head !== SOURCE.head ||
    bundle.grantId !== SOURCE.grantId ||
    bundle.ticket !== SOURCE.ticket ||
    bundle.runId !== SOURCE.runId ||
    bundle.runAttempt !== 1 ||
    bundle.source !== "claude-subscription" ||
    bundle.fixture !== false ||
    bundle.sourceHash !== SOURCE.sourceHash ||
    c.digest(bundle.report) !== SOURCE.reportHash ||
    c.digest(bundle) !== SOURCE.bundleHash
  )
    throw Error("Invalid pinned original discovery bundle or source identity");
  return bundle;
}
function metadata(state) {
  if (!record(state) || !record(state.imports) || !record(state.replays))
    throw Error("Existing finding registry metadata is required");
  return state.imports;
}
function dailyUsage(state, day) {
  const imports = metadata(state);
  if (!dayOK(day)) throw Error("Invalid recovery quota day");
  let count = Object.values(state.replays).filter((receipt) => receipt?.day === day).length;
  for (const [grant, entry] of Object.entries(imports)) {
    if (entry?.recoveries === undefined) continue;
    if (grant !== SOURCE.grantId || entry.runId !== SOURCE.runId)
      throw Error("Recovery receipts require the pinned source import");
    count += validateRecoveries(entry.recoveries).filter((receipt) => receipt.day === day).length;
  }
  return count;
}
function reserve(state, context, day) {
  const imports = metadata(state),
    proof = makeProof(context);
  if (!dayOK(day)) throw Error("Invalid recovery quota day");
  const entry = imports[SOURCE.grantId];
  if (entry && entry.runId !== SOURCE.runId) throw Error("Recovery source import identity changed");
  const recoveries = entry?.recoveries === undefined ? [] : validateRecoveries(entry.recoveries);
  const prior = recoveries.find((receipt) => receipt.proof.context.runId === proof.context.runId);
  if (prior) {
    if (c.digest(prior.proof) !== c.digest(proof))
      throw Error("Recovery run context identity changed");
    return prior;
  }
  if (recoveries.some((receipt) => receipt.outcome === "intent"))
    throw Error("Reconcile the retained recovery intention before another attempt");
  if (recoveries.some((receipt) => receipt.outcome === "assessed"))
    throw Error("The saved source already has a completed recovery assessment");
  if (recoveries.length >= 2 || dailyUsage(state, day) >= 8)
    throw Error("Recovery replay limit reached");
  if (!entry && Object.keys(imports).length >= 400)
    throw Error("Recovery metadata history limit reached");
  const receipt = { proof, day, outcome: "intent", artifact: null, confirmation: null };
  validateReceipt(receipt);
  if (!entry)
    imports[SOURCE.grantId] = {
      runId: SOURCE.runId,
      evidenceHash: null,
      findings: [],
      status: "held-evidence",
      recoveries: [],
    };
  if (imports[SOURCE.grantId].recoveries === undefined) imports[SOURCE.grantId].recoveries = [];
  imports[SOURCE.grantId].recoveries.push(receipt);
  return receipt;
}
function finish(state, id, artifact, context) {
  const imports = metadata(state),
    confirmation = normalizedContext(context);
  const entry = imports[SOURCE.grantId];
  if (!entry || entry.runId !== SOURCE.runId) throw Error("Missing pinned recovery source receipt");
  const receipt = validateRecoveries(entry.recoveries).find((row) => row.proof.id === id);
  if (!receipt) throw Error("Missing retained recovery intention");
  if (artifact !== null) validateArtifact(artifact, receipt.proof);
  if (receipt.outcome !== "intent") {
    if (c.digest(receipt.artifact) !== c.digest(artifact))
      throw Error("Terminal recovery receipt cannot be changed or promoted");
    return receipt;
  }
  const finished = {
    ...receipt,
    outcome: artifact === null ? "held" : "assessed",
    artifact: artifact === null ? null : structuredClone(artifact),
    confirmation,
  };
  validateReceipt(finished);
  Object.assign(receipt, finished);
  return receipt;
}

module.exports = {
  SOURCE,
  WORKFLOW,
  WORKFLOW_REF,
  contextOK,
  makeProof,
  validateProof,
  artifactName,
  validateArtifact,
  validateReceipt,
  validateRecoveries,
  validateBundle,
  dailyUsage,
  reserve,
  finish,
};
