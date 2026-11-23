const fs = require("node:fs");
const p = require("./policy.cjs");
const c = require("./feature-contract.cjs");
const meter = require("./feature-meter.cjs");
const planner = require("./feature-planner.cjs");
const { GitHub, Ledger, ROOT } = require("./github.cjs");
const slots = require("./active-tickets.cjs");
const { runtimeContext, output } = require("./controller.cjs");
const { testedMain } = require("./discovery-run.cjs");
const { repairsWaiting } = require("./feature-priority.cjs");
const { storeFor, nextPart, publishPart, stageTicket } = require("./feature-publication.cjs");
const { secretLike } = require("./artifacts.cjs");

class FeatureHold extends Error {}

async function verifyRun(api, context) {
  meter.assertContext(context);
  const run = await api.request("GET", ROOT + "/actions/runs/" + context.runId + "/attempts/1");
  if (
    run.id !== Number(context.runId) ||
    run.run_attempt !== 1 ||
    run.path !== c.WORKFLOW ||
    run.head_branch !== "main" ||
    run.head_sha !== context.workflowSha ||
    run.actor?.login !== p.OWNER ||
    (run.triggering_actor && run.triggering_actor.login !== p.OWNER) ||
    run.repository?.full_name !== p.REPOSITORY ||
    run.head_repository?.full_name !== p.REPOSITORY ||
    run.event !== context.event ||
    run.status !== "in_progress"
  )
    throw Error("Weekly feature workflow identity mismatch");
}
async function issues(api) {
  const collected = [];
  for (let page = 1; page <= 5; page++) {
    const rows = await api.request("GET", ROOT + "/issues?state=open&per_page=100&page=" + page);
    if (!Array.isArray(rows) || rows.length > 100) throw Error("Invalid feature issue inventory");
    collected.push(...rows.filter((row) => !row.pull_request && typeof row.title === "string"));
    if (rows.length < 100) return collected;
  }
  throw new FeatureHold("Open issue inventory exceeds the safe feature lookup");
}

async function featureCounts(api, state, ledger, week) {
  const planned = { major: 0, minor: 0 };
  const merged = { major: 0, minor: 0 };
  const deployed = { major: 0, minor: 0 };
  for (const [key, row] of Object.entries(state.records)) {
    if (row.week !== week) continue;
    planned[row.proposal.size]++;
    if (
      !row.stages.every(
        (_, index) => stageTicket(ledger, key, row, index)?.merge?.status === "merged"
      )
    )
      continue;
    merged[row.proposal.size]++;
    const index = row.parent ? -1 : 0;
    const number = row.parent?.issue || row.stages[0].issue;
    const issue = await api.request("GET", ROOT + "/issues/" + number);
    if (
      c.issueMatches(issue, key, row, index, index === 0, true) &&
      issue.state === "closed" &&
      issue.state_reason === "completed" &&
      issue.closed_by?.id === c.BOT.id
    )
      deployed[row.proposal.size]++;
  }
  return { planned, merged, deployed };
}

