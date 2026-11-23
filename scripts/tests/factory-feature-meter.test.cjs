const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../factory/policy.cjs");
const m = require("../factory/feature-meter.cjs");
const c = require("../factory/feature-contract.cjs");

const config = {
  enabled: true,
  automatic: true,
  featureMode: "live",
  daily: 5,
  minutes: 10,
  turns: 20,
};
const context = {
  repository: p.REPOSITORY,
  ref: "refs/heads/main",
  workflowRef: p.REPOSITORY + "/" + c.WORKFLOW + "@refs/heads/main",
  workflowSha: "a".repeat(40),
  actor: p.OWNER,
  triggeringActor: p.OWNER,
  event: "schedule",
  runId: "278",
  runAttempt: 1,
};
const now = new Date("2026-11-23T00:20:00Z");

test("a finished or blocked planner consumes one Bucharest weekly reservation and the daily budget", () => {
  const initial = p.emptyState(p.REPOSITORY);
  const { state, grant } = m.reserve(initial, context, config, now);
  assert.deepEqual(initial, p.emptyState(p.REPOSITORY));
  assert.equal(p.dailyAdmissions(state, "2026-11-23"), 1);
  assert.equal(m.preflight(state, context, config, grant.id, now).id, grant.id);
  const saved = m.finish(state, context, grant.id, "blocked", now);
  assert.equal(p.validateState(saved), saved);
  assert.throws(() => m.reserve(saved, { ...context, runId: "279" }, config, now), /week/i);
  assert.throws(() => m.preflight(saved, context, config, grant.id, now), /reservation/i);
});

test("planner admission requires an authorized first attempt, enabled subscription limits and room", () => {
  const state = p.emptyState(p.REPOSITORY);
  assert.throws(() => m.reserve(state, { ...context, actor: "other" }, config, now), /identity/i);
  assert.throws(() => m.reserve(state, { ...context, runAttempt: 2 }, config, now), /identity/i);
  assert.throws(
    () => m.reserve(state, context, { ...config, featureMode: "pilot" }, now),
    /disabled/i
  );
  assert.throws(() => m.reserve(state, context, { ...config, daily: 0 }, now), /daily/i);
});

test("discretionary work keeps a quarter of observed quota and defers near a reset", () => {
  const rate = { limit: 1000, remaining: 250, reset: now.getTime() + 120000 };
  assert.equal(m.headroom(rate, now), true);
  assert.equal(m.headroom({ ...rate, remaining: 249 }, now), false);
  assert.equal(m.headroom({ ...rate, reset: now.getTime() + 60000 }, now), false);
  assert.equal(m.headroom(undefined, now), false);
});
test("weekly planning owns model capacity until the first attempt is proven terminal", async () => {
  const slots = require("../factory/active-tickets.cjs");
  const initial = p.emptyState(p.REPOSITORY);
  const { state } = m.reserve(initial, context, config, now);
  assert.equal(slots.capacity(state, 1), false);
  const ledger = {
    saved: state,
    update: async (fn) => {
      ledger.saved = (await fn(ledger.saved)).state;
    },
    read: async () => ({ state: ledger.saved }),
  };
  const run = {
    id: Number(context.runId),
    run_attempt: 1,
    path: c.WORKFLOW,
    head_sha: context.workflowSha,
    head_branch: "main",
    repository: { full_name: context.repository },
    head_repository: { full_name: context.repository },
    actor: { login: p.OWNER },
    event: "schedule",
    status: "in_progress",
  };
  const api = { request: async () => run };
  await m.reconcile(api, ledger, await ledger.read());
  assert.equal(slots.capacity(ledger.saved, 1), false);
  run.status = "completed";
  await m.reconcile(api, ledger, await ledger.read());
  assert.equal(slots.capacity(ledger.saved, 1), true);
  assert.equal(p.dailyAdmissions(ledger.saved, "2026-11-23"), 1);
});
test("a disabled mode can settle a previously reserved planner without running it", async () => {
  const { main } = require("../factory/feature-run.cjs");
  const { vars } = require("./helpers/factory-fixtures.cjs");
  const { state, grant } = m.reserve(p.emptyState(p.REPOSITORY), context, config, now);
  let stored = state;
  const ledger = {
    read: async () => ({ state: stored }),
    update: async (fn) => {
      stored = (await fn(stored)).state;
    },
  };
  const api = {
    request: async () => ({
      id: Number(context.runId),
      run_attempt: 1,
      path: c.WORKFLOW,
      head_sha: context.workflowSha,
      head_branch: "main",
      repository: { full_name: context.repository },
      head_repository: { full_name: context.repository },
      actor: { login: p.OWNER },
      event: "schedule",
      status: "in_progress",
    }),
  };
  const env = {
    GITHUB_REPOSITORY: context.repository,
    GITHUB_REF: context.ref,
    GITHUB_WORKFLOW_REF: context.workflowRef,
    GITHUB_WORKFLOW_SHA: context.workflowSha,
    GITHUB_ACTOR: p.OWNER,
    GITHUB_EVENT_NAME: context.event,
    GITHUB_RUN_ID: context.runId,
    GITHUB_RUN_ATTEMPT: "1",
    FACTORY_OPERATION: "finish",
    FACTORY_VARIABLES: JSON.stringify({ ...vars, FACTORY_FEATURE_MODE: "off" }),
    FACTORY_INPUTS: JSON.stringify({ grant: grant.id }),
  };
  await main(env, { api, ledger, store: {}, now: () => now });
  assert.equal(stored.featurePlans["2026-11-23"].status, "blocked");
  assert.equal(p.dailyAdmissions(stored, "2026-11-23"), 1);
});
