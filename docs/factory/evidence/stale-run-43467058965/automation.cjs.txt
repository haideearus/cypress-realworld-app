const policy = require("./policy.cjs");
const { GitHub, Ledger, ROOT } = require("./github.cjs");
const { Controller, runtimeContext, output } = require("./controller.cjs");
const { secretLike } = require("./artifacts.cjs");

const QUEUE_LABEL = "factory-ready";
const MAX_QUEUE_PAGES = 5;

function eligibleIssue(issue) {
  return (
    issue &&
    Number.isSafeInteger(issue.number) &&
    issue.number > 0 &&
    issue.state === "open" &&
    !issue.pull_request &&
    issue.user?.login === policy.OWNER &&
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
        .filter((issue) => eligibleIssue(issue) && !state.tickets[String(issue.number)])
        .sort(
          (left, right) =>
            Date.parse(left.created_at) - Date.parse(right.created_at) || left.number - right.number
        );
      if (candidates.length) return candidates[0];
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
    if (state.active) {
      const held = state.tickets[String(state.active.ticket)];
      const intent = held?.merge;
      if (
        held?.automatic &&
        held.status === "reviewed" &&
        intent?.status === "intent" &&
        intent.runId === state.active.runId &&
        intent.runAttempt === state.active.runAttempt &&
        !Object.values(state.grants).some((grant) => grant.status === "reserved")
      )
        return {
          ready: false,
          preview: dryRun,
          kind: "merge",
          ticket: state.active.ticket,
          reason: "Reconcile the recorded merge before admitting new work",
        };
      return { ready: false, preview: dryRun, reason: "Another active ticket holds the lock" };
    }
    const pending = Object.entries(state.tickets)
      .filter(
        ([, ticket]) =>
          ticket.automatic &&
          ticket.origin === "factory" &&
          ticket.status === "reviewed" &&
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
  const context = runtimeContext(env);
  assertAutomaticContext(context);
  const inputs = JSON.parse(env.FACTORY_INPUTS || "{}");
  const dryRun = dryRunInput(inputs.dry_run);
  const operation = env.FACTORY_OPERATION;
  if (!["auto_pick", "auto_merge"].includes(operation))
    throw new Error("Unknown automatic factory operation");
  if (!dryRun && (!config.enabled || !config.automatic)) {
    const result = { ready: false, reason: "Automatic factory disabled; no model invocation" };
    output(result, env);
    return result;
  }
  const api = new GitHub({ token: env.GH_TOKEN });
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
