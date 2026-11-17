const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../factory/policy.cjs");
const { context, vars } = require("./helpers/factory-fixtures.cjs");
const now = new Date("2026-11-17T10:00:00Z");
const config = () => ({ ...policy.readConfig(vars), daily: 20, concurrent: 2 });
function v2() {
  const state = policy.emptyState(policy.REPOSITORY);
  state.version = 2;
  delete state.active;
  state.activeTickets = {};
  return state;
}
function request(ticket, runId = String(ticket + 100)) {
  return { ...context, ticket, runId };
}

test("two distinct v2 claims fit; third claim is rejected without changing history", () => {
  const first = policy.reserve(v2(), request(10), config(), now);
  const second = policy.reserve(first.state, request(11), config(), now);
  assert.equal(Object.keys(second.state.activeTickets).length, 2);
  assert.deepEqual(second.state.days["2026-11-17"], [10, 11]);
  assert.equal(policy.validateState(second.state), second.state);
  const before = structuredClone(second.state);
  assert.throws(
    () => policy.reserve(second.state, request(12), config(), now),
    /active|capacity|lock/i
  );
  assert.deepEqual(second.state, before);
});
test("v1 remains capacity one and refuses premature concurrency two", () => {
  const cfg = policy.readConfig(vars);
  const first = policy.reserve(policy.emptyState(policy.REPOSITORY), request(10), cfg, now);
  assert.throws(() => policy.reserve(first.state, request(11), cfg, now), /active|lock/i);
  assert.throws(
    () => policy.reserve(policy.emptyState(policy.REPOSITORY), request(10), config(), now),
    /migrat|version/i
  );
});
test("configuration accepts two but rejects zero and three", () => {
  assert.equal(policy.readConfig({ ...vars, FACTORY_MAX_CONCURRENT_TICKETS: "2" }).concurrent, 2);
  for (const value of ["0", "3"])
    assert.throws(() => policy.readConfig({ ...vars, FACTORY_MAX_CONCURRENT_TICKETS: value }));
});
test("lowering concurrency refuses starting a pending model above the current cap", () => {
  const a = policy.reserve(v2(), request(10), config(), now);
  const b = policy.reserve(a.state, request(11), config(), now);
  assert.throws(
    () => policy.preflight(b.state, b.grant.id, request(11), { ...config(), concurrent: 1 }),
    /limit|capacity/i
  );
});
test("CAS retries admit at most two of three concurrent parents", async () => {
  const api = new GitHub({ token: "fixture-only", fetch: new GitHubFixture().fetch });
  const ledger = new Ledger(api);
  await ledger.initialize();
  await ledger.update(() => ({ state: v2() }));
  const results = await Promise.allSettled(
    [10, 11, 12].map((ticket) =>
      ledger.update((state) => policy.reserve(state, request(ticket), config(), now))
    )
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  const { state } = await ledger.read();
  assert.equal(Object.keys(state.activeTickets).length, 2);
  assert.equal(Object.keys(state.grants).length, 2);
  assert.equal(state.days["2026-11-17"].length, 2);
});
test("automatic review keeps its v2 execution slot until merge; owner review hands off", () => {
  const cfg = appConfig();
  const ctx = {
    ...request(10),
    event: "schedule",
    workflowRef: policy.AUTOMATIC_WORKFLOW_REF,
    workflowSha: context.head,
  };
  const coding = policy.reserve(v2(), ctx, cfg, now);
  coding.state.tickets[10].automatic = {
    workflowRef: ctx.workflowRef,
    workflowSha: ctx.workflowSha,
    runId: ctx.runId,
    runAttempt: ctx.runAttempt,
    appSlug: cfg.appSlug,
  };
  const published = policy.finish(coding.state, coding.grant.id, {
    status: "awaiting_review",
    pr: 30,
  });
  const review = policy.reserve(published, { ...ctx, phase: "review" }, cfg, now);
  const reviewed = policy.finish(review.state, review.grant.id, {
    status: "reviewed",
    verdict: "pass",
    head: ctx.head,
    pr: 30,
    evidence: `https://github.com/${policy.REPOSITORY}/actions/runs/${ctx.runId}`,
  });
  assert.equal(reviewed.activeTickets[10].runId, ctx.runId);
  const owner = policy.reserve(
    reviewed,
    { ...request(11), phase: "review", origin: "owner-pr", pr: 31 },
    cfg,
    now
  );
  const done = policy.finish(owner.state, owner.grant.id, {
    status: "reviewed",
    verdict: "pass",
    head: ctx.head,
    pr: 31,
    evidence: `https://github.com/${policy.REPOSITORY}/actions/runs/${owner.grant.runId}`,
  });
  assert.deepEqual(Object.keys(done.activeTickets), ["10"]);
});
test("duplicate ticket cannot claim twice, including same parent phase overlap", () => {
  const first = policy.reserve(v2(), request(10), config(), now);
  assert.throws(
    () => policy.reserve(first.state, request(10, "999"), config(), now),
    /active|lock/i
  );
  assert.throws(() => policy.reserve(first.state, request(10), config(), now), /unfinished/i);
});
test("release A preserves B and its preflight reservation", () => {
  const a = policy.reserve(v2(), request(10), config(), now);
  const b = policy.reserve(a.state, request(11), config(), now);
  const state = policy.finish(b.state, a.grant.id, { status: "blocked" }, now);
  assert.deepEqual(Object.keys(state.activeTickets), ["11"]);
  assert.equal(state.grants[b.grant.id].status, "reserved");
  assert.equal(policy.preflight(state, b.grant.id, request(11), config()).id, b.grant.id);
  assert.equal(policy.validateState(state), state);
});
test("mixed schemas and malformed owner entries are rejected", () => {
  const first = policy.reserve(v2(), request(10), config(), now);
  for (const change of [
    (s) => {
      s.active = null;
    },
    (s) => {
      s.activeTickets["11"] = s.activeTickets["10"];
    },
    (s) => {
      s.activeTickets["10"].runAttempt = 0;
    },
    (s) => {
      s.activeTickets["10"].extra = true;
    },
    (s) => {
      s.activeTickets = [];
    },
  ]) {
    const state = structuredClone(first.state);
    change(state);
    assert.throws(() => policy.validateState(state));
  }
});
test("two reserved phases for one ticket are rejected even with spare global capacity", () => {
  const first = policy.reserve(v2(), request(10), config(), now);
  const state = structuredClone(first.state);
  const duplicate = { ...first.grant, id: "other" };
  state.grants.other = duplicate;
  state.tickets["10"].coding++;
  state.tickets["10"].retries++;
  assert.throws(() => policy.validateState(state), /reservation/i);
});

const { Controller } = require("../factory/controller.cjs");
const dep = require("../factory/dependency-policy.cjs");
const depContract = require("../factory/dependency-contract.cjs");
const { AutomaticMerger } = require("../factory/merge.cjs");
const { GitHub, Ledger } = require("../factory/github.cjs");
const { GitHubFixture } = require("./helpers/factory-fixtures.cjs");
const appConfig = () => ({
  ...config(),
  automatic: true,
  autoMerge: true,
  appSlug: "factory-example",
});
const depContext = () => ({
  ...request(52, "152"),
  event: "schedule",
  workflowRef: depContract.WORKFLOW,
  workflowSha: context.head,
});
const depPR = () => ({
  number: 52,
  state: "open",
  draft: false,
  user: { login: "dependabot[bot]", type: "Bot", id: 49699333 },
  head: {
    sha: "b".repeat(40),
    ref: "dependabot/npm_and_yarn/foo-1.0.1",
    repo: { full_name: policy.REPOSITORY },
  },
  base: { ref: "main", sha: context.head, repo: { full_name: policy.REPOSITORY } },
});
test("app and dependency share two slots; finishing preparation preserves the app grant", () => {
  const app = policy.reserve(v2(), request(10), appConfig(), now);
  const state = dep.claimDependency(app.state, depPR(), depContext(), appConfig(), now);
  assert.equal(Object.keys(state.activeTickets).length, 2);
  assert.equal(state.tickets[52].reviews, 0);
  assert.throws(
    () => policy.reserve(state, request(12), appConfig(), now),
    /active|capacity|lock/i
  );
  const done = dep.finishPreparation(state, 52, depContext());
  assert.deepEqual(Object.keys(done.activeTickets), ["10"]);
  assert.equal(done.grants[app.grant.id].status, "reserved");
});
test("controller block for A preserves B in the persisted ledger", async () => {
  const api = new GitHub({ token: "fixture-only", fetch: new GitHubFixture().fetch });
  const ledger = new Ledger(api);
  await ledger.initialize();
  const a = policy.reserve(v2(), request(10), config(), now);
  const b = policy.reserve(a.state, request(11), config(), now);
  await ledger.update(() => ({ state: b.state }));
  await new Controller(api, config(), request(10)).block(10, "Fixture stop A");
  const { state } = await ledger.read();
  assert.deepEqual(Object.keys(state.activeTickets), ["11"]);
  assert.equal(state.grants[b.grant.id].status, "reserved");
});
test("cancellation requires explicit ticket with two parents and leaves B untouched", async () => {
  let state = policy.reserve(v2(), request(10), config(), now).state;
  state = policy.reserve(state, request(11), config(), now).state;
  const calls = [];
  const api = {
    request: async (_m, route) => {
      calls.push(route);
      return { status: "completed" };
    },
  };
  const controller = new Controller(api, config(), request(99, "999"));
  controller.ledger = {
    read: async () => ({ state: structuredClone(state) }),
    update: async (fn) => {
      const result = await fn(structuredClone(state));
      state = policy.validateState(result.state);
      return result;
    },
  };
  await assert.rejects(controller.cancel(), /ticket|ambiguous/i);
  await controller.cancel(10);
  assert.deepEqual(Object.keys(state.activeTickets), ["11"]);
  assert.ok(calls.every((route) => route.includes("/110")));
});
test("merge ownership ignores B's reservation but never ignores another merge intent", () => {
  const state = policy.reserve(v2(), request(10), config(), now).state;
  const second = policy.reserve(state, request(11), config(), now).state;
  const intent = { status: "intent", runId: "110", runAttempt: 1 };
  second.grants[Object.keys(second.grants)[0]].status = "finished";
  const merger = new AutomaticMerger({}, appConfig(), request(10));
  assert.equal(merger.mergeLock(second, 10, intent), true);
});
test("worker workflow groups allow distinct runs while merge jobs share one writer", () => {
  const fs = require("node:fs");
  for (const name of ["automatic", "dependencies"]) {
    const text = fs.readFileSync(
      require("node:path").join(__dirname, `../../.github/workflows/factory-${name}.yml`),
      "utf8"
    );
    assert.match(text, /group: factory-(?:automatic|dependencies)-\$\{\{ github.run_id \}\}/);
    assert.match(text, /group: factory-auto-merge/);
    assert.match(text, /group: factory-ledger/);
    assert.match(text, /cancel-in-progress: false/);
  }
});
