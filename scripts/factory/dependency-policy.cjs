const slots = require("./active-tickets.cjs");
const policy = require("./policy.cjs");
const d = require("./dependency-contract.cjs");
const budget = require("./ticket-ai-budget.cjs");
function pending(state, except, now) {
  return Object.entries(state.tickets).some(
    ([id, t]) =>
      Number(id) !== except &&
      (t.automatic || t.dependency) &&
      (!t.feature || t.merge?.status === "intent" || slots.activeFor(state, Number(id))) &&
      !t.findingApiRecovery &&
      t.status === "reviewed" &&
      !["closed", "merged"].includes(t.merge?.status) &&
      (!t.dependency || require("./dependency-merge-retry.cjs").blocksQueue(t, now))
  );
}
function unresolvedCompatibilityPublish(ticket) {
  const attempt = ticket?.dependency?.attempts?.at(-1);
  const publish = attempt?.compatibility?.publish;
  return publish && !publish.confirmedAt && !publish.abortedAt ? attempt : undefined;
}

function matchingNativeHead(ticket, pr, config) {
  const attempt = ticket?.dependency?.attempts?.at(-1);
  return Boolean(
    attempt &&
      d.branch(ticket.branch) &&
      pr.number === ticket.pr &&
      pr.head.ref === ticket.branch &&
      pr.head.sha === ticket.head &&
      pr.base.sha === attempt.base &&
      ticket.dependency.appSlug === config.appSlug &&
      ticket.dependency.attempts.length < 10 &&
      ticket.reviews < config.reviews &&
      !ticket.merge &&
      !attempt.compatibilityReclaim &&
      !attempt.compatibility
  );
}

function blockedReview(ticket, grant) {
  const attempt = ticket.dependency.attempts.at(-1);
  if (
    !d.matchesBlockingGrant(attempt, grant) ||
    !d.validArchivedCI(ticket.ci, ticket.head) ||
    ticket.ci.passed !== true ||
    typeof ticket.feedback !== "string"
  )
    return undefined;
  try {
    const result = JSON.parse(ticket.feedback);
    if (d.validBlockingReview(result, ticket.head)) return { grantId: grant.id, result };
  } catch {}
  return undefined;
}

function reviewForHead(ticket, grants) {
  return grants.find(
    (g) => g.ticket === ticket.pr && g.phase === "review" && g.head === ticket.head
  );
}

function canClaimCompatibility(ticket, pr, config, grants = []) {
  if (
    !matchingNativeHead(ticket, pr, config) ||
    ticket.status !== "blocked" ||
    ticket.coding >= config.coding ||
    (ticket.coding > 0 && ticket.retries >= config.retries) ||
    !budget.canReserve(ticket, "code", config)
  )
    return false;
  const review = reviewForHead(ticket, grants);
  return review
    ? Boolean(blockedReview(ticket, review))
    : !ticket.dependency.attempts.at(-1).compatibilityContinuation &&
        (!d.compatibilityForHead(ticket) ||
          (d.validArchivedCI(ticket.ci, ticket.head) && ticket.ci.passed === false));
}

function canResumeCompatibility(ticket, pr, config, grants = []) {
  return Boolean(
    matchingNativeHead(ticket, pr, config) &&
      ["blocked", "awaiting_review"].includes(ticket.status) &&
      d.compatibilityForHead(ticket) &&
      !ticket.dependency.attempts.at(-1).compatibilityContinuation &&
      ticket.ci?.passed !== false &&
      budget.canReserve(ticket, "review", config) &&
      !grants.some((g) => g.ticket === pr.number && g.head === pr.head.sha && g.phase === "review")
  );
}

function compatibilityRefreshRequested(ticket, head, base) {
  const attempt = ticket?.dependency?.attempts?.at(-1);
  return Boolean(
    attempt?.head === head &&
      attempt.compatibilityRefreshes?.some((refresh) => refresh.base === base)
  );
}

