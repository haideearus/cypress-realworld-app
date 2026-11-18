// One final handoff for a pinned, pre-model GitHub API failure.
const c = require("./discovery-contract.cjs");
const slots = require("./active-tickets.cjs");
const { PRIOR: original } = require("./finding-retry.cjs");
const { PRIOR: continuation } = require("./finding-continuation.cjs");
const { PRIOR: output } = require("./finding-output-recovery.cjs");
const ROOT = "/repos/haideearus/cypress-realworld-app";
const PRIOR = {
  grant: "45870dc6-ff8e-4d8e-a01c-72756a11cf19",
  grantHash: "11bb38dd997da0121ec3f7abfcb2fc13f5b219fc9bfd7e8ebeb7957c85c302c2",
  receiptHash: "759a82f384808850a35213f10666659cbbd2b99e7688c7f641c03c1610ca43c0",
  runId: "44398068245",
  jobId: 135133729529,
  head: "4c27e05d1de2fd75e705d114a1cb44cfd0598359",
};
const DECISION = "https://github.com/haideearus/cypress-realworld-app/issues/105";
const historicalRuns = new Set(
  [original, continuation, output, PRIOR].map((record) => record.runId)
);
const modelStep = "Run the one reserved Claude subscription session";

function refuse() {
  throw Error("Invalid, changed or exhausted finding API recovery");
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
    typeof proof.runId !== "string" ||
    !/^[1-9]\d*$/.test(proof.runId) ||
    historicalRuns.has(proof.runId) ||
    proof.runAttempt !== 1 ||
    typeof proof.head !== "string" ||
    !c.SHA.test(proof.head) ||
    proof.head !== proof.workflowSha ||
    proof.head === PRIOR.head ||
    typeof proof.ciRunId !== "string" ||
    !/^[1-9]\d*$/.test(proof.ciRunId) ||
    proof.actor !== "haideearus" ||
    proof.decision !== DECISION
  )
    refuse();
  return proof;
}

function verifyHistory(state, ticket) {
  if (
    !ticket?.findingRetry ||
    !ticket.findingContinuation ||
    !ticket.findingOutputRecovery ||
    c.digest(ticket.findingOutputRecovery) !== PRIOR.receiptHash ||
    !state.grants[PRIOR.grant] ||
    c.digest(state.grants[PRIOR.grant]) !== PRIOR.grantHash
  )
    refuse();
}

function validateRecovery(state, id, ticket, grants) {
  if (ticket.findingApiRecovery === undefined) {
    if (Number(id) === 96 && ticket.coding > 4 && state.grants[PRIOR.grant]) refuse();
    return grants;
  }
  const proof = validateProof(ticket.findingApiRecovery);
  verifyHistory(state, ticket);
  if (
    Number(id) !== 96 ||
    ticket.coding !== 5 ||
    ticket.retries !== 4 ||
    ticket.reviews > 1 ||
    ticket.merge !== undefined
  )
    refuse();
  const previous = grants.filter((grant) => grant.runId !== proof.runId);
  const current = grants.filter((grant) => grant.runId === proof.runId);
  const [code, review] = current;
  if (
    previous.length !== 4 ||
    !previous.some((grant) => grant.id === PRIOR.grant) ||
    current.length !== 1 + ticket.reviews ||
    current.some((grant) => grant.runAttempt !== 1 || grant.slot !== "cycle1") ||
    code?.phase !== "code" ||
    code.head !== proof.head ||
    (review && review.phase !== "review")
  )
    refuse();
  // The existing output-recovery, continuation and retry validators check these grants.
  return previous;
}

function assertEligible(state, request, config) {
  const p = require("./policy.cjs");
  const t = state.tickets["96"];
  const proof = validateProof(request.findingApiRecovery);
  verifyHistory(state, t);
  if (
    !p.isAutomaticContext(request) ||
    request.event !== "workflow_dispatch" ||
    request.actor !== p.OWNER ||
    request.triggeringActor !== p.OWNER ||
    request.wake ||
    request.ticket !== 96 ||
    request.phase !== "code" ||
    request.slot !== "cycle1" ||
    request.runAttempt !== 1 ||
    request.origin !== undefined ||
    proof.runId !== request.runId ||
    proof.head !== request.head ||
    proof.workflowSha !== request.workflowSha ||
    config.discovery ||
    config.autoMerge ||
    t.origin !== "factory" ||
    t.status !== "blocked" ||
    t.head !== PRIOR.head ||
    t.coding !== 4 ||
    t.retries !== 3 ||
    t.reviews !== 0 ||
    t.pr ||
    t.branch ||
    t.approval ||
    t.merge ||
    t.findingRedHash ||
    t.findingApiRecovery !== undefined ||
    t.criteriaHash !== original.criteria ||
    t.automatic?.appSlug !== config.appSlug ||
    c.digest(t.finding) !== original.findingHash ||
    c.digest(t.automatic) !== original.automaticHash ||
    Object.values(state.grants).filter((grant) => grant.ticket === 96).length !== 4 ||
    slots.activeEntries(state).length ||
    Object.values(state.grants).some((grant) => grant.status === "reserved") ||
    Object.values(state.tickets).some(
      (ticket) =>
        ticket.merge?.status === "intent" ||
        ((ticket.automatic || ticket.dependency) &&
          ticket.status === "reviewed" &&
          !["merged", "closed"].includes(ticket.merge?.status))
    )
  )
    refuse();
}

async function verifyFailure(api) {
  const run = await api.request("GET", `${ROOT}/actions/runs/${PRIOR.runId}`);
  const owner = (actor) => actor?.login === "haideearus" && actor.id === 101267861;
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
    !owner(run.actor) ||
    !owner(run.triggering_actor)
  )
    refuse();
  const jobs = await api.pages(
    `${ROOT}/actions/runs/${PRIOR.runId}/attempts/1/jobs?per_page=100`,
    "jobs"
  );
  const matches = jobs.filter((job) => job.name === "cycle1 / coding / agent");
  const [coding] = matches;
  if (
    jobs.some((job) => job.status !== "completed") ||
    matches.length !== 1 ||
    coding.id !== PRIOR.jobId ||
    coding.conclusion !== "failure"
  )
    refuse();
  const uniqueResult = (items, name, conclusion) => {
    const rows = items.filter((item) => item.name === name);
    return rows.length === 1 && rows[0].conclusion === conclusion;
  };
  const requiredSteps = [
    ["Check out only the reserved commit", "success"],
    ["Reject secrets in the reserved source before model file access", "success"],
    ["Resolve receipt-backed discovery origin", "failure"],
    ["Prove finding RED without model credentials", "skipped"],
    [modelStep, "skipped"],
  ];
  if (
    requiredSteps.some(([name, result]) => !uniqueResult(coding.steps || [], name, result)) ||
    !uniqueResult(jobs, "cycle1 / assess", "success") ||
    !uniqueResult(jobs, "cycle1 / publish", "skipped") ||
    !uniqueResult(jobs, "merge", "skipped") ||
    jobs.some((job) =>
      job.steps?.some((step) => step.name === modelStep && step.conclusion !== "skipped")
    )
  )
    refuse();
}

module.exports = { PRIOR, DECISION, validateRecovery, assertEligible, verifyFailure };
