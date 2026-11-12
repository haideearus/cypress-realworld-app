const { randomUUID } = require("node:crypto");

const REPOSITORY = "haideearus/cypress-realworld-app";
const OWNER = "haideearus";
const SHA = /^[a-f0-9]{40}$/;
const LIMITS = {
  FACTORY_MAX_TICKETS_PER_DAY: ["daily", 2],
  FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET: ["coding", 2],
  FACTORY_MAX_REVIEWS_PER_TICKET: ["reviews", 2],
  FACTORY_MAX_AUTOMATIC_RETRIES: ["retries", 1],
  FACTORY_MAX_CONCURRENT_TICKETS: ["concurrent", 1],
  FACTORY_RUN_TIMEOUT_MINUTES: ["minutes", 15],
  FACTORY_MAX_TURNS_PER_RUN: ["turns", 50],
};
function deny(reason) {
  throw new Error(reason);
}
function integer(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) deny(`Invalid ${label}`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > max) deny(`Invalid ${label}: above approved limit`);
  return n;
}
function readConfig(vars) {
  const config = { enabled: vars.FACTORY_ENABLED === "true" };
  if (![undefined, "true", "false"].includes(vars.FACTORY_ENABLED)) deny("Invalid enabled setting");
  for (const [key, [name, max]] of Object.entries(LIMITS))
    config[name] = integer(vars[key], key, max);
  if (config.concurrent !== 1) deny("Invalid concurrency: must be one");
  if (vars.FACTORY_TIMEZONE !== "Europe/Bucharest") deny("Invalid factory timezone");
  if (vars.FACTORY_APP_URL !== "https://haide-software-factory.onrender.com")
    deny("Invalid app URL");
  return { ...config, timezone: vars.FACTORY_TIMEZONE };
}
function assertSubscriptionEnv(env, requireToken = false) {
  const forbidden = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_PROFILE",
    "ANTHROPIC_API_KEY_HELPER",
    "CLAUDE_CODE_API_KEY_HELPER",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_FEDERATION_TOKEN_FILE",
  ];
  if (forbidden.some((key) => env[key] && !["0", "false"].includes(env[key])))
    deny("Only Claude subscription authentication is permitted");
  if (requireToken && !env.CLAUDE_CODE_OAUTH_TOKEN) deny("Claude subscription token is required");
}
function emptyState(repository) {
  return { version: 1, repository, days: {}, tickets: {}, grants: {}, active: null, audit: [] };
}
function validateState(state) {
  const record = (value) => value && typeof value === "object" && !Array.isArray(value);
  if (
    !state ||
    state.version !== 1 ||
    state.repository !== REPOSITORY ||
    !record(state.days) ||
    !record(state.tickets) ||
    !record(state.grants) ||
    !Array.isArray(state.audit)
  )
    deny("Invalid factory ledger state");
  for (const [day, ids] of Object.entries(state.days)) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Array.isArray(ids) ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !Number.isSafeInteger(id) || id < 1 || !state.tickets[String(id)])
    )
      deny("Invalid ledger day");
  }
  for (const [id, ticket] of Object.entries(state.tickets)) {
    if (
      !/^[1-9]\d*$/.test(id) ||
      !ticket ||
      !SHA.test(ticket.head) ||
      !Number.isInteger(ticket.coding) ||
      ticket.coding < (ticket.origin === "owner-pr" ? 0 : 1) ||
      ticket.coding > 2 ||
      ![undefined, "factory", "owner-pr"].includes(ticket.origin) ||
      (ticket.origin === "owner-pr" &&
        (ticket.coding !== 0 || !Number.isSafeInteger(ticket.pr) || ticket.pr < 1)) ||
      !Number.isInteger(ticket.reviews) ||
      ticket.reviews < 0 ||
      ticket.reviews > 2 ||
      !Number.isInteger(ticket.retries) ||
      ticket.retries < 0 ||
      ticket.retries > 1
    )
      deny("Invalid ledger ticket counters");
    const grants = Object.values(state.grants).filter((g) => g?.ticket === Number(id));
    if (
      grants.filter((g) => g.phase === "code").length !== ticket.coding ||
      grants.filter((g) => g.phase === "review").length !== ticket.reviews ||
      ticket.retries !== Math.max(0, ticket.coding - 1) ||
      Object.values(state.days).filter((ids) => ids.includes(Number(id))).length !== 1 ||
      !["new", "coding", "reviewing", "awaiting_review", "retry", "blocked", "reviewed"].includes(
        ticket.status
      )
    )
      deny("Invalid ledger history or admission counters");
  }
  for (const [id, g] of Object.entries(state.grants)) {
    if (
      !g ||
      g.id !== id ||
      !state.tickets[String(g.ticket)] ||
      !["code", "review"].includes(g.phase) ||
      !["reserved", "finished"].includes(g.status) ||
      !SHA.test(g.head) ||
      !/^[1-9]\d*$/.test(g.runId) ||
      !Number.isSafeInteger(g.runAttempt) ||
      g.runAttempt < 1
    )
      deny("Invalid ledger reservation");
  }
  if (
    state.active &&
    (!state.tickets[String(state.active.ticket)] ||
      !/^[1-9]\d*$/.test(state.active.runId) ||
      !Number.isInteger(state.active.runAttempt) ||
      state.active.runAttempt < 1)
  )
    deny("Invalid ledger active ticket");
  const pending = Object.values(state.grants).filter((g) => g.status === "reserved");
  if (
    pending.length > 1 ||
    pending.some(
      (g) =>
        !state.active ||
        state.active.ticket !== g.ticket ||
        state.active.runId !== g.runId ||
        state.active.runAttempt !== g.runAttempt
    )
  )
    deny("Invalid ledger active reservation history");
  return state;
}
function dayKey(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function authorize(request) {
  if (
    request.repository !== REPOSITORY ||
    request.actor !== OWNER ||
    request.triggeringActor !== OWNER ||
    request.ref !== "refs/heads/main" ||
    request.event !== "workflow_dispatch"
  )
    deny("Unauthorized factory invocation");
  if (
    !Number.isSafeInteger(request.ticket) ||
    request.ticket < 1 ||
    !SHA.test(request.head) ||
    !/^[1-9]\d*$/.test(request.runId) ||
    !Number.isInteger(request.runAttempt) ||
    request.runAttempt < 1 ||
    !/^[a-z][a-z0-9_-]{0,30}$/.test(request.slot) ||
    !["code", "review"].includes(request.phase)
  )
    deny("Invalid reservation request");
}
function audit(state, event, detail, now = new Date()) {
  state.audit.push({ at: now.toISOString(), event, ...detail });
  state.audit = state.audit.slice(-500);
}
function reserve(original, request, config, now = new Date()) {
  validateState(original);
  authorize(request);
  if (!config.enabled || !config.minutes || !config.turns) deny("Factory disabled");
  const state = structuredClone(original);
  const id = String(request.ticket);
  const existing = state.tickets[id];
  const ownerReview = request.phase === "review" && request.origin === "owner-pr";
  if (request.origin !== undefined && !ownerReview) deny("Invalid reservation origin");
  if (ownerReview && (!Number.isSafeInteger(request.pr) || request.pr < 1))
    deny("Invalid owner PR number");
  if (
    (ownerReview && existing && (existing.origin !== "owner-pr" || existing.pr !== request.pr)) ||
    (existing?.origin === "owner-pr" && !ownerReview)
  )
    deny("Ticket origin cannot change between owner review and coding");
  if (
    state.active &&
    (state.active.ticket !== request.ticket ||
      state.active.runId !== request.runId ||
      state.active.runAttempt !== request.runAttempt)
  )
    deny("Another active ticket/run holds the factory lock");
  if (
    Object.values(state.grants).some((g) => g.ticket === request.ticket && g.status === "reserved")
  )
    deny("An unfinished reservation must be recovered before starting another");
  if (
    request.phase === "review" &&
    !ownerReview &&
    (!existing ||
      !state.active ||
      existing.status !== "awaiting_review" ||
      existing.head !== request.head ||
      !existing.pr)
  )
    deny("Review needs the matching active coding ticket");
  if (!existing && (request.phase === "code" || ownerReview)) {
    const day = dayKey(now, config.timezone);
    const admitted = state.days[day] || [];
    if (admitted.length >= config.daily) deny("Daily ticket limit reached");
    state.days[day] = [...admitted, request.ticket];
    state.tickets[id] = {
      coding: 0,
      origin: ownerReview ? "owner-pr" : "factory",
      reviews: 0,
      retries: 0,
      head: request.head,
      status: "new",
      pr: ownerReview ? request.pr : null,
      approval: null,
    };
  }
  if (request.phase === "code") {
    const t = state.tickets[id];
    if (t.status === "reviewed") deny("Ticket already reviewed");
    if (t.coding >= config.coding) deny("Coding attempt limit reached");
    if (t.coding > 0) {
      if (t.retries >= config.retries) deny("Automatic retry limit reached");
      t.retries++;
    }
    t.coding++;
    t.head = request.head;
    t.approval = null;
    t.status = "coding";
  } else {
    const current = state.tickets[id];
    if (current.reviews >= config.reviews) deny("Independent review limit reached");
    if (ownerReview && current.status === "reviewed" && current.head === request.head)
      deny("Owner PR head is already reviewed");
    current.reviews++;
    current.head = request.head;
    current.approval = null;
    current.status = "reviewing";
  }
  const grant = {
    id: randomUUID(),
    ticket: request.ticket,
    phase: request.phase,
    slot: request.slot,
    runId: request.runId,
    runAttempt: request.runAttempt,
    head: request.head,
    status: "reserved",
    at: now.toISOString(),
  };
  state.grants[grant.id] = grant;
  state.active = { ticket: request.ticket, runId: request.runId, runAttempt: request.runAttempt };
  audit(
    state,
    "reserved",
    {
      ticket: request.ticket,
      grant: grant.id,
      phase: grant.phase,
      runId: grant.runId,
      runAttempt: grant.runAttempt,
    },
    now
  );
  return { state, grant };
}
function preflight(state, grantId, context, config) {
  validateState(state);
  authorize(context);
  if (!config.enabled || !config.minutes || !config.turns) deny("Factory disabled");
  const grant = state.grants[grantId];
  const ticket = grant && state.tickets[String(grant.ticket)];
  if (
    ticket &&
    (ticket.coding > config.coding ||
      ticket.reviews > config.reviews ||
      ticket.retries > config.retries ||
      (state.days[dayKey(new Date(grant.at), config.timezone)] || []).length > config.daily)
  )
    deny("Pending reservation exceeds current limit");
  if (
    !grant ||
    grant.status !== "reserved" ||
    !state.active ||
    ["ticket", "phase", "slot", "runId", "runAttempt", "head"].some(
      (k) => grant[k] !== context[k]
    ) ||
    state.active.ticket !== grant.ticket ||
    state.active.runId !== grant.runId ||
    state.active.runAttempt !== grant.runAttempt
  )
    deny("Invalid or stale model reservation");
  return grant;
}
function finish(original, grantId, outcome, now = new Date()) {
  validateState(original);
  const state = structuredClone(original);
  const g = state.grants[grantId];
  if (!g || g.status !== "reserved" || !state.active || state.active.ticket !== g.ticket)
    deny("Invalid finished reservation");
  if (!["blocked", "retry", "awaiting_review", "reviewed"].includes(outcome.status))
    deny("Invalid invocation outcome");
  const t = state.tickets[String(g.ticket)];
  if (outcome.head && !SHA.test(outcome.head)) deny("Invalid outcome head");
  if (outcome.pr && (!Number.isSafeInteger(outcome.pr) || outcome.pr < 1))
    deny("Invalid outcome PR");
  if (outcome.status === "reviewed") {
    if (
      g.phase !== "review" ||
      outcome.verdict !== "pass" ||
      outcome.head !== g.head ||
      outcome.head !== t.head ||
      outcome.pr !== t.pr ||
      outcome.evidence !== `https://github.com/${REPOSITORY}/actions/runs/${g.runId}`
    )
      deny("Invalid independent review proof");
    t.approval = {
      head: g.head,
      pr: t.pr,
      grant: g.id,
      verdict: "pass",
      source: "claude-subscription",
      fixture: false,
      evidence: outcome.evidence,
    };
  }
  g.status = "finished";
  g.outcome = outcome.status;
  t.head = outcome.head || t.head;
  t.pr = outcome.pr || t.pr;
  t.status = outcome.status;
  if (outcome.status !== "reviewed") t.approval = null;
  if (["blocked", "reviewed"].includes(outcome.status)) state.active = null;
  audit(
    state,
    "finished",
    { ticket: g.ticket, grant: g.id, status: outcome.status, head: t.head },
    now
  );
  return state;
}
function reviewGate(state, pr) {
  try {
    validateState(state);
  } catch {
    return { ok: false, reason: "Usage ledger unavailable or invalid" };
  }
  for (const t of Object.values(state.tickets)) {
    const a = t.approval;
    const g = a && state.grants[a.grant];
    if (
      t.pr === pr.number &&
      t.head === pr.head &&
      t.status === "reviewed" &&
      a?.pr === pr.number &&
      a.head === pr.head &&
      a.verdict === "pass" &&
      a.source === "claude-subscription" &&
      a.fixture === false &&
      g?.phase === "review" &&
      g.status === "finished" &&
      g.outcome === "reviewed" &&
      g.head === pr.head &&
      t.reviews > 0 &&
      (t.coding > 0 || t.origin === "owner-pr")
    )
      return {
        ok: true,
        reason: "Independent subscription review covers this exact commit",
        evidence: a.evidence,
      };
  }
  return { ok: false, reason: "No genuine independent review covers this PR commit" };
}
module.exports = {
  REPOSITORY,
  OWNER,
  SHA,
  LIMITS,
  readConfig,
  assertSubscriptionEnv,
  emptyState,
  validateState,
  authorize,
  dayKey,
  reserve,
  preflight,
  finish,
  reviewGate,
  audit,
};
