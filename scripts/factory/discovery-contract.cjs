const { createHash } = require("node:crypto");
const REPOSITORY = "haideearus/cypress-realworld-app";
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/factory-discovery.yml@refs/heads/main`;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const FUNCTIONAL_CHARTERS = Object.freeze([
  "functional-feed",
  "functional-directory",
  "functional-notifications",
]);
const CHARTERS = Object.freeze(["session", "feed", "profile", "journeys", ...FUNCTIONAL_CHARTERS]);
const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const sweepKey = (head, charter, day) => digest([head, charter, day]);
function exact(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  )
    throw Error("Invalid discovery schema");
}
const OWNER = "haideearus";
const OWNER_ID = 101267861;
const FACTORY_APP = "haideearus-software-factory[bot]";
const FACTORY_APP_ID = 356310548;

function actorAllowed(event, actor, triggeringActor) {
  return (
    actor === triggeringActor &&
    (actor === OWNER || (event === "workflow_run" && actor === FACTORY_APP))
  );
}

function runActorOK(run, event = run.event) {
  const actor = run.actor;
  const trigger = run.triggering_actor;
  if (!actorAllowed(event, actor?.login, trigger?.login)) return false;
  if (actor.login === OWNER) return actor.id === OWNER_ID && trigger.id === OWNER_ID;
  return (
    actor.id === FACTORY_APP_ID &&
    trigger.id === FACTORY_APP_ID &&
    actor.type === "Bot" &&
    trigger.type === "Bot"
  );
}

function factoryAppCIOK(run) {
  return (
    run?.actor?.login === FACTORY_APP &&
    runActorOK(run, "workflow_run") &&
    run.run_attempt === 1 &&
    run.head_repository?.full_name === REPOSITORY
  );
}

function contextOK(r) {
  return Boolean(
    r &&
      r.repository === REPOSITORY &&
      actorAllowed(r.event, r.actor, r.triggeringActor) &&
      r.ref === "refs/heads/main" &&
      r.workflowRef === WORKFLOW_REF &&
      SHA.test(r.workflowSha || "") &&
      r.runAttempt === 1 &&
      ["workflow_dispatch", "schedule", "workflow_run"].includes(r.event) &&
      r.phase === "discover" &&
      r.slot === "discovery"
  );
}
function validateProof(d) {
  exact(d, [
    "version",
    "head",
    "charter",
    "day",
    "ciRunId",
    "key",
    "runId",
    "runAttempt",
    "workflowSha",
    "workflowRef",
  ]);
  if (
    d.version !== 1 ||
    !SHA.test(d.head) ||
    !CHARTERS.includes(d.charter) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(d.day) ||
    !/^\d+$/.test(d.ciRunId) ||
    !/^\d+$/.test(d.runId) ||
    d.runAttempt !== 1 ||
    d.workflowRef !== WORKFLOW_REF ||
    d.workflowSha !== d.head ||
    d.key !== sweepKey(d.head, d.charter, d.day)
  )
    throw Error("Invalid discovery provenance");
  return d;
}
function emptyDiscovery() {
  return { version: 1, repository: REPOSITORY, sources: {} };
}
function validateDiscovery(s) {
  exact(s, ["version", "repository", "sources"]);
  if (
    s.version !== 1 ||
    s.repository !== REPOSITORY ||
    !s.sources ||
    Array.isArray(s.sources) ||
    Object.keys(s.sources).length > 400
  )
    throw Error("Discovery registry full or invalid");
  for (const [key, x] of Object.entries(s.sources)) {
    exact(x, ["proof", "status", "issue"]);
    validateProof(x.proof);
    if (
      key !== x.proof.key ||
      !["intent", "created"].includes(x.status) ||
      (x.status === "intent" ? x.issue !== null : !Number.isSafeInteger(x.issue) || x.issue < 1)
    )
      throw Error("Invalid discovery source intent");
  }
  return s;
}
module.exports = {
  REPOSITORY,
  WORKFLOW_REF,
  SHA,
  HASH,
  CHARTERS,
  FUNCTIONAL_CHARTERS,
  digest,
  sweepKey,
  exact,
  FACTORY_APP,
  actorAllowed,
  runActorOK,
  factoryAppCIOK,
  contextOK,
  validateProof,
  emptyDiscovery,
  validateDiscovery,
};
