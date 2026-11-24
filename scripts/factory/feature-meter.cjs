const { randomUUID } = require("node:crypto");
const p = require("./policy.cjs");
const c = require("./feature-contract.cjs");
const slots = require("./active-tickets.cjs");

const UUID = /^[0-9a-f-]{36}$/;
const REF = p.REPOSITORY + "/" + c.WORKFLOW + "@refs/heads/main";
function assertContext(context) {
  const owner = context.actor === p.OWNER && context.triggeringActor === p.OWNER;
  const trusted =
    (owner && ["workflow_dispatch", "schedule"].includes(context.event)) ||
    (context.event === "workflow_run" && require("./feature-trigger.cjs").isContinuation(context));
  if (
    context.repository !== p.REPOSITORY ||
    context.ref !== "refs/heads/main" ||
    context.workflowRef !== REF ||
    !p.SHA.test(context.workflowSha || "") ||
    !trusted ||
    !c.RUN.test(context.runId || "") ||
    context.runAttempt !== 1
  )
    throw Error("Untrusted weekly planner identity");
}
function validate(plans) {
  if (plans === undefined) return;
  if (
    !plans ||
    typeof plans !== "object" ||
    Array.isArray(plans) ||
    Object.keys(plans).length > 260
  )
    throw Error("Invalid planner ledger");
  if (Object.values(plans).filter((grant) => grant?.status === "reserved").length > 1)
    throw Error("Multiple active weekly planner reservations");
  const ids = new Set();
  const runs = new Set();
  for (const [week, grant] of Object.entries(plans)) {
    const now = new Date(grant?.at);
    if (
      !c.exact(grant, "id,head,runId,at,status") ||
      !UUID.test(grant.id || "") ||
      !c.producerOK({ mode: "live", head: grant.head, runId: grant.runId }) ||
      !Number.isFinite(now.getTime()) ||
      now.toISOString() !== grant.at ||
      c.weekKey(now) !== week ||
      !["reserved", "accepted", "blocked"].includes(grant.status) ||
      ids.has(grant.id) ||
      runs.has(grant.runId)
    )
      throw Error("Invalid weekly planner reservation");
    ids.add(grant.id);
    runs.add(grant.runId);
  }
}
function authorize(state, context, config) {
  assertContext(context);
  p.assertNotStopped(state);
  if (
    !config.enabled ||
    !config.automatic ||
    config.featureMode !== "live" ||
    !config.minutes ||
    !config.turns
  )
    throw Error("Weekly Claude planning disabled");
}
function reserve(original, context, config, now = new Date()) {
  authorize(original, context, config);
  const week = c.weekKey(now);
  const state = structuredClone(original);
  state.featurePlans ??= {};
  if (
    state.featurePlans[week] ||
    Object.values(state.featurePlans).some((g) => g.runId === context.runId)
  )
    throw Error("A planner reservation already consumed this week or run");
  if (p.dailyAdmissions(state, p.dayKey(now, c.TIMEZONE)) >= config.daily)
    throw Error("Daily ticket limit reached");
  if (slots.usedCapacity(state)) throw Error("Active execution holds planner capacity");
  const grant = {
    id: randomUUID(),
    head: context.workflowSha,
    runId: context.runId,
    at: now.toISOString(),
    status: "reserved",
  };
  state.featurePlans[week] = grant;
  p.audit(state, "weekly_planner_reserved", { week, runId: grant.runId, grant: grant.id }, now);
  p.validateState(state);
  return { state, grant };
}
function preflight(state, context, config, id, now = new Date()) {
  authorize(state, context, config);
  const grant = state.featurePlans?.[c.weekKey(now)];
  if (
    !grant ||
    grant.id !== id ||
    grant.status !== "reserved" ||
    grant.head !== context.workflowSha ||
    grant.runId !== context.runId
  )
    throw Error("Stale weekly planner reservation");
  if (p.dailyAdmissions(state, p.dayKey(new Date(grant.at), c.TIMEZONE)) > config.daily)
    throw Error("Changed daily planner limit");
  return grant;
}
function finish(original, context, id, status, now = new Date()) {
  assertContext(context);
  if (!["accepted", "blocked"].includes(status)) throw Error("Invalid planner outcome");
  if (status === "accepted") p.assertNotStopped(original);
  const state = structuredClone(original);
  const grant = Object.values(state.featurePlans || {}).find(
    (g) => g.id === id && g.runId === context.runId && g.head === context.workflowSha
  );
  if (!grant || grant.status !== "reserved") throw Error("Stale weekly planner reservation");
  grant.status = status;
  p.audit(state, "weekly_planner_finished", { runId: grant.runId, grant: id, status }, now);
  return p.validateState(state);
}

async function terminalPlanner(api, grant) {
  const { ROOT } = require("./github.cjs");
  const run = await api.request("GET", ROOT + "/actions/runs/" + grant.runId + "/attempts/1");
  if (
    run.id !== Number(grant.runId) ||
    run.run_attempt !== 1 ||
    run.path !== c.WORKFLOW ||
    run.head_sha !== grant.head ||
    run.head_branch !== "main" ||
    run.repository?.full_name !== p.REPOSITORY ||
    run.head_repository?.full_name !== p.REPOSITORY ||
    (run.event === "workflow_run"
      ? !require("./feature-trigger.cjs").validActor(run)
      : run.actor?.login !== p.OWNER || !["workflow_dispatch", "schedule"].includes(run.event))
  )
    throw Error("Reserved planner identity changed");
  return run.status === "completed";
}
async function reconcile(api, ledger, loaded) {
  const [grant] = slots.reservedPlanners(loaded.state);
  if (!grant || !(await terminalPlanner(api, grant))) return loaded;
  await ledger.update((state) => {
    const current = slots.reservedPlanners(state).find((entry) => entry.id === grant.id);
    if (current) {
      current.status = "blocked";
      p.audit(state, "weekly_planner_reconciled", { runId: current.runId, grant: current.id });
    }
    return { state };
  });
  return ledger.read();
}

function headroom(rate, now = new Date()) {
  return Boolean(
    Number.isSafeInteger(rate?.limit) &&
      rate.limit > 0 &&
      Number.isSafeInteger(rate.remaining) &&
      rate.remaining <= rate.limit &&
      rate.remaining >= Math.ceil(rate.limit / 4) &&
      Number.isSafeInteger(rate.reset) &&
      rate.reset - now.getTime() > 60000
  );
}

module.exports = {
  assertContext,
  validate,
  reserve,
  preflight,
  finish,
  headroom,
  terminalPlanner,
  reconcile,
};
