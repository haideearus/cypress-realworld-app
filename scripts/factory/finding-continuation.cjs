// A second, separately approved handoff. Neither earlier receipt is rewritten.
const c = require("./discovery-contract.cjs");
const slots = require("./active-tickets.cjs");
const retry = require("./finding-retry.cjs");
const ROOT = "/repos/haideearus/cypress-realworld-app";
const PRIOR = {
  ticket: 96,
  grant: "33bce768-5170-4d31-80fb-1e19cef4b790",
  runId: "44355891864",
  head: "14fd8c02d89edb7876e5a6d2e8385f5ca0e67df1",
  grantHash: "25a6603ed2fbb8508f883bc1051e062731598cbd89769d3746bb1fe2823f5160",
  retryHash: "0e5e315ec4acda1e479d985617cbb658033c36c9db606bc9524055b23f76511b",
};
const DECISION = "https://github.com/haideearus/cypress-realworld-app/issues/100";
function refuse() {
  throw Error("Invalid, changed or exhausted finding continuation");
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
    [PRIOR.runId, retry.PRIOR.runId].includes(proof.runId) ||
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
function validateContinuation(state, id, ticket, grants) {
  const proof = validateProof(ticket.findingContinuation);
  // policy validates the later receipt first; it cannot hide unvalidated grants.
  const newer = grants.filter(
    (g) =>
      ![PRIOR.grant, retry.PRIOR.grant].includes(g.id) &&
      (!ticket.findingOutputRecovery || g.runId !== ticket.findingOutputRecovery.runId)
  );
  if (
    Number(id) !== 96 ||
    !ticket.findingRetry ||
    c.digest(ticket.findingRetry) !== PRIOR.retryHash ||
    c.digest(state.grants[PRIOR.grant]) !== PRIOR.grantHash ||
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
    proof = validateProof(request.findingContinuation);
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
    request.findingOutputRecovery !== undefined ||
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
    t.coding !== 2 ||
    t.retries !== 1 ||
    t.reviews !== 0 ||
    t.pr ||
    t.branch ||
    t.approval ||
    t.merge ||
    t.findingRedHash ||
    t.findingContinuation !== undefined ||
    t.head !== PRIOR.head ||
    t.criteriaHash !== retry.PRIOR.criteria ||
    c.digest(t.findingRetry) !== PRIOR.retryHash ||
    c.digest(t.finding) !== retry.PRIOR.findingHash ||
    c.digest(t.automatic) !== retry.PRIOR.automaticHash ||
    t.automatic.appSlug !== config.appSlug ||
    c.digest(state.grants[PRIOR.grant]) !== PRIOR.grantHash ||
    c.digest(state.grants[retry.PRIOR.grant]) !== retry.PRIOR.grantHash ||
    Object.values(state.grants).filter((g) => g.ticket === 96).length !== 2 ||
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
  const steps = coding[0].steps || [];
  for (const [name, conclusion] of [
    ["Prove finding RED without model credentials", "success"],
    ["Verify the durable reservation and prepare the isolated role", "success"],
    ["Reject secrets in prepared context before the model sees it", "failure"],
    ["Run the one reserved Claude subscription session", "skipped"],
  ])
    if (
      steps.filter((s) => s.name === name).length !== 1 ||
      steps.filter((s) => s.name === name && s.conclusion === conclusion).length !== 1
    )
      refuse();
  if (
    jobs
      .flatMap((j) => j.steps || [])
      .some(
        (s) =>
          s.name === "Run the one reserved Claude subscription session" &&
          s.conclusion !== "skipped"
      )
  )
    refuse();
}
module.exports = {
  PRIOR,
  DECISION,
  validateProof,
  validateContinuation,
  assertEligible,
  verifyFailure,
};
