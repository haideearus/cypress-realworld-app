const slots = require("./active-tickets.cjs");
const { terminalParent } = require("./active-runs.cjs");
const policy = require("./policy.cjs");
const { GitHub, Ledger, ROOT } = require("./github.cjs");
const { Controller, runtimeContext, output } = require("./controller.cjs");
const { secretLike } = require("./artifacts.cjs");
const { verifyMonitorIssue } = require("./monitor-origin.cjs");

const QUEUE_LABEL = "factory-ready";
const MAX_QUEUE_PAGES = 5;

function queueIssue(issue) {
  return (
    issue &&
    Number.isSafeInteger(issue.number) &&
    issue.number > 0 &&
    issue.state === "open" &&
    !issue.pull_request &&
    Array.isArray(issue.labels) &&
    issue.labels.some((label) => label?.name === QUEUE_LABEL) &&
    typeof issue.title === "string" &&
    issue.title.length > 0 &&
    issue.title.length <= 300 &&
    (issue.body === null || typeof issue.body === "string") &&
    (issue.body || "").length <= 20000 &&
    !secretLike(issue.title + "\n" + (issue.body || "")) &&
    Number.isFinite(Date.parse(issue.created_at))
  );
}

function eligibleIssue(issue) {
  return queueIssue(issue) && issue.user?.login === policy.OWNER;
}

function assertAutomaticContext(context) {
  policy.authorize(context);
  if (!policy.isAutomaticContext(context))
    throw new Error("Automatic operation requires its trusted workflow identity");
}

class AutomaticCoordinator {
  constructor(api, config, context) {
    this.api = api;
    this.config = config;
    this.context = context;
    this.ledger = new Ledger(api);
    this.controller = new Controller(api, config, context);
  }

  async candidate(state) {
    for (let page = 1; page <= MAX_QUEUE_PAGES; page++) {
      const rows = await this.api.request(
        "GET",
        `${ROOT}/issues?state=open&labels=${QUEUE_LABEL}&sort=created&direction=asc&per_page=100&page=${page}`
      );
      if (!Array.isArray(rows) || rows.length > 100)
        throw new Error("Invalid bounded issue queue response");
      const candidates = rows
        .filter((issue) => queueIssue(issue) && !state.tickets[String(issue.number)])
        .sort(
          (left, right) =>
            Date.parse(left.created_at) - Date.parse(right.created_at) || left.number - right.number
        );
      for (const issue of candidates) {
        if (eligibleIssue(issue)) return issue;
        if (
          issue.user?.login === "github-actions[bot]" &&
          issue.user?.type === "Bot" &&
          (await verifyMonitorIssue(this.api, issue))
        )
          return issue;
      }
      if (rows.length < 100) return null;
    }
    return null;
  }

