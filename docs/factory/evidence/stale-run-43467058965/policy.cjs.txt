const { randomUUID } = require("node:crypto");
const recovery = require("./recovery.cjs");

const REPOSITORY = "haideearus/cypress-realworld-app";
const OWNER = "haideearus";
const SHA = /^[a-f0-9]{40}$/;
const AUTOMATIC_WORKFLOW_REF = `${REPOSITORY}/.github/workflows/factory-automatic.yml@refs/heads/main`;
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const LIMITS = {
  FACTORY_MAX_TICKETS_PER_DAY: ["daily", 10],
  FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET: ["coding", 5],
  FACTORY_MAX_REVIEWS_PER_TICKET: ["reviews", 5],
  FACTORY_MAX_AUTOMATIC_RETRIES: ["retries", 4],
  FACTORY_MAX_CONCURRENT_TICKETS: ["concurrent", 1],
  FACTORY_RUN_TIMEOUT_MINUTES: ["minutes", 30],
  FACTORY_MAX_TURNS_PER_RUN: ["turns", 200],
};
const MAX_CODING_ATTEMPTS = LIMITS.FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET[1];
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
  for (const [key, name] of [
    ["FACTORY_AUTOMATION_ENABLED", "automatic"],
    ["FACTORY_AUTOMERGE_ENABLED", "autoMerge"],
  ]) {
    if (![undefined, "true", "false"].includes(vars[key])) deny(`Invalid automatic boolean ${key}`);
    config[name] = vars[key] === "true";
  }
  config.appClientId = vars.FACTORY_GITHUB_APP_CLIENT_ID;
  config.appSlug = vars.FACTORY_GITHUB_APP_SLUG;
  if (
    (config.appClientId !== undefined &&
      (typeof config.appClientId !== "string" ||
        !/^Iv(?:1\.[A-Za-z0-9]{1,96}|[A-Za-z0-9]{8,98})$/.test(config.appClientId))) ||
    (config.appSlug !== undefined &&
      (typeof config.appSlug !== "string" || !APP_SLUG.test(config.appSlug))) ||
    (config.enabled &&
      (config.automatic || config.autoMerge) &&
      (!config.appClientId || !config.appSlug))
  )
    deny("Invalid or missing GitHub App identity");
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
  const recovered = recovery.validateState(state);
  for (const [id, ticket] of Object.entries(state.tickets)) {
    const recoveryCount = recovered.has(id) ? 1 : 0;
    if (
      !/^[1-9]\d*$/.test(id) ||
      !ticket ||
      !SHA.test(ticket.head) ||
      !Number.isInteger(ticket.coding) ||
      ticket.coding < (ticket.origin === "owner-pr" ? 0 : 1) ||
      ticket.coding > MAX_CODING_ATTEMPTS ||
      ![undefined, "factory", "owner-pr"].includes(ticket.origin) ||
      (ticket.origin === "owner-pr" &&
        (ticket.coding !== 0 || !Number.isSafeInteger(ticket.pr) || ticket.pr < 1)) ||
      !Number.isInteger(ticket.reviews) ||
      ticket.reviews < 0 ||
      ticket.reviews > LIMITS.FACTORY_MAX_REVIEWS_PER_TICKET[1] ||
      !Number.isInteger(ticket.retries) ||
      ticket.retries < 0 ||
      ticket.retries > LIMITS.FACTORY_MAX_AUTOMATIC_RETRIES[1]
    )
      deny("Invalid ledger ticket counters");
    const grants = Object.values(state.grants).filter((g) => g?.ticket === Number(id));
    if (ticket.automatic !== undefined) {
      const a = ticket.automatic;
      const firstCode = grants.find((g) => g.phase === "code");
      if (
        !record(a) ||
        Object.keys(a).sort().join(",") !== "appSlug,runAttempt,runId,workflowRef,workflowSha" ||
        ticket.origin !== "factory" ||
        a.workflowRef !== AUTOMATIC_WORKFLOW_REF ||
        typeof a.workflowSha !== "string" ||
        !SHA.test(a.workflowSha) ||
        typeof a.runId !== "string" ||
        !/^[1-9]\d*$/.test(a.runId) ||
        !Number.isSafeInteger(a.runAttempt) ||
        a.runAttempt < 1 ||
        typeof a.appSlug !== "string" ||
        !APP_SLUG.test(a.appSlug) ||
        !firstCode ||
        firstCode.runId !== a.runId ||
        firstCode.runAttempt !== a.runAttempt
      )
        deny("Invalid automatic ticket provenance");
    }
    if (ticket.merge !== undefined) {
      const m = ticket.merge;
      const validTime =
        typeof m?.at === "string" &&
        Number.isFinite(Date.parse(m.at)) &&
        new Date(m.at).toISOString() === m.at;
      if (
        !ticket.automatic ||
        !record(m) ||
        Object.keys(m).some(
          (key) =>
            !["status", "head", "pr", "at", "runId", "runAttempt", "mergeCommit"].includes(key)
        ) ||
        !["intent", "merged", "closed"].includes(m.status) ||
        typeof m.head !== "string" ||
        !SHA.test(m.head) ||
        m.head !== ticket.head ||
        !Number.isSafeInteger(m.pr) ||
        m.pr < 1 ||
        m.pr !== ticket.pr ||
        !validTime ||
        typeof m.runId !== "string" ||
        !/^[1-9]\d*$/.test(m.runId) ||
        !Number.isSafeInteger(m.runAttempt) ||
        m.runAttempt < 1 ||
        (m.status === "merged"
          ? typeof m.mergeCommit !== "string" || !SHA.test(m.mergeCommit)
          : m.mergeCommit !== undefined)
      )
        deny("Invalid automatic merge metadata");
    }
    if (
      grants.filter((g) => g.phase === "code").length !== ticket.coding ||
      grants.filter((g) => g.phase === "review").length !== ticket.reviews ||
      ticket.retries !== Math.max(0, ticket.coding - 1 - recoveryCount) ||
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
    ((request.event !== "workflow_dispatch" || request.workflowRef === AUTOMATIC_WORKFLOW_REF) &&
      !isAutomaticContext(request))
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
function isAutomaticContext(request) {
  return Boolean(
    request &&
      request.repository === REPOSITORY &&
      request.actor === OWNER &&
      request.triggeringActor === OWNER &&
      request.ref === "refs/heads/main" &&
      ["schedule", "workflow_dispatch"].includes(request.event) &&
      request.workflowRef === AUTOMATIC_WORKFLOW_REF &&
      typeof request.workflowSha === "string" &&
      SHA.test(request.workflowSha)
  );
}
function matchesAutomaticRun(ticket, context, config) {
  const a = ticket?.automatic;
  return Boolean(
    a &&
      a.workflowRef === context.workflowRef &&
      a.workflowSha === context.workflowSha &&
      a.runId === context.runId &&
      a.runAttempt === context.runAttempt &&
      a.appSlug === config.appSlug
  );
}
function audit(state, event, detail, now = new Date()) {
  state.audit.push({ at: now.toISOString(), event, ...detail });
  state.audit = state.audit.slice(-500);
}
function reserve(original, request, config, now = new Date()) {
  validateState(original);
  authorize(request);
  if (!config.enabled || !config.minutes || !config.turns) deny("Factory disabled");
  const automatic = isAutomaticContext(request);
  if (automatic && !config.automatic) deny("Automatic factory disabled");
  const recovering = request.recovery !== undefined;
  if (recovering) recovery.assertEligible(original, request, config);
  const state = structuredClone(original);
  const id = String(request.ticket);
  const existing = state.tickets[id];
  if (
    automatic &&
    (request.recovery !== undefined ||
      request.origin !== undefined ||
      (existing && !matchesAutomaticRun(existing, request, config)))
  )
    deny("Invalid automatic reservation provenance");
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
    if (!recovering && t.coding >= config.coding) deny("Coding attempt limit reached");
    if (!recovering && t.coding > 0) {
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
  if (recovering) {
    recovery.record(state, grant);
    audit(
      state,
      "recovery_reserved",
      {
        ticket: request.ticket,
        grant: grant.id,
        recovery: recovery.ID,
        actor: request.actor,
        runId: request.runId,
      },
      now
    );
  }
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
  const automatic = isAutomaticContext(context);
  if (automatic && !config.automatic) deny("Automatic factory disabled");
  const grant = state.grants[grantId];
  const ticket = grant && state.tickets[String(grant.ticket)];
  if (automatic && !matchesAutomaticRun(ticket, context, config))
    deny("Invalid automatic reservation provenance");
  if (
    ticket &&
    (ticket.coding > config.coding + recovery.allowance(state, grant.ticket, config) ||
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
  AUTOMATIC_WORKFLOW_REF,
  LIMITS,
  MAX_CODING_ATTEMPTS,
  readConfig,
  assertSubscriptionEnv,
  emptyState,
  validateState,
  authorize,
  isAutomaticContext,
  dayKey,
  reserve,
  preflight,
  finish,
  reviewGate,
  audit,
};
