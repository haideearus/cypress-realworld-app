const slots = require("./active-tickets.cjs");
const { terminalParent } = require("./active-runs.cjs");
const policy = require("./policy.cjs");
const { GitHub, Ledger, ROOT } = require("./github.cjs");
const { Controller, criteriaHash, runtimeContext, output } = require("./controller.cjs");
const { secretLike } = require("./artifacts.cjs");
const { verifyMonitorIssue } = require("./monitor-origin.cjs");
const { PROBE_MODE: FUNCTIONAL_MODE } = require("./functional-discovery-contract.cjs");
const delayed = require("./delayed-retry.cjs");
const blocked = require("./blocked-retry.cjs");
const { marked } = require("./feature-contract.cjs");
const { readyFeature, verifyFeatureIssue } = require("./feature-origin.cjs");
const { repairsWaiting, productionIncident } = require("./feature-priority.cjs");
const turns = require("./feature-turn.cjs");

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

  async candidate(state, { complete = false } = {}) {
    let ordinary = null;
    for (let page = 1; page <= MAX_QUEUE_PAGES; page++) {
      const rows = await this.api.request(
        "GET",
        `${ROOT}/issues?state=open&labels=${QUEUE_LABEL}&sort=created&direction=asc&per_page=100&page=${page}`
      );
      if (!Array.isArray(rows) || rows.length > 100)
        throw new Error("Invalid bounded issue queue response");
      const candidates = rows
        .filter(
          (issue) =>
            queueIssue(issue) &&
            !marked(issue) &&
            issue.number !== this.config.activityIssue &&
            !state.tickets[String(issue.number)]
        )
        .sort(
          (left, right) =>
            Date.parse(left.created_at) - Date.parse(right.created_at) || left.number - right.number
        );
      for (const issue of candidates) {
        if (eligibleIssue(issue)) {
          if (!this.config.priorityRetry || issue.labels.some((l) => l.name === "factory-priority"))
            return issue;
          ordinary ??= issue;
        } else if (issue.user?.login === "github-actions[bot]" && issue.user?.type === "Bot") {
          const monitor = await verifyMonitorIssue(this.api, issue);
          if (monitor && (!this.config.priorityRetry || monitor.probeMode !== FUNCTIONAL_MODE))
            return issue;
          if (
            monitor ||
            (this.config.discovery &&
              (await require("./discovery-origin.cjs").verifyDiscoveryIssue(this.api, issue)))
          ) {
            if (!this.config.priorityRetry) return issue;
            ordinary ??= issue;
          }
        }
      }
      if (rows.length < 100) return ordinary;
    }
    if (this.config.priorityRetry || complete)
      throw Error("Priority queue exceeds the bounded lookup; no discretionary work admitted");
    return null;
  }

  async verifyDelayedIssue(issue, ticket) {
    if (!queueIssue(issue) || criteriaHash(issue) !== ticket.criteriaHash) return false;
    if (ticket.feature)
      return (
        ["pilot", "live"].includes(this.config.featureMode) &&
        Boolean(
          await verifyFeatureIssue(this.api, issue, {
            mode: this.config.featureMode,
            proof: ticket.feature,
          })
        )
      );
    if (ticket.monitor) {
      return Boolean(await verifyMonitorIssue(this.api, issue, { proof: ticket.monitor }));
    }
    if (ticket.finding) {
      return (
        this.config.discovery &&
        ticket.finding.intake.head === this.context.workflowSha &&
        (await require("./discovery-origin.cjs").verifyRepairOrigin(
          this.api,
          issue,
          ticket.finding,
          {
            requireCurrent: true,
          }
        ))
      );
    }
    return eligibleIssue(issue);
  }

  async delayedCandidate(state, { feature = false, priorityCheck = false, ticketNumber } = {}) {
    if (
      !this.config.priorityRetry ||
      (!priorityCheck &&
        (this.context.wake || this.context.actor !== policy.OWNER || this.context.runAttempt !== 1))
    )
      return null;
    const candidates = Object.entries(state.tickets)
      .filter(
        ([id, ticket]) =>
          (ticketNumber === undefined || Number(id) === ticketNumber) &&
          Boolean(ticket.feature) === feature &&
          delayed.due(state, ticket, Number(id), this.config)
      )
      .sort(
        ([left, a], [right, b]) =>
          a.delayedRetry.notBefore.localeCompare(b.delayedRetry.notBefore) ||
          Number(left) - Number(right)
      );
    for (const [id, ticket] of candidates) {
      const issue = await this.api.request("GET", `${ROOT}/issues/${id}`);
      if (!(await this.verifyDelayedIssue(issue, ticket))) continue;
      const parent = await this.api.request(
        "GET",
        `${ROOT}/actions/runs/${ticket.automatic.runId}`
      );
      if (
        parent.id === Number(ticket.automatic.runId) &&
        parent.run_attempt === ticket.automatic.runAttempt &&
        parent.status === "completed" &&
        parent.path === ".github/workflows/factory-automatic.yml"
      )
        return issue;
    }
    return null;
  }

  async reserveDelayed(issue, state, commit, verifiedFailure) {
    const ticket = issue.number;
    const monitor = state.tickets[ticket].monitor;
    const production = monitor && monitor.probeMode !== FUNCTIONAL_MODE;
    await this.controller.rejectDrillIssue(issue);
    const [main, unpublished, fresh] = await Promise.all([
      this.api.request("GET", `${ROOT}/branches/main`),
      blocked.hasNoPublication(this.api, ticket),
      this.api.request("GET", `${ROOT}/issues/${ticket}`),
    ]);
    if (
      !unpublished ||
      main.commit?.sha !== this.context.workflowSha ||
      fresh.number !== ticket ||
      !(await this.verifyDelayedIssue(fresh, state.tickets[ticket]))
    )
      return {
        ready: false,
        reason: "Delayed retry held after publication, issue or main changed",
      };
    // Read the ready queue again after the slower provenance and branch checks.
    if (!(production && turns.priority(state, this.config)) && (await this.candidate(state)))
      return { ready: false, reason: "New work is ready; delayed retry remains queued" };
    if (
      state.tickets[ticket].feature &&
      (await repairsWaiting(this.api, this.config, this.context, state))
    )
      return { ready: false, reason: "A repair takes priority over the feature retry" };
    const recovery = verifiedFailure?.fix || state.tickets[ticket].delayedRetry?.fix;
    if (recovery && !(await blocked.testedFixOnMain(this.api, this.context, recovery)))
      return {
        ready: false,
        reason: "Delayed retry awaits tested main with the recorded harness fix",
      };
    const unchanged = await this.api.request("GET", `${ROOT}/issues/${ticket}`);
    if (
      unchanged.number !== ticket ||
      !(await this.verifyDelayedIssue(unchanged, state.tickets[ticket]))
    )
      return { ready: false, reason: "Delayed retry issue changed before reservation" };
    const saved = await this.ledger.update(
      (current) => {
        if (turns.priority(current, this.config) && !production) throw Error(turns.WAITING);
        if (verifiedFailure) {
          if (current.tickets[ticket].delayedRetry) throw Error("Blocked retry already recorded");
          blocked.recordVerifiedRetry(current, ticket, verifiedFailure);
        }
        return policy.reserve(
          current,
          {
            ...this.context,
            ticket,
            phase: "code",
            slot: "cycle1",
            head: main.commit.sha,
            delayedRetry: true,
          },
          this.config
        );
      },
      { expectedCommit: commit }
    );
    return { ...this.controller.result(saved.grant), kind: "ticket", delayedRetry: true };
  }

  async pick({ dryRun = false, summaryPath } = {}) {
    if (typeof dryRun !== "boolean") throw new Error("Preview mode must be a boolean");
    assertAutomaticContext(this.context);
    if (!dryRun && (!this.config.enabled || !this.config.automatic))
      return { ready: false, reason: "Automatic pickup disabled; no model invocation" };

    let loaded = await this.ledger.read();
    if (!dryRun && !loaded.state.stop)
      loaded = await require("./feature-meter.cjs").reconcile(this.api, this.ledger, loaded);
    let { state, commit } = loaded;
    if (summaryPath) {
      const summary = require("./queue-summary.cjs").queueSummary(state, this.config);
      if (summary) require("node:fs").appendFileSync(summaryPath, summary);
    }
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
          t.dependency &&
          t.status === "reviewed" &&
          !["closed", "merged"].includes(t.merge?.status) &&
          require("./dependency-merge-retry.cjs").blocksQueue(t)
      )
    )
      return {
        ready: false,
        preview: dryRun,
        reason: "Pending dependency merge must be reconciled",
      };
    for (const entry of slots.activeEntries(state)) {
      const held = state.tickets[String(entry.ticket)];
      if (!dryRun && held?.publishedRecovery) {
        const saved = await require("./published-review-recovery.cjs").releaseTerminalRecovery(
          this,
          entry,
          held,
          commit
        );
        if (saved) {
          state = saved.state;
          commit = saved.commit;
          continue;
        }
      }
      if (
        held?.feature &&
        held.feature.mode !== this.config.featureMode &&
        held.status === "reviewed" &&
        !held.merge &&
        (await terminalParent(this.api, entry)) &&
        !dryRun
      ) {
        const saved = await this.ledger.update(
          (current) => {
            if (
              !slots.owns(slots.activeFor(current, entry.ticket), entry) ||
              current.tickets[entry.ticket]?.merge
            )
              throw Error("Paused feature ownership changed");
            slots.releaseActive(current, entry);
            return { state: current };
          },
          { expectedCommit: commit }
        );
        state = saved.state;
        commit = saved.commit;
        continue;
      }
      const intent = held?.merge;
      if (
        state.version === 2 &&
        held?.automatic &&
        (!held.feature || held.feature.mode === this.config.featureMode) &&
        !held.findingApiRecovery &&
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
        !held.findingApiRecovery &&
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
          !ticket.findingApiRecovery &&
          ticket.origin === "factory" &&
          (!ticket.feature || ticket.feature.mode === this.config.featureMode) &&
          ticket.status === "reviewed" &&
          (state.version === 1 || !slots.activeFor(state, Number(id))) &&
          !["merged", "closed"].includes(ticket.merge?.status)
      )
      .sort(
        ([left, a], [right, b]) =>
          Number(Boolean(a.feature)) - Number(Boolean(b.feature)) || Number(left) - Number(right)
      )[0];
    if (pending && !pending[1].feature)
      return {
        ready: false,
        preview: dryRun,
        kind: "merge",
        ticket: Number(pending[0]),
        reason: "Reconcile the pending automatic PR before admitting new work",
      };

    const turn = turns.priority(state, this.config);
    let candidate;
    if (turn) {
      if (slots.usedCapacity(state))
        return { ready: false, preview: dryRun, reason: turns.WAITING };
      const incident = await productionIncident(this.api);
      if (incident) {
        if (!state.tickets[String(incident.issue)] && incident.issue) {
          const issue = await this.api.request("GET", `${ROOT}/issues/${incident.issue}`);
          if (queueIssue(issue) && (await verifyMonitorIssue(this.api, issue))) candidate = issue;
        } else if (incident.issue) {
          const due = await this.delayedCandidate(state, { ticketNumber: incident.issue });
          if (due)
            return dryRun
              ? { ready: false, preview: true, ticket: due.number, delayedRetry: true }
              : this.reserveDelayed(due, state, commit);
        }
      } else if (turn.ticket) {
        const feature = await readyFeature(this.api, state, this.config.featureMode);
        if (feature?.number === turn.ticket) {
          if (
            !this.context.wake ||
            require("./trusted-wake.cjs").allowedModelBots(this.context, {
              origin: "factory",
              automatic: true,
            })
          )
            candidate = feature;
        } else if (!dryRun) {
          await this.ledger.update((current) => {
            turns.update(current, turn.runId, { status: "finished" });
            return { state: current };
          });
          return { ready: false, reason: "Scheduled feature is no longer ready" };
        }
      }
      if (!candidate) return { ready: false, preview: dryRun, reason: turns.WAITING };
    } else {
      candidate = await this.candidate(state);
    }
    if (!candidate) {
      let due = await this.delayedCandidate(state);
      if (
        !due &&
        ["pilot", "live"].includes(this.config.featureMode) &&
        !(await repairsWaiting(this.api, this.config, this.context, state))
      ) {
        if (pending?.[1].feature)
          return {
            ready: false,
            preview: dryRun,
            kind: "merge",
            ticket: Number(pending[0]),
            reason: "Reconcile the reviewed feature while the repair queue is clear",
          };
        due = await this.delayedCandidate(state, { feature: true });
        if (!due) candidate = await readyFeature(this.api, state, this.config.featureMode);
      }
      if (due) {
        if (dryRun)
          return {
            ready: false,
            preview: true,
            kind: "ticket",
            ticket: due.number,
            delayedRetry: true,
            reason: `Preview only; issue #${due.number} is eligible for one delayed retry`,
          };
        return this.reserveDelayed(due, state, commit);
      }
      let recovery;
      if (!candidate) {
        recovery = await require("./published-review-recovery.cjs").resumePublishedReview(
          this,
          state,
          commit,
          dryRun
        );
        if (recovery?.ready || recovery?.preview) return recovery;
        if (recovery && !dryRun) {
          if (summaryPath) require("node:fs").appendFileSync(summaryPath, `\n${recovery.reason}\n`);
          ({ state, commit } = await this.ledger.read());
        }
      }
      if (!candidate) {
        const known = await blocked.knownBlockedRetry(this, state);
        if (known) {
          if (dryRun)
            return {
              ready: false,
              preview: true,
              kind: "ticket",
              ticket: known.issue.number,
              delayedRetry: true,
              reason: `Preview only; issue #${known.issue.number} is eligible for one delayed retry`,
            };
          return this.reserveDelayed(known.issue, state, commit, known.receipt);
        }
      }
      if (!candidate)
        return (
          recovery ?? {
            ready: false,
            preview: dryRun,
            reason: "No eligible issue in the bounded queue",
          }
        );
    }
    if (dryRun)
      return {
        ready: false,
        preview: true,
        kind: "ticket",
        ticket: candidate.number,
        reason: this.config.priorityRetry
          ? `Preview only; issue #${candidate.number} would be selected`
          : "Preview only; no reservation, model session or merge",
      };
    try {
      const result = await this.controller.admit(candidate.number);
      return { ...result, kind: "ticket" };
    } catch (error) {
      if (turn?.ticket === candidate.number && error.message === turns.TESTED_MAIN) {
        await this.ledger.update((current) => {
          turns.update(current, turn.runId, {
            retryAt: turns.retryTime(new Date()),
            attemptAt: null,
          });
          return { state: current };
        });
        return { ready: false, reason: turns.TESTED_MAIN };
      }
      if (
        error.message === turns.WAITING ||
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
  const mode = inputs.operation || "run";
  const findingHandoff = [
    "retry-finding",
    "continue-finding",
    "recover-finding",
    "retry-finding-api",
  ].includes(mode);
  const blockedHandoff = mode === "queue-blocked-retry";
  if (blockedHandoff && inputs.wake_id) throw Error("Blocked retry cannot use an event wake");
  const readOnlyPreview =
    dryRun &&
    (config.priorityRetry || (operation === "auto_pick" && (findingHandoff || blockedHandoff)));
  const api = new GitHub({
    token: env.GH_TOKEN,
    retryReads: operation === "auto_pick" && findingHandoff,
  });
  const context = await require("./trusted-wake.cjs").loadWakeContext(
    api,
    runtimeContext(env),
    env,
    { bind: operation === "auto_pick" && !readOnlyPreview }
  );
  assertAutomaticContext(context);
  let result;
  if (operation === "auto_pick") {
    if (blockedHandoff) {
      result = await blocked.queueBlockedRetry(new AutomaticCoordinator(api, config, context), {
        ticket: Number(inputs.ticket),
        fixPr: Number(inputs.fix_pr),
        dryRun,
      });
    } else if (findingHandoff) {
      if (inputs.wake_id) throw Error("Finding retry cannot use an event wake");
      result = await require("./finding-retry.cjs").retryFinding(api, config, context, {
        ticket: Number(inputs.ticket),
        dryRun,
        ...(mode === "continue-finding" ? { continuation: true } : {}),
        ...(mode === "recover-finding" ? { outputRecovery: true } : {}),
        ...(mode === "retry-finding-api" ? { apiRecovery: true } : {}),
      });
    } else {
      if (mode !== "run") throw Error("Invalid automatic operation");
      result = await new AutomaticCoordinator(api, config, context).pick({
        dryRun,
        summaryPath: env.GITHUB_STEP_SUMMARY,
      });
    }
  } else {
    const { AutomaticMerger } = require("./merge.cjs");
    result = await new AutomaticMerger(api, config, context).merge(Number(inputs.ticket), {
      dryRun,
    });
  }
  if (!readOnlyPreview) await require("./activity.cjs").recordResult(api, context, result, env);
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