async function main(env = process.env, dependencies = {}) {
  const now = dependencies.now || (() => new Date());
  const context = runtimeContext(env);
  meter.assertContext(context);
  p.assertSubscriptionEnv(env);
  if (env.CLAUDE_CODE_OAUTH_TOKEN)
    throw Error("Unexpected Claude credential outside planner action");
  const config = p.readConfig(JSON.parse(env.FACTORY_VARIABLES || "{}"));
  const input = JSON.parse(env.FACTORY_INPUTS || "{}");
  const operation = env.FACTORY_OPERATION;
  const mode = config.featureMode;
  const api = dependencies.api || new GitHub({ token: env.GH_TOKEN, retryReads: true });
  const ledger = dependencies.ledger || new Ledger(api);
  const store = dependencies.store || storeFor(api);
  const week = c.weekKey(now());
  const readStore = () => store.read({ allowMissing: true });
  const result = (values) => {
    output(values, env);
    return values;
  };
  const beforeWrite = async () => {
    const main = await api.request("GET", ROOT + "/branches/main");
    if (main.commit?.sha !== context.workflowSha || c.weekKey(now()) !== week)
      throw new FeatureHold("Main or the Bucharest week changed; use a fresh run");
    const { state } = await ledger.read();
    if (state.stop) throw new FeatureHold("Durable stop active");
    if (
      slots.activeEntries(state).length ||
      (operation !== "prepare" && slots.reservedPlanners(state).length) ||
      (await repairsWaiting(api, config, context, state))
    )
      throw new FeatureHold("Repairs or other active work take priority");
    if (
      p.dailyAdmissions(state, p.dayKey(now(), c.TIMEZONE)) >= config.daily &&
      operation !== "prepare"
    )
      throw new FeatureHold("Daily ticket limit reached");
    if (!meter.headroom(api.primaryQuota, now()))
      throw new FeatureHold("GitHub API headroom not available");
    return state;
  };
  const savePlan = async (proposals, head, mode, planWeek, openIssues) => {
    const { state: registry } = await readStore();
    const accepted = await planner.filterPlan(
      api,
      proposals,
      registry,
      openIssues.map((x) => x.title),
      head
    );
    if (!accepted.length) return 0;
    const saved = await store.update(
      (state) => {
        if (c.digest(state) !== c.digest(registry)) throw Error("Feature plan inventory changed");
        const available = planner.availablePlan(accepted, state, planWeek);
        if (!available.length) return { state, count: 0, unchanged: true };
        for (const proposal of available) {
          const key = c.proposalKey(proposal);
          state.records[key] = {
            week: planWeek,
            producer: { mode, head, runId: context.runId },
            proposal,
            parent: null,
            stages: proposal.steps.map(() => null),
          };
        }
        return { state, count: available.length };
      },
      { allowMissing: true }
    );
    return saved.count;
  };

  if (operation === "preview") {
    if (context.event !== "workflow_dispatch" || input.operation !== "preview")
      throw Error("Preview requires explicit read-only dispatch");
    const [{ state }, { state: registry }] = await Promise.all([ledger.read(), readStore()]);
    const pilot = planner.PILOT;
    const counts = await featureCounts(api, registry, state, week);
    if (env.GITHUB_STEP_SUMMARY)
      fs.appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        [
          "## Weekly feature preview",
          "",
          "Bucharest week " + week,
          "Configured mode " + mode,
          "Pilot proposal " + pilot.title,
          "Planned major / minor " + counts.planned.major + " / " + counts.planned.minor,
          "Merged major / minor " + counts.merged.major + " / " + counts.merged.minor,
          "Deployed major / minor " + counts.deployed.major + " / " + counts.deployed.minor,
          state.stop ? "Durable stop active." : "No model reservation or GitHub write requested.",
          "",
        ].join("\n")
      );
    return result({ ready: false, preview: true, modelCalls: 0 });
  }

  if (!["select", "prepare", "finish"].includes(operation))
    throw Error("Unknown weekly feature operation");
  if (
    operation !== "finish" &&
    (!config.enabled ||
      !config.automatic ||
      (mode === "pilot"
        ? operation !== "select" ||
          context.event !== "workflow_dispatch" ||
          input.operation !== "pilot"
        : mode !== "live" ||
          (operation === "select" &&
            context.event === "workflow_dispatch" &&
            input.operation !== "run")))
  )
    return result({ ready: false, reason: "Weekly feature mode disabled for this operation" });
  await verifyRun(api, context);

  if (operation === "finish") {
    let outcome = "blocked";
    let accepted = 0;
    try {
      const { state } = await ledger.read();
      const grant = meter.preflight(state, context, config, input.grant, now());
      if (
        env.FACTORY_MODEL_SUCCESS !== "true" ||
        typeof env.FACTORY_MODEL_RESULT !== "string" ||
        env.FACTORY_MODEL_RESULT.length > 20000 ||
        secretLike(env.FACTORY_MODEL_RESULT)
      )
        throw new FeatureHold("Planner result unavailable");
      const value = JSON.parse(env.FACTORY_MODEL_RESULT);
      if (!c.exact(value, "proposals")) throw Error("Invalid planner artifact");
      const { head } = await testedMain(api, context, {});
      const openIssues = await issues(api);
      p.assertNotStopped((await ledger.read()).state);
      if (!meter.headroom(api.primaryQuota, now()))
        throw new FeatureHold("GitHub API headroom not available");
      accepted = await savePlan(
        value.proposals,
        head,
        mode,
        c.weekKey(new Date(grant.at)),
        openIssues
      );
      outcome = "accepted";
    } catch {
      // Output and errors can contain model or source text. Keep only a fixed status.
    }
    await ledger.update((state) => ({
      state: meter.finish(state, context, input.grant, outcome, now()),
    }));
    return result({ ready: false, accepted, reason: "Weekly planner finished " + outcome });
  }

  try {
    if (operation === "select") {
      const loaded = await ledger.read();
      if (!loaded.state.stop) await meter.reconcile(api, ledger, loaded);
    }
    const { head } = await testedMain(api, context, {});
    const state = await beforeWrite();
    if (operation === "prepare") {
      meter.preflight(state, context, config, input.grant, now());
      const [openIssues, { state: registry }] = await Promise.all([issues(api), readStore()]);
      const feedback = openIssues
        .filter((issue) => issue.user?.id === 101267861 && !c.marked(issue))
        .slice(0, 20)
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          body: String(issue.body || "").slice(0, 500),
        }))
        .filter((issue) => !secretLike(issue.title + issue.body));
      const product = planner.productSnapshot(head, week, env.GITHUB_WORKSPACE);
      await beforeWrite();
      return result({
        ready: true,
        promptJson: JSON.stringify(
          planner.prompt({
            week,
            product,
            issues: {
              openTitles: openIssues
                .map((issue) => issue.title)
                .filter((title) => !secretLike(title))
                .slice(0, 200),
              feedback,
            },
            previous: Object.values(registry.records)
              .slice(-30)
              .map((row) => row.proposal.title),
          })
        ),
        claudeArgs: planner.modelArgs(config),
      });
    }

    let { state: registry } = await readStore();
    if (
      mode === "pilot" &&
      !Object.values(registry.records).some((row) => row.producer.mode === "pilot")
    ) {
      const openIssues = await issues(api);
      await beforeWrite();
      await savePlan([planner.PILOT], head, mode, week, openIssues);
      registry = (await readStore()).state;
    }
    const authorized = {
      ...registry,
      records: Object.fromEntries(
        Object.entries(registry.records).filter(
          ([, row]) =>
            row.producer.mode === "pilot" ||
            (state.featurePlans?.[row.week]?.status === "accepted" &&
              state.featurePlans[row.week].runId === row.producer.runId &&
              state.featurePlans[row.week].head === row.producer.head)
        )
      ),
    };
    const part = await nextPart(api, state, authorized, week, mode);
    if (part) {
      const publication = await publishPart({ api, store, beforeWrite }, part);
      return result({
        ready: false,
        issue: publication.issue,
        reason: "Feature publication advanced " + publication.phase,
      });
    }
    if (mode !== "live" || state.featurePlans?.[week])
      return result({
        ready: false,
        reason: "No feature publication ready and no new planning turn",
      });
    const saved = await ledger.update(async (current) => {
      await beforeWrite();
      return meter.reserve(current, context, config, now());
    });
    return result({ ready: true, grant: saved.grant.id });
  } catch (error) {
    if (!(error instanceof FeatureHold)) throw error;
    return result({ ready: false, reason: error.message });
  }
}

if (require.main === module)
  main().catch(() => {
    console.error(
      "Weekly feature workflow held. Check the stop, quota, repair queue and publication receipts."
    );
    process.exitCode = 1;
  });

module.exports = { main };
