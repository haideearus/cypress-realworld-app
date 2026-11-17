const { createHash } = require("node:crypto");
const REPOSITORY = "haideearus/cypress-realworld-app";
const OWNER = "haideearus";
const BOT = "github-actions[bot]";
const BOT_ID = 41898282;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[1-9]\d*$/;
const WORKFLOW = ".github/workflows/factory-wake.yml";
const LANES = Object.freeze({
  app: "factory-automatic.yml",
  dependency: "factory-dependencies.yml",
});
const MAX_RECEIPTS = 1200;
const exact = (o, keys) =>
  o &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  Object.keys(o).sort().join(",") === keys.split(",").sort().join(",");
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const time = (t) =>
  typeof t === "string" && Number.isFinite(Date.parse(t)) && new Date(t).toISOString() === t;
const actor = (a) =>
  a &&
  typeof a.login === "string" &&
  /^[a-zA-Z0-9][a-zA-Z0-9[\]-]{0,100}$/.test(a.login) &&
  Number.isSafeInteger(a.id) &&
  a.id > 0;
function validateSignal(s) {
  if (
    !exact(s, "kind,lane,number,head,criteriaHash,revision,sourceRun,sourceAttempt,actor") ||
    !["issue", "monitor", "dependency-ci", "drain"].includes(s.kind) ||
    !LANES[s.lane] ||
    !Number.isSafeInteger(s.number) ||
    s.number < 1 ||
    !SHA.test(s.head) ||
    !HASH.test(s.criteriaHash) ||
    typeof s.revision !== "string" ||
    s.revision.length > 100 ||
    !ID.test(s.sourceRun) ||
    !Number.isSafeInteger(s.sourceAttempt) ||
    s.sourceAttempt < 1 ||
    !actor(s.actor)
  )
    throw Error("Invalid typed wake signal");
  return s;
}
function sourceKey(signal) {
  validateSignal(signal);
  return digest([
    signal.kind,
    signal.lane,
    signal.number,
    signal.head,
    signal.criteriaHash,
    signal.revision,
    signal.kind === "issue" ? null : signal.sourceRun,
    signal.kind === "issue" ? null : signal.sourceAttempt,
  ]);
}
function validateProducer(p) {
  if (
    !exact(p, "runId,runAttempt,workflowSha,actor,event") ||
    !ID.test(p.runId) ||
    p.runAttempt !== 1 ||
    !SHA.test(p.workflowSha) ||
    !actor(p.actor) ||
    !["issues", "workflow_run", "workflow_dispatch"].includes(p.event)
  )
    throw Error("Invalid wake producer");
  return p;
}
function createWake({ signal, lane = signal.lane, producer }) {
  validateSignal(signal);
  validateProducer(producer);
  if (lane !== signal.lane) throw Error("Wake lane mismatch");
  return {
    id: sourceKey(signal),
    signal,
    producer,
    status: "pending",
    receiver: null,
    at: new Date().toISOString(),
  };
}
function validateReceipt(r) {
  if (
    !exact(r, "id,signal,producer,status,receiver,at") ||
    !HASH.test(r.id) ||
    sourceKey(r.signal) !== r.id ||
    !["pending", "observed", "intent", "sent", "bound"].includes(r.status) ||
    !time(r.at)
  )
    throw Error("Invalid wake receipt");
  validateProducer(r.producer);
  if (
    r.receiver !== null &&
    (!exact(r.receiver, "runId,runAttempt,workflowSha") ||
      !ID.test(r.receiver.runId) ||
      r.receiver.runAttempt !== 1 ||
      !SHA.test(r.receiver.workflowSha) ||
      r.status !== "bound")
  )
    throw Error("Invalid wake receiver");
  if (r.status === "bound" && r.receiver === null) throw Error("Missing bound receiver");
  return r;
}
function emptyWakes() {
  return { version: 1, repository: REPOSITORY, receipts: {} };
}
function validateWakes(s) {
  if (
    !exact(s, "version,repository,receipts") ||
    s.version !== 1 ||
    s.repository !== REPOSITORY ||
    !s.receipts ||
    typeof s.receipts !== "object" ||
    Array.isArray(s.receipts) ||
    Object.keys(s.receipts).length > MAX_RECEIPTS
  )
    throw Error("Invalid wake registry");
  for (const [id, r] of Object.entries(s.receipts))
    if (validateReceipt(r).id !== id) throw Error("Wake key mismatch");
  return s;
}
function receiverIdentity(c, lane) {
  return Boolean(
    LANES[lane] &&
      c?.repository === REPOSITORY &&
      c.actor === BOT &&
      c.triggeringActor === BOT &&
      c.ref === "refs/heads/main" &&
      c.event === "workflow_dispatch" &&
      c.workflowRef === `${REPOSITORY}/.github/workflows/${LANES[lane]}@refs/heads/main` &&
      SHA.test(c.workflowSha || "") &&
      ID.test(c.runId || "") &&
      c.runAttempt === 1
  );
}
module.exports = {
  REPOSITORY,
  OWNER,
  BOT,
  BOT_ID,
  SHA,
  HASH,
  ID,
  WORKFLOW,
  LANES,
  MAX_RECEIPTS,
  exact,
  digest,
  actor,
  createWake,
  sourceKey,
  validateSignal,
  validateReceipt,
  emptyWakes,
  validateWakes,
  receiverIdentity,
};
