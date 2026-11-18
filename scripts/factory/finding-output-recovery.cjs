// One explicit output-failure handoff. Historical reservations/receipts stay immutable.
const c = require("./discovery-contract.cjs"),
  slots = require("./active-tickets.cjs");
const retry = require("./finding-retry.cjs"),
  continuation = require("./finding-continuation.cjs");
const ROOT = "/repos/haideearus/cypress-realworld-app";
const PRIOR = {
  ticket: 96,
  grant: "d91d546e-f952-4dea-9fc4-99b053477d92",
  runId: "44376807620",
  head: "23252aeb493185e78fc92c587db3491c4f5164ed",
  grantHash: "289d2505feddf7adc9aa45e073de0fae66070c417a086ca272f003f5579d4667",
  continuationHash: "ea025969a9215cdbbaab6b2ee1fdd56ec7445db6d8651a8832de95344abfd43c",
};
const DECISION = "https://github.com/haideearus/cypress-realworld-app/issues/103";
const historical = () => [retry.PRIOR.grant, continuation.PRIOR.grant, PRIOR.grant];
function refuse() {
  throw Error("Invalid, changed or exhausted finding output recovery");
}
function validateProof(proof) {
  c.exact(proof, [
    "version",
    "priorGrant",
    "runId",
    "runAttempt",
    "workflowSha",
    "head",
    "ciRunId",
    "actor",
    "decision",
  ]);
  if (
    proof.version !== 1 ||
    proof.priorGrant !== PRIOR.grant ||
    !/^[1-9]\d*$/.test(proof.runId || "") ||
    [retry.PRIOR.runId, continuation.PRIOR.runId, PRIOR.runId].includes(proof.runId) ||
    proof.runAttempt !== 1 ||
    !c.SHA.test(proof.head) ||
    proof.head !== proof.workflowSha ||
    !/^[1-9]\d*$/.test(proof.ciRunId || "") ||
    proof.actor !== "haideearus" ||
    proof.decision !== DECISION
  )
    refuse();
  return proof;
}
function validateRecovery(state, id, ticket, grants) {
  const proof = validateProof(ticket.findingOutputRecovery),
    newer = grants.filter((g) => !historical().includes(g.id));
  if (
    Number(id) !== 96 ||
    c.digest(ticket.findingContinuation) !== PRIOR.continuationHash ||
    c.digest(state.grants[PRIOR.grant]) !== PRIOR.grantHash ||
    c.digest(state.grants[continuation.PRIOR.grant]) !== continuation.PRIOR.grantHash ||
    c.digest(state.grants[retry.PRIOR.grant]) !== retry.PRIOR.grantHash ||
    !newer.length ||
    newer[0].phase !== "code" ||
    newer[0].slot !== "cycle1" ||
    newer[0].head !== proof.head ||
    newer.some((g) => g.runId !== proof.runId || g.runAttempt !== proof.runAttempt)
  )
    refuse();
  return proof;
}
function assertEligible(state, request, config) {
  const p = require("./policy.cjs"),
    t = state.tickets["96"],
    proof = validateProof(request.findingOutputRecovery);
  if (
    !p.isAutomaticContext(request) ||
    request.event !== "workflow_dispatch" ||
    request.wake ||
    request.actor !== p.OWNER ||
    request.triggeringActor !== p.OWNER ||
    request.ticket !== 96 ||
    request.phase !== "code" ||
    request.slot !== "cycle1" ||
    request.runAttempt !== 1 ||
    request.findingRetry !== undefined ||
    request.findingContinuation !== undefined ||
    request.recovery !== undefined ||
    request.origin !== undefined ||
    proof.runId !== request.runId ||
    proof.runAttempt !== request.runAttempt ||
    proof.head !== request.head ||
    proof.workflowSha !== request.workflowSha ||
    config.discovery ||
    config.autoMerge ||
    !t ||
    t.status !== "blocked" ||
    t.origin !== "factory" ||
    t.coding !== 3 ||
    t.retries !== 2 ||
    t.reviews !== 0 ||
    t.pr ||
    t.branch ||
    t.approval ||
    t.merge ||
    t.findingRedHash ||
    t.findingOutputRecovery !== undefined ||
    t.head !== PRIOR.head ||
    t.criteriaHash !== retry.PRIOR.criteria ||
    c.digest(t.finding) !== retry.PRIOR.findingHash ||
    c.digest(t.automatic) !== retry.PRIOR.automaticHash ||
    c.digest(t.findingRetry) !== continuation.PRIOR.retryHash ||
    c.digest(t.findingContinuation) !== PRIOR.continuationHash ||
    t.automatic.appSlug !== config.appSlug ||
    c.digest(state.grants[PRIOR.grant]) !== PRIOR.grantHash ||
    c.digest(state.grants[continuation.PRIOR.grant]) !== continuation.PRIOR.grantHash ||
    c.digest(state.grants[retry.PRIOR.grant]) !== retry.PRIOR.grantHash ||
    Object.values(state.grants).filter((g) => g.ticket === 96).length !== 3 ||
    slots.activeEntries(state).length ||
    Object.values(state.grants).some((g) => g.status === "reserved") ||
    Object.values(state.tickets).some(
      (x) =>
        x.merge?.status === "intent" ||
        ((x.automatic || x.dependency) &&
          x.status === "reviewed" &&
          !["merged", "closed"].includes(x.merge?.status))
    )
  )
    refuse();
}
async function verifyFailure(api) {
  const run = await api.request("GET", `${ROOT}/actions/runs/${PRIOR.runId}`);
  if (
    run.id !== Number(PRIOR.runId) ||
    run.run_attempt !== 1 ||
    run.status !== "completed" ||
    run.conclusion !== "failure" ||
    run.head_sha !== PRIOR.head ||
    run.head_branch !== "main" ||
    run.path !== ".github/workflows/factory-automatic.yml" ||
    run.event !== "workflow_dispatch" ||
    run.repository?.full_name !== c.REPOSITORY ||
    run.head_repository?.full_name !== c.REPOSITORY ||
    run.actor?.login !== "haideearus" ||
    run.actor.id !== 101267861 ||
    run.triggering_actor?.login !== "haideearus" ||
    run.triggering_actor.id !== 101267861
  )
    refuse();
  const jobs = await api.pages(
    `${ROOT}/actions/runs/${PRIOR.runId}/attempts/1/jobs?per_page=100`,
    "jobs"
  );
  const coding = jobs.filter((j) => j.name === "cycle1 / coding / agent");
  if (
    jobs.some((j) => j.status !== "completed") ||
    coding.length !== 1 ||
    coding[0].conclusion !== "failure"
  )
    refuse();
  for (const [name, conclusion] of [
    ["Prove finding RED without model credentials", "success"],
    ["Verify the durable reservation and prepare the isolated role", "success"],
    ["Reject secrets in prepared context before the model sees it", "success"],
    ["Run the one reserved Claude subscription session", "success"],
    ["Validate and collect only the role output", "success"],
    ["Prove finding GREEN without model credentials", "success"],
    ["Reject secret-bearing role output before upload", "failure"],
  ])
    if (
      coding[0].steps?.filter((s) => s.name === name).length !== 1 ||
      coding[0].steps.filter((s) => s.name === name && s.conclusion === conclusion).length !== 1
    )
      refuse();
  const invoked = jobs
    .flatMap((j) => j.steps || [])
    .filter(
      (s) =>
        s.name === "Run the one reserved Claude subscription session" && s.conclusion !== "skipped"
    );
  if (invoked.length !== 1 || invoked[0].conclusion !== "success") refuse();
}
module.exports = {
  PRIOR,
  DECISION,
  validateProof,
  validateRecovery,
  assertEligible,
  verifyFailure,
};