function archiveCI(ticket) {
  if (d.validArchivedCI(ticket.ci, ticket.head)) ticket.dependency.attempts.at(-1).ci = ticket.ci;
}

function attemptFor(head, base, context, now) {
  return {
    head,
    base,
    runId: context.runId,
    runAttempt: context.runAttempt,
    workflowSha: context.workflowSha,
    at: now.toISOString(),
  };
}

function claimDependency(
  original,
  pr,
  context,
  config,
  now = new Date(),
  alertReceipt,
  { compatibility = false, continuation = false, refreshReceipt } = {}
) {
  policy.validateState(original);
  policy.assertNotStopped(original);
  policy.authorize(context);
  d.prOK(pr, false, config);
  if (
    d.alertKey(pr.head.ref) &&
    (alertReceipt?.pr !== pr.number ||
      alertReceipt?.head !== pr.head.sha ||
      alertReceipt?.base !== pr.base.sha ||
      alertReceipt?.phase !== "ready")
  )
    throw new Error("Dependency alert claim requires a current receipt");
  if (!d.contextOK(context)) throw new Error("Unauthorized dependency workflow");
  if (!config.enabled || !config.automatic || !config.minutes || !config.turns || !config.reviews)
    throw new Error("Dependency factory disabled");
  const turns = require("./feature-turn.cjs");
  if (turns.priority(original, config, now)) throw Error(turns.WAITING);
  if (context.wake) {
    if (!config.eventPickup) throw new Error("Event pickup disabled");
    const target = require("./trusted-wake.cjs").dependencyWakeTarget(context);
    if (target?.number !== pr.number || target.head !== pr.head.sha)
      throw new Error("Dependency PR does not match the verified CI wake");
  }
  if (
    !slots.capacity(original, config.concurrent) ||
    slots.activeFor(original, pr.number) ||
    pending(original, pr.number, now)
  )
    throw new Error("An active ticket or pending merge holds the factory lock");
  const state = structuredClone(original),
    id = String(pr.number),
    previous = state.tickets[id];
  let reclaimed = {};
  if (
    refreshReceipt !== undefined &&
    (!previous ||
      !d.compatibilityForHead(previous) ||
      refreshReceipt.originalHead !== previous.head ||
      refreshReceipt.head !== pr.head.sha ||
      refreshReceipt.base !== pr.base.sha ||
      refreshReceipt.head === refreshReceipt.originalHead ||
      !compatibilityRefreshRequested(previous, refreshReceipt.originalHead, refreshReceipt.base))
  )
    throw new Error("Dependency compatibility refresh lacks a durable intent");
  if (previous) {
    d.validateTicket(previous);
    if (
      previous.merge ||
      previous.branch !== pr.head.ref ||
      previous.dependency.appSlug !== config.appSlug ||
      unresolvedCompatibilityPublish(previous)
    )
      throw new Error("Dependency ticket identity changed");
    if (previous.dependency.attempts.some((a) => a.head === pr.head.sha)) {
      const grants = Object.values(state.grants);
      if (compatibility && canClaimCompatibility(previous, pr, config, grants)) {
        const review = blockedReview(previous, reviewForHead(previous, grants));
        if (review) {
          previous.dependency.attempts.at(-1).review = review;
          delete previous.feedback;
        }
        reclaimed = { compatibilityReclaim: true };
      } else if (continuation && canResumeCompatibility(previous, pr, config, grants))
        reclaimed = { compatibilityContinuation: true };
      else throw new Error("Dependency head already attempted");
      archiveCI(previous);
    }
    if (refreshReceipt !== undefined) archiveCI(previous);
    if (
      previous.dependency.attempts.length >=
        (Object.keys(reclaimed).length || previous.coding ? 10 : Math.min(10, config.reviews)) ||
      previous.reviews >= config.reviews
    )
      throw new Error("Dependency lifetime attempt limit reached");
  } else {
    const day = policy.dayKey(now, config.timezone),
      admissions = state.days[day] || [];
    if (policy.dailyAdmissions(state, day) >= config.daily)
      throw new Error("Daily ticket limit reached");
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
    ...attemptFor(pr.head.sha, pr.base.sha, context, now),
    ...reclaimed,
    ...(refreshReceipt !== undefined && { compatibilityRefreshFrom: refreshReceipt.originalHead }),
  });
  t.head = pr.head.sha;
  t.status = "new";
  t.approval = null;
  if (!reclaimed.compatibilityContinuation || !d.validArchivedCI(t.ci, t.head) || !t.ci.passed)
    t.ci = null;
  delete t.analysis;
  delete t.dependencyMergeRetry;
  slots.claimActive(
    state,
    { ticket: pr.number, runId: context.runId, runAttempt: context.runAttempt },
    config.concurrent
  );
  policy.audit(
    state,
    "dependency_metadata_admitted",
    {
      ticket: pr.number,
      head: t.head,
      runId: context.runId,
      actor: context.actor,
      ...(context.wake
        ? { wakeReceipt: context.wake.receiptId, sourceActor: context.wake.sourceActor }
        : {}),
    },
    now
  );
  return policy.validateState(state);
}
function beginDependencyCompatibilityRefresh(
  original,
  number,
  context,
  config,
  evidence,
  now = new Date()
) {
  policy.validateState(original);
  policy.assertNotStopped(original);
  policy.authorize(context);
  const state = structuredClone(original);
  const t = state.tickets[String(number)];
  if (
    !config.enabled ||
    !config.automatic ||
    !d.contextOK(context) ||
    t?.pr !== number ||
    t.dependency?.appSlug !== config.appSlug ||
    t.merge ||
    !d.compatibilityForHead(t) ||
    unresolvedCompatibilityPublish(t) ||
    slots.usedCapacity(state) !== 0 ||
    slots.pendingIntent(state) ||
    !d.SHA.test(evidence?.base || "") ||
    evidence.head !== t.head ||
    t.dependency.attempts.length >= 10
  )
    throw new Error("Dependency compatibility refresh unavailable");
  const attempt = d.validateTicket(t);
  if (
    evidence.base === attempt.base ||
    evidence.base === attempt.head ||
    (attempt.compatibilityRefreshes?.length ?? 0) >= 10 ||
    compatibilityRefreshRequested(t, evidence.head, evidence.base)
  )
    throw new Error("Dependency compatibility refresh already requested or invalid");
  (attempt.compatibilityRefreshes ??= []).push({ base: evidence.base, at: now.toISOString() });
  policy.audit(
    state,
    "dependency_compatibility_refresh_requested",
    {
      ticket: number,
      head: attempt.head,
      base: evidence.base,
      runId: context.runId,
    },
    now
  );
  return policy.validateState(state);
}
function reserveDependencyCompatibility(state, number, context, config, request, now) {
  const t = state.tickets[String(number)];
  d.matches(t, context, config);
  if (t.dependency.attempts.length >= 10)
    throw new Error("Dependency lifetime attempt limit reached");
  const result = policy.reserve(
    state,
    {
      ...context,
      ticket: number,
      head: t.head,
      phase: "code",
      slot: d.COMPATIBILITY_SLOT,
      origin: "dependency-pr",
      pr: number,
      compatibility: request,
    },
    config,
    now
  );
  policy.validateState(result.state);
  return result;
}

