const policy = require("./policy.cjs");
const d = require("./dependency-contract.cjs");
function pending(state, except) {
  return Object.entries(state.tickets).some(
    ([id, t]) =>
      Number(id) !== except &&
      (t.automatic || t.dependency) &&
      t.status === "reviewed" &&
      !["closed", "merged"].includes(t.merge?.status)
  );
}
function claimDependency(original, pr, context, config, now = new Date()) {
  policy.validateState(original);
  policy.assertNotStopped(original);
  policy.authorize(context);
  d.prOK(pr);
  if (!d.contextOK(context)) throw new Error("Unauthorized dependency workflow");
  if (!config.enabled || !config.automatic || !config.minutes || !config.turns || !config.reviews)
    throw new Error("Dependency factory disabled");
  if (original.active || pending(original, pr.number))
    throw new Error("An active ticket or pending merge holds the factory lock");
  const state = structuredClone(original),
    id = String(pr.number),
    previous = state.tickets[id];
  if (previous) {
    d.validateTicket(previous);
    if (
      previous.merge ||
      previous.branch !== pr.head.ref ||
      previous.dependency.appSlug !== config.appSlug
    )
      throw new Error("Dependency ticket identity changed");
    if (previous.dependency.attempts.some((a) => a.head === pr.head.sha))
      throw new Error("Dependency head already attempted");
    if (
      previous.dependency.attempts.length >= Math.min(10, config.reviews) ||
      previous.reviews >= config.reviews
    )
      throw new Error("Dependency lifetime attempt limit reached");
  } else {
    const day = policy.dayKey(now, config.timezone),
      admissions = state.days[day] || [];
    if (admissions.length >= config.daily) throw new Error("Daily ticket limit reached");
    state.days[day] = [...admissions, pr.number];
    state.tickets[id] = {
      coding: 0,
      reviews: 0,
      retries: 0,
      origin: "dependency-pr",
      head: pr.head.sha,
      pr: pr.number,
      status: "new",
      approval: null,
      branch: pr.head.ref,
      criteriaHash: d.criteria(pr.number),
      dependency: {
        version: 1,
        pr: pr.number,
        workflowRef: d.WORKFLOW,
        workflowSha: context.workflowSha,
        runId: context.runId,
        runAttempt: context.runAttempt,
        appSlug: config.appSlug,
        attempts: [],
      },
    };
  }
  const t = state.tickets[id];
  t.dependency.attempts.push({
    head: pr.head.sha,
    base: pr.base.sha,
    runId: context.runId,
    runAttempt: context.runAttempt,
    workflowSha: context.workflowSha,
    at: now.toISOString(),
  });
  t.head = pr.head.sha;
  t.status = "new";
  t.approval = null;
  t.ci = null;
  delete t.analysis;
  state.active = { ticket: pr.number, runId: context.runId, runAttempt: context.runAttempt };
  policy.audit(
    state,
    "dependency_metadata_admitted",
    { ticket: pr.number, head: t.head, runId: context.runId },
    now
  );
  return policy.validateState(state);
}
function reserveDependencyReview(state, context, config) {
  const t = state.tickets[String(state.active?.ticket)];
  d.matches(t, context, config);
  if (
    !t.analysis ||
    t.analysis.head !== t.head ||
    !t.ci ||
    t.ci.head !== t.head ||
    t.ci.passed !== true
  )
    throw new Error("Dependency analysis and CI must pass before review");
  return policy.reserve(
    state,
    {
      ...context,
      ticket: t.pr,
      head: t.head,
      phase: "review",
      slot: "dependency",
      origin: "dependency-pr",
      pr: t.pr,
    },
    config
  );
}
function finishPreparation(original, ticket, context) {
  policy.validateState(original);
  const state = structuredClone(original),
    t = state.tickets[String(ticket)];
  if (
    !t ||
    t.origin !== "dependency-pr" ||
    !state.active ||
    state.active.ticket !== ticket ||
    state.active.runId !== context.runId ||
    state.active.runAttempt !== context.runAttempt ||
    Object.values(state.grants).some((g) => g.ticket === ticket && g.status === "reserved") ||
    t.merge
  )
    throw new Error("Dependency preparation lock cannot be released");
  t.status = "blocked";
  t.approval = null;
  t.feedback = "Dependency preparation held; no model invocation";
  state.active = null;
  policy.audit(state, "dependency_preparation_blocked", {
    ticket,
    head: t.head,
    runId: context.runId,
  });
  return policy.validateState(state);
}
module.exports = { claimDependency, reserveDependencyReview, finishPreparation, pending };
