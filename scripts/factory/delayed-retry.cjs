const { ROOT } = require("./github.cjs");
const slots = require("./active-tickets.cjs");

const HOLD_STEP = "Hold before Claude after a temporary GitHub gateway error";
const MODEL_STEP = "Run the one reserved Claude subscription session";
const DELAY_MS = 30 * 60 * 1000;
const SHA = /^[0-9a-f]{40}$/;
const retryableTicket = (t) => t?.origin === "factory" && Boolean(t.automatic);

function receipt(grantId, jobId, now = new Date()) {
  return { grantId, jobId, notBefore: new Date(now.getTime() + DELAY_MS).toISOString() };
}

function validate(ticket, grants) {
  const r = ticket.delayedRetry;
  if (r === undefined) return;
  const failed = grants.find((g) => g.id === r?.grantId);
  if (
    !retryableTicket(ticket) ||
    !r ||
    ![
      "grantId,jobId,notBefore",
      "grantId,jobId,notBefore,parent",
      "fix,grantId,jobId,notBefore",
      "fix,grantId,jobId,notBefore,parent",
    ].includes(Object.keys(r).sort().join(",")) ||
    !Number.isSafeInteger(r.jobId) ||
    r.jobId < 1 ||
    typeof r.notBefore !== "string" ||
    !Number.isFinite(Date.parse(r.notBefore)) ||
    new Date(r.notBefore).toISOString() !== r.notBefore ||
    failed?.phase !== "code" ||
    failed.slot !== "cycle1" ||
    failed.status !== "finished" ||
    failed.outcome !== "blocked" ||
    failed.runId !== ticket.automatic.runId ||
    failed.runAttempt !== ticket.automatic.runAttempt
  )
    throw Error("Invalid delayed retry failure evidence");
  if (
    r.fix !== undefined &&
    (!r.fix ||
      Object.keys(r.fix).sort().join(",") !== "ciRunId,mergeCommit,pr" ||
      !Number.isSafeInteger(r.fix.pr) ||
      r.fix.pr < 1 ||
      !SHA.test(r.fix.mergeCommit || "") ||
      typeof r.fix.ciRunId !== "string" ||
      !/^[1-9]\d*$/.test(r.fix.ciRunId))
  )
    throw Error("Invalid verified fix evidence for delayed retry");
  if (r.parent === undefined) return;
  const parent = r.parent;
  if (
    !parent ||
    Object.keys(parent).sort().join(",") !== "runAttempt,runId,workflowSha" ||
    !/^[1-9]\d*$/.test(parent.runId) ||
    parent.runAttempt !== 1 ||
    parent.runId === failed.runId ||
    !SHA.test(parent.workflowSha || "") ||
    (ticket.finding && ticket.finding.intake.head !== parent.workflowSha) ||
    !grants.some(
      (g) =>
        g.phase === "code" &&
        g.slot === "cycle1" &&
        g.runId === parent.runId &&
        g.runAttempt === parent.runAttempt &&
        g.head === parent.workflowSha
    ) ||
    ticket.coding < 2 ||
    ticket.retries < 1
  )
    throw Error("Invalid delayed retry handoff");
}

function eligibleBlocked(state, ticket, id, config) {
  return Boolean(
    config.priorityRetry &&
      retryableTicket(ticket) &&
      (!ticket.finding || config.discovery) &&
      ticket.status === "blocked" &&
      ticket.coding === 1 &&
      ticket.reviews === 0 &&
      ticket.retries === 0 &&
      !ticket.pr &&
      !ticket.branch &&
      !ticket.ci &&
      !ticket.approval &&
      !slots.activeFor(state, id) &&
      ticket.coding < config.coding &&
      ticket.retries < config.retries
  );
}

function due(state, ticket, id, config, now = new Date()) {
  const r = ticket?.delayedRetry;
  return Boolean(
    eligibleBlocked(state, ticket, id, config) &&
      r &&
      r.parent === undefined &&
      Date.parse(r.notBefore) <= now.getTime()
  );
}

function handoff(state, request, config, now) {
  const policy = require("./policy.cjs");
  const ticket = state.tickets[String(request.ticket)];
  if (
    request.delayedRetry !== true ||
    !due(state, ticket, request.ticket, config, now) ||
    !policy.isAutomaticContext(request) ||
    request.actor !== policy.OWNER ||
    request.triggeringActor !== policy.OWNER ||
    request.wake ||
    request.runAttempt !== 1 ||
    request.runId === ticket.automatic.runId ||
    request.phase !== "code" ||
    request.slot !== "cycle1" ||
    request.head !== request.workflowSha ||
    (ticket.finding && ticket.finding.intake.head !== request.head)
  )
    throw Error("Delayed retry is not eligible for this run");
  ticket.delayedRetry.parent = {
    runId: request.runId,
    runAttempt: request.runAttempt,
    workflowSha: request.workflowSha,
  };
}

async function failedJob(api, context) {
  const jobs = await api.pages(
    `${ROOT}/actions/runs/${context.runId}/attempts/${context.runAttempt}/jobs`,
    "jobs"
  );
  const matches = jobs.filter((job) => job.name === "cycle1 / coding / agent");
  const job = matches[0];
  if (
    matches.length !== 1 ||
    !Number.isSafeInteger(job.id) ||
    job.id < 1 ||
    job.run_id !== Number(context.runId) ||
    job.run_attempt !== context.runAttempt ||
    job.status !== "completed" ||
    job.conclusion !== "failure" ||
    !Array.isArray(job.steps)
  )
    return null;
  const matchesStep = (name, conclusion) => {
    const steps = job.steps.filter((step) => step.name === name);
    return (
      steps.length === 1 && steps[0].status === "completed" && steps[0].conclusion === conclusion
    );
  };
  return matchesStep(HOLD_STEP, "failure") && matchesStep(MODEL_STEP, "skipped") ? job.id : null;
}

module.exports = {
  HOLD_STEP,
  MODEL_STEP,
  receipt,
  validate,
  due,
  eligibleBlocked,
  handoff,
  failedJob,
  retryableTicket,
};