function publicationBinding(state, number, evidence) {
  const t = state.tickets[String(number)];
  const attempt = d.validateTicket(t);
  const receipt = attempt.compatibility;
  const grant = state.grants[evidence?.grantId];
  if (
    !d.branch(t.branch) ||
    t.pr !== number ||
    t.merge ||
    !receipt ||
    !grant ||
    receipt.grantId !== grant.id ||
    evidence.originalHead !== t.head ||
    evidence.base !== attempt.base ||
    !d.SHA.test(evidence.head || "") ||
    t.dependency.attempts.some((a) => a.head === evidence.head)
  )
    throw new Error("Dependency compatibility publication binding changed");
  return { t, attempt, receipt, grant };
}

function beginDependencyCompatibilityPublish(
  original,
  number,
  context,
  config,
  evidence,
  now = new Date()
) {
  const state = structuredClone(original);
  const { t, receipt, grant } = publicationBinding(state, number, evidence);
  policy.preflight(
    state,
    grant.id,
    { ...context, ticket: number, phase: "code", slot: d.COMPATIBILITY_SLOT, head: t.head },
    config
  );
  if (slots.pendingIntent(state) || t.dependency.attempts.length >= 10)
    throw new Error("Dependency compatibility publication holds no available attempt");
  receipt.publish = { head: evidence.head, at: now.toISOString() };
  policy.audit(
    state,
    "dependency_compatibility_publish_intent",
    {
      ticket: number,
      originalHead: t.head,
      head: evidence.head,
      runId: context.runId,
    },
    now
  );
  return policy.validateState(state);
}