  async pick({ dryRun = false } = {}) {
    if (typeof dryRun !== "boolean") throw new Error("Preview mode must be a boolean");
    assertAutomaticContext(this.context);
    if (!dryRun && (!this.config.enabled || !this.config.automatic))
      return { ready: false, reason: "Automatic pickup disabled; no model invocation" };

    const { state } = await this.ledger.read();
    if (state.stop)
      return {
        ready: false,
        preview: dryRun,
        reason: "Factory stopped by owner; explicit resume is required",
      };
    const intentOwner = slots.pendingIntent(state);
    if (intentOwner) {
      if (!intentOwner.record.automatic)
        return {
          ready: false,
          preview: dryRun,
          reason: "Pending dependency merge intent must be reconciled",
        };
      const entry = slots.activeFor(state, intentOwner.ticket);
      if (state.version === 2 && entry && !(await terminalParent(this.api, entry)))
        return { ready: false, preview: dryRun, reason: "Merge intent parent is still running" };
      return {
        ready: false,
        preview: dryRun,
        kind: "merge",
        ticket: intentOwner.ticket,
        reason: "Reconcile the global recorded merge intent before any other work",
      };
    }
    if (
      Object.values(state.tickets).some(
        (t) =>
          t.dependency && t.status === "reviewed" && !["closed", "merged"].includes(t.merge?.status)
      )
    )
      return {
        ready: false,
        preview: dryRun,
        reason: "Pending dependency merge must be reconciled",
      };
    for (const entry of slots.activeEntries(state)) {
      const held = state.tickets[String(entry.ticket)];
      const intent = held?.merge;
      if (
        state.version === 2 &&
        held?.automatic &&
        held.status === "reviewed" &&
        !["merged", "closed"].includes(intent?.status) &&
        (await terminalParent(this.api, entry))
      )
        return {
          ready: false,
          preview: dryRun,
          kind: "merge",
          ticket: entry.ticket,
          reason: "Reconcile the completed reviewed parent before admitting new work",
        };
      if (
        held?.automatic &&
        held.status === "reviewed" &&
        intent?.status === "intent" &&
        intent.runId === entry.runId &&
        intent.runAttempt === entry.runAttempt &&
        !Object.values(state.grants).some((grant) => grant.status === "reserved")
      )
        return {
          ready: false,
          preview: dryRun,
          kind: "merge",
          ticket: entry.ticket,
          reason: "Reconcile the recorded merge before admitting new work",
        };
    }
    if (!slots.capacity(state, this.config.concurrent))
      return { ready: false, preview: dryRun, reason: "Another active ticket holds the lock" };
    const pending = Object.entries(state.tickets)
      .filter(
        ([id, ticket]) =>
          ticket.automatic &&
          ticket.origin === "factory" &&
          ticket.status === "reviewed" &&
          (state.version === 1 || !slots.activeFor(state, Number(id))) &&
          !["merged", "closed"].includes(ticket.merge?.status)
      )
      .sort(([left], [right]) => Number(left) - Number(right))[0];
    if (pending)
      return {
        ready: false,
        preview: dryRun,
        kind: "merge",
        ticket: Number(pending[0]),
        reason: "Reconcile the pending automatic PR before admitting new work",
      };

    const candidate = await this.candidate(state);
    if (!candidate)
      return { ready: false, preview: dryRun, reason: "No eligible issue in the bounded queue" };
    if (dryRun)
      return {
        ready: false,
        preview: true,
        kind: "ticket",
        ticket: candidate.number,
        reason: "Preview only; no reservation, model session or merge",
      };
    try {
      const result = await this.controller.admit(candidate.number);
      return { ...result, kind: "ticket" };
    } catch (error) {
      if (
        /limit reached|budget|Another active ticket|unfinished reservation|new ticket|already admitted|Pending automatic merge/i.test(
          error.message
        )
      )
        return { ready: false, reason: "Automatic admission stopped by a usage or state limit" };
      throw error;
    }
  }
}

function dryRunInput(value) {
  if (value === undefined || value === false || value === "false") return false;
  if (value === true || value === "true") return true;
  throw new Error("Invalid preview mode");
}

async function main(env = process.env) {
  const config = policy.readConfig(JSON.parse(env.FACTORY_VARIABLES || "{}"));
  policy.assertSubscriptionEnv(env);
  const inputs = JSON.parse(env.FACTORY_INPUTS || "{}");
  const dryRun = dryRunInput(inputs.dry_run);
  const operation = env.FACTORY_OPERATION;
  if (!["auto_pick", "auto_merge"].includes(operation))
    throw new Error("Unknown automatic factory operation");
  if (!dryRun && (!config.enabled || !config.automatic)) {
    assertAutomaticContext(runtimeContext(env));
    const result = { ready: false, reason: "Automatic factory disabled; no model invocation" };
    output(result, env);
    return result;
  }
  const api = new GitHub({ token: env.GH_TOKEN });
  const context = await require("./trusted-wake.cjs").loadWakeContext(api, runtimeContext(env), env, { bind: operation === "auto_pick" });
  assertAutomaticContext(context);
  let result;
  if (operation === "auto_pick") {
    result = await new AutomaticCoordinator(api, config, context).pick({ dryRun });
  } else {
    const { AutomaticMerger } = require("./merge.cjs");
    result = await new AutomaticMerger(api, config, context).merge(Number(inputs.ticket), {
      dryRun,
    });
  }
  output(result, env);
  return result;
}

if (require.main === module)
  main().catch((error) => {
    console.error(
      secretLike(error.message) ? "Automatic operation refused" : error.message.slice(0, 240)
    );
    process.exitCode = 1;
  });

module.exports = {
  QUEUE_LABEL,
  MAX_QUEUE_PAGES,
  eligibleIssue,
  assertAutomaticContext,
  AutomaticCoordinator,
  dryRunInput,
  main,
};
