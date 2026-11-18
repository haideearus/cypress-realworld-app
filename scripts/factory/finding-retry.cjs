// One owner-approved infrastructure retry. This is not a queue or a new allowance.
const c = require("./discovery-contract.cjs");
const slots = require("./active-tickets.cjs");
const ROOT = "/repos/haideearus/cypress-realworld-app";
const PRIOR = {
  ticket: 96,
  grant: "4fbec36c-7e05-4d0e-b91f-a912b4d8c505",
  runId: "44338765984",
  head: "0f9c7511344de041d250ec85983ae9d07188a52b",
  grantHash: "cf37ef9568fc9a9c75b90b793b48d1d263d9dcf2e080b4e0d4462518faed105b",
  findingHash: "6d1f0e11e6426200cd332e895f72964eaad14376d29cc272faadc1bb6d12b2df",
  automaticHash: "652a9a69458ccbfdb2de424b84f2b2f55e48aef2569b14d4b32ce3ed33e81b57",
  criteria: "0d4c7c6abaff83c3be31fc6501555ec1c202a9d047d7e209a928653444244b71",
};
const DECISION = "https://github.com/haideearus/cypress-realworld-app/issues/98";
function refuse() {
  throw Error("Invalid, changed or exhausted finding retry");
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
    proof.runId === PRIOR.runId ||
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
function validateRetry(state, id, ticket, grants) {
  const proof = validateProof(ticket.findingRetry);
  const other = grants.filter((g) => g.id !== PRIOR.grant);
  if (
    Number(id) !== PRIOR.ticket ||
    !ticket.finding ||
    !ticket.automatic ||
    c.digest(ticket.finding) !== PRIOR.findingHash ||
    c.digest(ticket.automatic) !== PRIOR.automaticHash ||
    ticket.criteriaHash !== PRIOR.criteria ||
    c.digest(state.grants[PRIOR.grant]) !== PRIOR.grantHash ||
    !other.length ||
    other[0].phase !== "code" ||
    other[0].slot !== "cycle1" ||
    other[0].head !== proof.head ||
    other.some((g) => g.runId !== proof.runId || g.runAttempt !== proof.runAttempt)
  )
    refuse();
  return proof;
}
function assertEligible(state, request, config) {
  const p = require("./policy.cjs");
  const t = state.tickets[String(PRIOR.ticket)];
  validateProof(request.findingRetry);
  const proof = request.findingRetry;
  if (
    !p.isAutomaticContext(request) ||
    request.event !== "workflow_dispatch" ||
    request.wake ||
    request.actor !== p.OWNER ||
    request.triggeringActor !== p.OWNER ||
    request.ticket !== PRIOR.ticket ||
    request.phase !== "code" ||
    request.slot !== "cycle1" ||
    request.runAttempt !== 1 ||
    request.origin !== undefined ||
    request.recovery !== undefined ||
    proof.runId !== request.runId ||
    proof.runAttempt !== request.runAttempt ||
    proof.head !== request.head ||
    proof.workflowSha !== request.workflowSha ||
    config.discovery ||
    config.autoMerge ||
    !t ||
    t.origin !== "factory" ||
    t.status !== "blocked" ||
    t.coding !== 1 ||
    t.retries !== 0 ||
    t.reviews !== 0 ||
    t.pr ||
    t.branch ||
    t.approval ||
    t.merge ||
    t.findingRedHash ||
    t.findingRetry !== undefined ||
    t.head !== PRIOR.head ||
    t.criteriaHash !== PRIOR.criteria ||
    c.digest(t.finding) !== PRIOR.findingHash ||
    c.digest(t.automatic) !== PRIOR.automaticHash ||
    c.digest(state.grants[PRIOR.grant]) !== PRIOR.grantHash ||
    t.automatic?.runId !== PRIOR.runId ||
    t.automatic.workflowSha !== PRIOR.head ||
    t.automatic.appSlug !== config.appSlug ||
    Object.values(state.grants).filter((g) => g.ticket === PRIOR.ticket).length !== 1 ||
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
async function paused(api) {
  for (const file of [
    "factory-wake.yml",
    "factory-dependencies.yml",
    "factory-discovery.yml",
    "factory-discovery-intake.yml",
  ]) {
    const workflow = await api.request("GET", `${ROOT}/actions/workflows/${file}`);
    if (workflow.state !== "disabled_manually")
      throw Error("Pickup, discovery and intake workflows must be paused");
  }
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
    ["Run actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093", "failure"],
    ["Run the one reserved Claude subscription session", "skipped"],
    ["Prove finding RED without model credentials", "skipped"],
  ])
    if (
      steps.filter((s) => s.name === name && s.conclusion === conclusion).length !== 1 ||
      steps.filter((s) => s.name === name).length !== 1
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
async function retryFinding(api, config, context, { ticket, dryRun }, deps = {}) {
  const p = require("./policy.cjs");
  p.authorize(context);
  if (
    ticket !== PRIOR.ticket ||
    typeof dryRun !== "boolean" ||
    context.event !== "workflow_dispatch" ||
    !p.isAutomaticContext(context) ||
    context.actor !== p.OWNER ||
    context.triggeringActor !== p.OWNER ||
    context.wake ||
    context.runAttempt !== 1 ||
    config.discovery ||
    config.autoMerge
  )
    refuse();
  if (!dryRun && (!config.enabled || !config.automatic))
    return { ready: false, reason: "Finding retry disabled; no model invocation" };
  const { Ledger } = require("./github.cjs");
  const ledger = deps.ledger || new Ledger(api);
  const verifyOrigin = deps.verifyOrigin || require("./discovery-origin.cjs").verifyRepairOrigin;
  const testedMain = deps.testedMain || require("./discovery-run.cjs").testedMain;
  const state = (await ledger.read()).state;
  p.assertNotStopped(state);
  const tested = await testedMain(api, context, {});
  const proof = {
    version: 1,
    priorGrant: PRIOR.grant,
    runId: context.runId,
    runAttempt: 1,
    workflowSha: context.workflowSha,
    head: tested.head,
    ciRunId: tested.ciRunId,
    actor: p.OWNER,
    decision: DECISION,
  };
  const request = {
    ...context,
    ticket,
    phase: "code",
    slot: "cycle1",
    head: tested.head,
    findingRetry: proof,
  };
  assertEligible(state, request, config);
  await paused(api);
  await verifyFailure(api);
  async function verifyCurrent(current) {
    const issue = await api.request("GET", `${ROOT}/issues/${ticket}`);
    if (
      issue.state !== "open" ||
      issue.pull_request ||
      issue.number !== ticket ||
      require("./controller.cjs").criteriaHash(issue) !== PRIOR.criteria ||
      !(await verifyOrigin(api, issue, current.tickets[String(ticket)].finding))
    )
      refuse();
    const main = await api.request("GET", `${ROOT}/branches/main`);
    if (main.commit?.sha !== tested.head)
      throw Error("Current main changed; fresh retry invocation required");
    try {
      await api.request("GET", `${ROOT}/git/ref/heads/agent/factory-${ticket}`);
      throw Error("Existing publication branch blocks finding retry");
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  await verifyCurrent(state);
  // Exercise the same limits for preview without persisting its generated reservation.
  const previewConfig = { ...config, enabled: true, automatic: true };
  p.reserve(state, request, dryRun ? previewConfig : config);
  if (dryRun)
    return {
      ready: false,
      preview: true,
      outcome: "finding-retry-preview",
      retryEligible: true,
      ticket,
      head: tested.head,
      priorGrant: PRIOR.grant,
      modelCalls: 0,
    };
  const saved = await ledger.update(async (current) => {
    p.assertNotStopped(current);
    assertEligible(current, request, config);
    await paused(api);
    await verifyCurrent(current);
    const result = p.reserve(current, request, config);
    p.validateState(result.state);
    return result;
  });
  return {
    ready: true,
    ticket,
    head: saved.grant.head,
    grantId: saved.grant.id,
    phase: "code",
    slot: "cycle1",
    outcome: "finding-retry-reserved",
  };
}
module.exports = {
  PRIOR,
  validateProof,
  validateRetry,
  assertEligible,
  verifyFailure,
  retryFinding,
};