function matchingIntent(state, number, evidence) {
  const binding = publicationBinding(state, number, evidence);
  if (
    unresolvedCompatibilityPublish(binding.t) !== binding.attempt ||
    binding.receipt.publish.head !== evidence.head
  )
    throw new Error("Dependency compatibility publish intent changed or absent");
  return binding;
}

function settlePublished(original, number, context, config, evidence, now, ownership) {
  const { t, grant } = matchingIntent(original, number, evidence);
  const state =
    grant.status === "reserved"
      ? policy.finish(
          original,
          grant.id,
          { status: "awaiting_review", head: evidence.head, pr: number },
          now
        )
      : structuredClone(original);
  const current = state.tickets[String(number)];
  if (d.validArchivedCI(t.ci, t.head))
    current.dependency.attempts.at(-1).ci = structuredClone(t.ci);
  current.dependency.attempts.at(-1).compatibility.publish.confirmedAt = now.toISOString();
  current.dependency.attempts.push(attemptFor(evidence.head, evidence.base, context, now));
  current.head = evidence.head;
  current.status = ownership === "release" ? "blocked" : "awaiting_review";
  current.ci = null;
  current.approval = null;
  delete current.analysis;
  delete current.dependencyMergeRetry;
  if (ownership !== "retain") {
    const owner = slots.activeFor(state, number);
    if (owner) slots.releaseActive(state, owner);
    if (ownership === "transfer")
      slots.claimActive(
        state,
        { ticket: number, runId: context.runId, runAttempt: context.runAttempt },
        config.concurrent
      );
  }
  policy.audit(
    state,
    "dependency_compatibility_published",
    {
      ticket: number,
      originalHead: evidence.originalHead,
      head: evidence.head,
      runId: context.runId,
    },
    now
  );
  return policy.validateState(state);
}

function assertDependencyCompatibilityPublish(original, number, context, config, evidence) {
  policy.validateState(original);
  policy.assertNotStopped(original);
  const { t, grant } = matchingIntent(original, number, evidence);
  d.matches(t, context, config);
  if (
    !config.enabled ||
    !config.automatic ||
    grant.status !== "reserved" ||
    !slots.owns(slots.activeFor(original, number), grant) ||
    slots.usedCapacity(original) !== 1 ||
    slots.pendingIntent(original)
  )
    throw new Error("Dependency compatibility publish lease changed");
  budget.checkPending(t, grant, config);
  if (
    t.coding > config.coding ||
    t.reviews > config.reviews ||
    t.retries > config.retries ||
    policy.dailyAdmissions(original, policy.dayKey(new Date(grant.at), config.timezone)) >
      config.daily
  )
    throw new Error("Dependency compatibility publish exceeds the current limit");
}

function recordDependencyCompatibility(
  original,
  number,
  context,
  config,
  evidence,
  now = new Date()
) {
  assertDependencyCompatibilityPublish(original, number, context, config, evidence);
  return settlePublished(original, number, context, config, evidence, now, "retain");
}

