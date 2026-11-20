const active = require("./active-tickets.cjs");
const { randomUUID } = require("node:crypto");
const dependency = require("./dependency-contract.cjs");
const recovery = require("./recovery.cjs");
const { validateMonitorProof } = require("./monitor-proof.cjs");
const { DRILL_WORKFLOW_REF, isDrillContext, validateDrillProof } = require("./drill-contract.cjs");
const { validateStop } = require("./stop-contract.cjs");
const { denyRetiredRun } = require("./quarantine-contract.cjs");

const REPOSITORY = "haideearus/cypress-realworld-app";
const OWNER = "haideearus";
const SHA = /^[a-f0-9]{40}$/;
const AUTOMATIC_WORKFLOW_REF = `${REPOSITORY}/.github/workflows/factory-automatic.yml@refs/heads/main`;
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const LIMITS = {
  FACTORY_MAX_TICKETS_PER_DAY: ["daily", 20],
  FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET: ["coding", 5],
  FACTORY_MAX_REVIEWS_PER_TICKET: ["reviews", 10],
  FACTORY_MAX_AUTOMATIC_RETRIES: ["retries", 4],
  FACTORY_MAX_CONCURRENT_TICKETS: ["concurrent", 2],
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
  if (![undefined, "true", "false"].includes(vars.FACTORY_DISCOVERY_ENABLED))
    throw Error("Invalid discovery opt-in");
  const config = {
    enabled: vars.FACTORY_ENABLED === "true",
    discovery: vars.FACTORY_DISCOVERY_ENABLED === "true",
  };
  if (![undefined, "true", "false"].includes(vars.FACTORY_ENABLED)) deny("Invalid enabled setting");
  for (const [key, name] of [
    ["FACTORY_AUTOMATION_ENABLED", "automatic"],
    ["FACTORY_AUTOMERGE_ENABLED", "autoMerge"],
    ["FACTORY_EVENT_PICKUP_ENABLED", "eventPickup"],
    ["FACTORY_ACTIVITY_LOG_ENABLED", "activityLog"],
    ["FACTORY_PRIORITY_RETRY_ENABLED", "priorityRetry"],
    ["FACTORY_DEPENDENCY_ALERT_REPAIR_ENABLED", "alertRepair"],
  ]) {
    if (![undefined, "true", "false"].includes(vars[key])) deny(`Invalid automatic boolean ${key}`);
    config[name] = vars[key] === "true";
  }
  config.appClientId = vars.FACTORY_GITHUB_APP_CLIENT_ID;
  if (vars.FACTORY_ACTIVITY_ISSUE_NUMBER !== undefined) {
    config.activityIssue = integer(vars.FACTORY_ACTIVITY_ISSUE_NUMBER, "activity journal");
    if (config.activityIssue < 1) deny("Invalid activity journal");
  }
  if (config.activityLog && !config.activityIssue) deny("Activity journal required");
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
  if (![1, 2].includes(config.concurrent)) deny("Invalid concurrency: must be one or two");
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
    ![1, 2].includes(state.version) ||
    state.repository !== REPOSITORY ||
    !record(state.days) ||
    !record(state.tickets) ||
    !record(state.grants) ||
    !Array.isArray(state.audit)
  )
    deny("Invalid factory ledger state");
  const entries = active.validateActive(state);
  validateStop(state.stop);
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
  const drillRuns = new Set();
  const drillIncidents = new Set();
  for (const [id, ticket] of Object.entries(state.tickets)) {
    const recoveryCount = recovered.has(id) ? 1 : 0;
    if (
      !/^[1-9]\d*$/.test(id) ||
      !ticket ||
      !SHA.test(ticket.head) ||
      !Number.isInteger(ticket.coding) ||
      ticket.coding <
        (["owner-pr", "dependency-pr", "discovery-sweep"].includes(ticket.origin) ? 0 : 1) ||
      ticket.coding > MAX_CODING_ATTEMPTS ||
      ![undefined, "factory", "owner-pr", "dependency-pr", "drill", "discovery-sweep"].includes(
        ticket.origin
      ) ||
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
    require("./review-recovery.cjs").validateReceipt(ticket, id, grants);
    if (ticket.delayedRetry !== undefined) require("./delayed-retry.cjs").validate(ticket, grants);
    if (ticket.origin === "discovery-sweep")
      require("./discovery-policy.cjs").validateTicket(ticket, grants);
    else if (
      ticket.discovery !== undefined ||
      ["discovering", "discovery_complete"].includes(ticket.status)
    )
      deny("Invalid discovery origin");
    if (ticket.origin === "dependency-pr") dependency.validateTicket(ticket, grants);
    else if (ticket.dependency !== undefined) deny("Invalid dependency ticket origin");
    if (ticket.origin === "drill") {
      const d = ticket.drill;
      const g = grants[0];
      if (
        !validateDrillProof(d) ||
        ticket.coding !== 1 ||
        ticket.reviews !== 0 ||
        ticket.retries !== 0 ||
        ticket.pr !== null ||
        ticket.approval !== null ||
        ticket.head !== d.seedSha ||
        ["automatic", "monitor", "merge", "recovery"].some((key) => ticket[key] !== undefined) ||
        grants.length !== 1 ||
        !g ||
        g.phase !== "code" ||
        g.slot !== "drill" ||
        g.head !== d.seedSha ||
        g.runId !== d.runId ||
        g.runAttempt !== 1 ||
        !["coding", "blocked", "drill_complete"].includes(ticket.status) ||
        (ticket.status === "coding"
          ? g.status !== "reserved"
          : g.status !== "finished" ||
            g.outcome !== ticket.status ||
            active.activeFor(state, Number(id))) ||
        drillRuns.has(d.runId) ||
        drillIncidents.has(d.incidentId)
      )
        deny("Invalid drill ticket provenance or reservation");
      drillRuns.add(d.runId);
      drillIncidents.add(d.incidentId);
    } else if (ticket.drill !== undefined || ticket.status === "drill_complete") {
      deny("Invalid drill ticket origin");
    }
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
    if (
      ticket.monitor !== undefined &&
      (!ticket.automatic ||
        !validateMonitorProof(ticket.monitor) ||
        ticket.monitor.issue !== Number(id) ||
        ticket.monitor.criteriaHash !== ticket.criteriaHash)
    )
      deny("Invalid monitor ticket provenance");
    if (ticket.finding !== undefined) {
      const f = require("./discovery-finding-contract.cjs");
      const first = grants.find((g) => g.phase === "code");
      if (
        !record(ticket.finding) ||
        Object.keys(ticket.finding).sort().join(",") !== "intake,origin" ||
        ticket.origin !== "factory" ||
        !ticket.automatic ||
        ticket.monitor ||
        !first
      )
        deny("Invalid discovery finding repair provenance");
      f.validateOriginProof(ticket.finding.origin);
      f.validateReplay(ticket.finding.intake);
      if (
        ticket.finding.origin.issue !== Number(id) ||
        ticket.finding.origin.criteriaHash !== ticket.criteriaHash ||
        ticket.finding.intake.key !== ticket.finding.origin.key ||
        ticket.finding.intake.outcome !== "ready" ||
        ticket.finding.intake.head !== first.head
      )
        deny("Invalid discovery finding repair receipt");
    }
    // Validate the last handoff before allowing its grants to be excluded from earlier proofs.
    const priorFindingGrants = require("./finding-api-recovery.cjs").validateRecovery(
      state,
      id,
      ticket,
      grants
    );
    if (ticket.findingOutputRecovery !== undefined)
      require("./finding-output-recovery.cjs").validateRecovery(
        state,
        id,
        ticket,
        priorFindingGrants
      );
    if (ticket.findingContinuation !== undefined)
      require("./finding-continuation.cjs").validateContinuation(
        state,
        id,
        ticket,
        priorFindingGrants
      );
    if (ticket.findingRetry !== undefined)
      require("./finding-retry.cjs").validateRetry(state, id, ticket, priorFindingGrants);
    if (
      ticket.findingRedHash !== undefined &&
      (!ticket.finding || !/^[a-f0-9]{64}$/.test(ticket.findingRedHash))
    )
      deny("Invalid preserved finding RED");
    if (ticket.merge !== undefined) {
      const m = ticket.merge;
      const validTime =
        typeof m?.at === "string" &&
        Number.isFinite(Date.parse(m.at)) &&
        new Date(m.at).toISOString() === m.at;
      if (
        (!ticket.automatic && ticket.origin !== "dependency-pr") ||
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
      ![
        "new",
        "coding",
        "reviewing",
        "awaiting_review",
        "retry",
        "blocked",
        "reviewed",
        "drill_complete",
        "discovering",
        "discovery_complete",
      ].includes(ticket.status)
    )
      deny("Invalid ledger history or admission counters");
  }
  for (const [id, g] of Object.entries(state.grants)) {
    if (
      !g ||
      g.id !== id ||
      !state.tickets[String(g.ticket)] ||
      !["code", "review", "discover"].includes(g.phase) ||
      (g.phase === "discover") !==
        (state.tickets[String(g.ticket)]?.origin === "discovery-sweep") ||
      !["reserved", "finished"].includes(g.status) ||
      !SHA.test(g.head) ||
      !/^[1-9]\d*$/.test(g.runId) ||
      !Number.isSafeInteger(g.runAttempt) ||
      g.runAttempt < 1
    )
      deny("Invalid ledger reservation");
  }
  const pending = Object.values(state.grants).filter((g) => g.status === "reserved");
  if (
    pending.length > entries.length ||
    new Set(pending.map((g) => g.ticket)).size !== pending.length ||
    pending.some((g) => !active.owns(active.activeFor(state, g.ticket), g))
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
  denyRetiredRun(request.runId);
  const savedReview = require("./review-recovery.cjs");
  if (request.workflowRef === savedReview.WORKFLOW_REF || request.slot === savedReview.SLOT)
    savedReview.assertContext(request);
  if (require("./discovery-policy.cjs").contextOK(request)) return;
  if (
    request.workflowRef === require("./discovery-contract.cjs").WORKFLOW_REF ||
    request.slot === "discovery"
  )
    deny("Unauthorized discovery role");
  if (
    request.repository !== REPOSITORY ||
    ((request.actor !== OWNER || request.triggeringActor !== OWNER) &&
      !require("./trusted-wake.cjs").isTrustedWakeContext(request)) ||
    request.ref !== "refs/heads/main" ||
    (request.workflowRef === DRILL_WORKFLOW_REF && !isDrillContext(request)) ||
    ((request.event !== "workflow_dispatch" || request.workflowRef === AUTOMATIC_WORKFLOW_REF) &&
      !isAutomaticContext(request) &&
      !dependency.contextOK(request))
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
      ((request.actor === OWNER && request.triggeringActor === OWNER) ||
        require("./trusted-wake.cjs").isTrustedWakeContext(request, "app")) &&
      request.ref === "refs/heads/main" &&
      ["schedule", "workflow_dispatch"].includes(request.event) &&
      request.workflowRef === AUTOMATIC_WORKFLOW_REF &&
      typeof request.workflowSha === "string" &&
      SHA.test(request.workflowSha)
  );
}
function matchesAutomaticRun(ticket, context, config) {
  const a = ticket?.automatic;
  const parent =
    ticket?.delayedRetry?.parent ||
    ticket?.findingApiRecovery ||
    ticket?.findingOutputRecovery ||
    ticket?.findingContinuation ||
    ticket?.findingRetry ||
    a;
  return Boolean(
    a &&
      (!ticket.delayedRetry?.parent || config.priorityRetry) &&
      (!ticket.findingApiRecovery || (!config.discovery && !config.autoMerge)) &&
      a.workflowRef === context.workflowRef &&
      parent.workflowSha === context.workflowSha &&
      parent.runId === context.runId &&
      parent.runAttempt === context.runAttempt &&
      a.appSlug === config.appSlug
  );
}
function audit(state, event, detail, now = new Date()) {
  state.audit.push({ at: now.toISOString(), event, ...detail });
  state.audit = state.audit.slice(-500);
}
function reserve(original, request, config, now = new Date()) {
  validateState(original);
  assertNotStopped(original);
  authorize(request);
  if (require("./discovery-policy.cjs").contextOK(request))
    return require("./discovery-policy.cjs").reserveSweep(original, request, config, now);
  if (original.tickets[String(request.ticket)]?.origin === "discovery-sweep")
    deny("Discovery cannot enter ordinary work");
  if (!config.enabled || !config.minutes || !config.turns) deny("Factory disabled");
  if (request.wake && !config.eventPickup) deny("Event pickup disabled");
  const automatic = isAutomaticContext(request);
  if (automatic && !config.automatic) deny("Automatic factory disabled");
  const recovering = request.recovery !== undefined;
  if (
    [
      request.recovery,
      request.findingRetry,
      request.findingContinuation,
      request.findingOutputRecovery,
      request.findingApiRecovery,
      request.delayedRetry,
    ].filter((value) => value !== undefined).length > 1
  )
    deny("Invalid mixed recovery handoffs");
  if (recovering) recovery.assertEligible(original, request, config);
  if (request.findingRetry !== undefined)
    require("./finding-retry.cjs").assertEligible(original, request, config);
  if (request.findingContinuation !== undefined)
    require("./finding-continuation.cjs").assertEligible(original, request, config);
  if (request.findingOutputRecovery !== undefined)
    require("./finding-output-recovery.cjs").assertEligible(original, request, config);
  if (request.findingApiRecovery !== undefined)
    require("./finding-api-recovery.cjs").assertEligible(original, request, config);
  const state = structuredClone(original);
  const id = String(request.ticket);
  const existing = state.tickets[id];
  if (request.delayedRetry !== undefined)
    require("./delayed-retry.cjs").handoff(state, request, config, now);
  if (request.findingRetry !== undefined)
    existing.findingRetry = structuredClone(request.findingRetry);
  if (request.findingContinuation !== undefined)
    existing.findingContinuation = structuredClone(request.findingContinuation);
  if (request.findingOutputRecovery !== undefined)
    existing.findingOutputRecovery = structuredClone(request.findingOutputRecovery);
  if (request.findingApiRecovery !== undefined)
    existing.findingApiRecovery = structuredClone(request.findingApiRecovery);
  const drill = request.origin === "drill";
  if (existing?.origin === "drill") deny("Drill reservation cannot be repeated or reclassified");
  if (drill) {
    if (
      !isDrillContext(request) ||
      !validateDrillProof(request.drill) ||
      config.automatic ||
      config.autoMerge ||
      existing ||
      request.phase !== "code" ||
      request.slot !== "drill" ||
      request.head !== request.drill.seedSha ||
      request.pr !== undefined ||
      request.recovery !== undefined ||
      ["runId", "runAttempt", "workflowRef", "workflowSha"].some(
        (key) => request.drill[key] !== request[key]
      ) ||
      Object.values(state.tickets).some(
        (t) =>
          t.drill &&
          (t.drill.runId === request.runId || t.drill.incidentId === request.drill.incidentId)
      )
    )
      deny("Invalid or repeated drill reservation");
  } else if (
    request.drill !== undefined ||
    request.workflowRef === DRILL_WORKFLOW_REF ||
    request.slot === "drill"
  ) {
    deny("Invalid drill reservation origin");
  }
  if (
    automatic &&
    (request.recovery !== undefined ||
      request.origin !== undefined ||
      (existing && !matchesAutomaticRun(existing, request, config)))
  )
    deny("Invalid automatic reservation provenance");
  const ownerReview = request.phase === "review" && request.origin === "owner-pr";
  const dependencyReview = request.phase === "review" && request.origin === "dependency-pr";
  if (dependencyReview) {
    const a = require("./dependency-analysis.cjs");
    const attempt = dependency.validateTicket(existing);
    a.validateReport(
      existing.analysis,
      {
        repository: REPOSITORY,
        pr: existing.pr,
        base: attempt.base,
        head: existing.head,
        workflowSha: attempt.workflowSha,
        runId: attempt.runId,
        runAttempt: attempt.runAttempt,
        stage: "analysis",
        toolDigest: a.toolDigest(),
      },
      new Date(existing.analysis?.at)
    );
    if (
      !existing ||
      !dependency.contextOK(request) ||
      request.slot !== "dependency" ||
      request.pr !== existing.pr ||
      !config.automatic
    )
      deny("Invalid dependency review origin");
    dependency.matches(existing, request, config);
    if (
      !existing.analysis ||
      existing.analysis.head !== request.head ||
      existing.ci?.head !== request.head ||
      existing.ci.passed !== true
    )
      deny("Dependency analysis and CI required");
  }
  if (
    (dependency.contextOK(request) && !dependencyReview) ||
    (existing?.origin === "dependency-pr" && !dependencyReview)
  )
    deny("Dependency origin cannot enter ordinary work");
  if (request.origin !== undefined && !ownerReview && !dependencyReview && !drill)
    deny("Invalid reservation origin");
  if (ownerReview && (!Number.isSafeInteger(request.pr) || request.pr < 1))
    deny("Invalid owner PR number");
  if (
    (ownerReview && existing && (existing.origin !== "owner-pr" || existing.pr !== request.pr)) ||
    (existing?.origin === "owner-pr" && !ownerReview)
  )
    deny("Ticket origin cannot change between owner review and coding");
  const owner = active.activeFor(state, request.ticket);
  if (
    (owner && !active.owns(owner, request)) ||
    (!owner && !active.capacity(state, config.concurrent))
  )
    deny("Another active ticket/run holds the factory lock");
  active.capacity(state, config.concurrent);
  if (
    Object.values(state.grants).some((g) => g.ticket === request.ticket && g.status === "reserved")
  )
    deny("An unfinished reservation must be recovered before starting another");
  if (
    request.phase === "review" &&
    !ownerReview &&
    !dependencyReview &&
    (!existing ||
      !owner ||
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
      origin: drill ? "drill" : ownerReview ? "owner-pr" : "factory",
      reviews: 0,
      retries: 0,
      head: request.head,
      status: "new",
      pr: ownerReview ? request.pr : null,
      approval: null,
      ...(drill ? { drill: structuredClone(request.drill) } : {}),
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
  active.claimActive(
    state,
    { ticket: request.ticket, runId: request.runId, runAttempt: request.runAttempt },
    config.concurrent
  );
  audit(
    state,
    "reserved",
    {
      ticket: request.ticket,
      grant: grant.id,
      phase: grant.phase,
      runId: grant.runId,
      runAttempt: grant.runAttempt,
      actor: request.actor,
      ...(request.wake
        ? { wakeReceipt: request.wake.receiptId, sourceActor: request.wake.sourceActor }
        : {}),
    },
    now
  );
  return { state, grant };
}
function preflight(state, grantId, context, config) {
  validateState(state);
  assertNotStopped(state);
  authorize(context);
  if (require("./discovery-policy.cjs").contextOK(context))
    return require("./discovery-policy.cjs").preflightSweep(state, grantId, context, config);
  active.capacity(state, config.concurrent);
  if (active.activeEntries(state).length > config.concurrent)
    deny("Pending reservation exceeds current concurrency limit");
  if (!config.enabled || !config.minutes || !config.turns) deny("Factory disabled");
  if (context.slot === require("./review-recovery.cjs").SLOT && config.autoMerge !== false)
    deny("Disable automatic merging before a saved-CI review");
  const automatic = isAutomaticContext(context);
  if (automatic && !config.automatic) deny("Automatic factory disabled");
  const grant = state.grants[grantId];
  const ticket = grant && state.tickets[String(grant.ticket)];
  if (ticket?.origin === "dependency-pr") {
    dependency.matches(ticket, context, config);
    if (context.phase !== "review" || context.slot !== "dependency" || !config.automatic)
      deny("Invalid dependency model role");
  } else if (dependency.contextOK(context))
    deny("Dependency workflow requires dependency provenance");
  if (ticket?.origin === "drill") {
    if (
      !isDrillContext(context) ||
      config.automatic ||
      config.autoMerge ||
      ["runId", "runAttempt", "workflowRef", "workflowSha"].some(
        (key) => ticket.drill[key] !== context[key]
      ) ||
      context.head !== ticket.drill.seedSha
    )
      deny("Invalid drill reservation context");
  } else if (context.workflowRef === DRILL_WORKFLOW_REF) {
    deny("Drill workflow requires a drill reservation");
  }
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
    !active.activeFor(state, grant.ticket) ||
    ["ticket", "phase", "slot", "runId", "runAttempt", "head"].some(
      (k) => grant[k] !== context[k]
    ) ||
    !active.owns(active.activeFor(state, grant.ticket), grant)
  )
    deny("Invalid or stale model reservation");
  return grant;
}
function finish(original, grantId, outcome, now = new Date()) {
  validateState(original);
  if (original.stop && outcome.status !== "blocked") assertNotStopped(original);
  if (original.grants[grantId]?.phase === "discover")
    return require("./discovery-policy.cjs").finishSweep(original, grantId, outcome, now);
  const state = structuredClone(original);
  const g = state.grants[grantId];
  if (!g || g.status !== "reserved" || !active.owns(active.activeFor(state, g.ticket), g))
    deny("Invalid finished reservation");
  if (
    !["blocked", "retry", "awaiting_review", "reviewed", "drill_complete"].includes(outcome.status)
  )
    deny("Invalid invocation outcome");
  const t = state.tickets[String(g.ticket)];
  if (t.origin === "drill") {
    if (
      !["blocked", "drill_complete"].includes(outcome.status) ||
      g.phase !== "code" ||
      (outcome.head !== undefined && outcome.head !== t.drill.seedSha) ||
      (outcome.pr !== undefined && outcome.pr !== null) ||
      Object.keys(outcome).some((key) => !["status", "head", "pr"].includes(key))
    )
      deny("Invalid drill invocation outcome");
  } else if (outcome.status === "drill_complete") {
    deny("Drill completion requires a drill reservation");
  }
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
  if (
    ["blocked", "reviewed", "drill_complete"].includes(outcome.status) &&
    !(
      state.version === 2 &&
      outcome.status === "reviewed" &&
      (t.automatic || t.dependency) &&
      !t.findingApiRecovery
    )
  )
    active.releaseActive(state, g);
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
      t.origin !== "drill" &&
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
      (t.coding > 0 || ["owner-pr", "dependency-pr"].includes(t.origin))
    ) {
      // Keep historical records readable, but never use absent or sample-only
      // feedback as approval. Read-only evaluation does not rewrite old grants.
      try {
        if (typeof t.feedback !== "string" || t.feedback.length > 60000) continue;
        const review = require("./artifacts.cjs").validateReview(JSON.parse(t.feedback), pr.head);
        if (review.verdict !== "pass") continue;
      } catch {
        continue;
      }
      return {
        ok: true,
        reason: "Independent subscription review covers this exact commit",
        evidence: a.evidence,
      };
    }
  }
  return { ok: false, reason: "No genuine independent review covers this PR commit" };
}
function assertNotStopped(state) {
  validateStop(state?.stop);
  if (state?.stop) deny("Factory stopped by owner; explicit resume is required");
}
module.exports = {
  assertNotStopped,
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