function reconcileDependencyCompatibility(
  original,
  number,
  context,
  config,
  evidence,
  now = new Date()
) {
  policy.validateState(original);
  policy.assertNotStopped(original);
  policy.authorize(context);
  const { t, attempt, grant } = matchingIntent(original, number, evidence);
  const owner = slots.activeFor(original, number);
  if (
    !config.enabled ||
    !config.automatic ||
    !d.contextOK(context) ||
    t.dependency.appSlug !== config.appSlug ||
    context.runId === attempt.runId ||
    slots.pendingIntent(original) ||
    (owner && !slots.owns(owner, grant)) ||
    !d.SHA.test(evidence.observedHead || "") ||
    !d.SHA.test(evidence.observedBase || "")
  )
    throw new Error("Dependency compatibility recovery provenance changed");
  if (evidence.outcome === "published" && evidence.observedHead === evidence.head) {
    const ownership =
      evidence.observedOpen !== false &&
      evidence.observedBase === evidence.base &&
      (owner ? slots.usedCapacity(original) === 1 : slots.usedCapacity(original) === 0)
        ? "transfer"
        : "release";
    return settlePublished(original, number, context, config, evidence, now, ownership);
  }
  if (
    (evidence.outcome !== "not_published" || evidence.observedHead !== evidence.originalHead) &&
    (evidence.outcome !== "changed" ||
      [evidence.head, evidence.originalHead].includes(evidence.observedHead))
  )
    throw new Error("Dependency compatibility recovery lacks an observed GitHub head");
  const state =
    grant.status === "reserved"
      ? policy.finish(original, grant.id, { status: "blocked" }, now)
      : structuredClone(original);
  const current = state.tickets[String(number)];
  const currentOwner = slots.activeFor(state, number);
  if (currentOwner) slots.releaseActive(state, currentOwner);
  current.status = "blocked";
  const publish = current.dependency.attempts.at(-1).compatibility.publish;
  publish.abortedAt = now.toISOString();
  publish.outcome = evidence.outcome;
  policy.audit(
    state,
    "dependency_compatibility_publish_reconciled",
    {
      ticket: number,
      originalHead: t.head,
      head: evidence.observedHead,
      outcome: evidence.outcome,
      runId: context.runId,
    },
    now
  );
  return policy.validateState(state);
}
function reserveDependencyReview(state, context, config) {
  const entry = slots
    .activeEntries(state)
    .find((e) => e.runId === context.runId && e.runAttempt === context.runAttempt);
  const t = state.tickets[String(entry?.ticket)];
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
    !slots.owns(slots.activeFor(state, ticket), { ...context, ticket }) ||
    Object.values(state.grants).some((g) => g.ticket === ticket && g.status === "reserved") ||
    unresolvedCompatibilityPublish(t) ||
    t.merge
  )
    throw new Error("Dependency preparation lock cannot be released");
  t.status = "blocked";
  t.approval = null;
  const evidence = d.validateTicket(t).evidence?.at(-1);
  t.feedback = evidence?.reason
    ? d.EVIDENCE_REASONS[evidence.reason]
    : "Dependency preparation held; no model invocation";
  slots.releaseActive(state, { ticket, runId: context.runId, runAttempt: context.runAttempt });
  policy.audit(state, "dependency_preparation_blocked", {
    ticket,
    head: t.head,
    runId: context.runId,
  });
  return policy.validateState(state);
}
module.exports = {
  claimDependency,
  canClaimCompatibility,
  canResumeCompatibility,
  beginDependencyCompatibilityRefresh,
  compatibilityRefreshRequested,
  reserveDependencyCompatibility,
  beginDependencyCompatibilityPublish,
  assertDependencyCompatibilityPublish,
  recordDependencyCompatibility,
  reconcileDependencyCompatibility,
  unresolvedCompatibilityPublish,
  reserveDependencyReview,
  finishPreparation,
  pending,
};
