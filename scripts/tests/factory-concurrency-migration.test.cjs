const { reviewFeedback } = require("./helpers/factory-fixtures.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const policy = require("../factory/policy.cjs");
const { GitHub, Ledger } = require("../factory/github.cjs");
const { GitHubFixture, vars, context } = require("./helpers/factory-fixtures.cjs");
let migration;
try {
  migration = require("../factory/concurrency-migration.cjs");
} catch (e) {
  if (e.code !== "MODULE_NOT_FOUND") throw e;
}
const switches = {
  FACTORY_ENABLED: "false",
  FACTORY_AUTOMATION_ENABLED: "false",
  FACTORY_AUTOMERGE_ENABLED: "false",
};
async function fixture() {
  const transport = new GitHubFixture();
  const api = new GitHub({ token: "fixture-only", fetch: transport.fetch });
  const ledger = new Ledger(api);
  await ledger.initialize();
  let state = policy.reserve(
    policy.emptyState(policy.REPOSITORY),
    context,
    policy.readConfig(vars)
  ).state;
  const grant = Object.values(state.grants)[0];
  state = policy.finish(state, grant.id, { status: "blocked" });
  const review = policy.reserve(
    state,
    {
      ...context,
      ticket: 20,
      runId: "200",
      phase: "review",
      slot: "existing",
      origin: "owner-pr",
      pr: 90,
    },
    policy.readConfig(vars)
  );
  state = policy.finish(review.state, review.grant.id, {
    status: "reviewed",
    verdict: "pass",
    pr: 90,
    head: context.head,
    evidence: `https://github.com/${policy.REPOSITORY}/actions/runs/200`,
  });
  state.tickets["20"].feedback = reviewFeedback(context.head);
  state.stop = {
    id: randomUUID(),
    at: new Date().toISOString(),
    actor: policy.OWNER,
    reason: "Owner emergency stop",
    previous: { ...switches },
  };
  await ledger.update(() => ({ state }));
  const settings = { ...switches },
    runs = [],
    writes = [];
  const request = api.request.bind(api);
  api.request = async (method, route, body) => {
    if (method !== "GET") writes.push({ method, route, body });
    if (route.includes("/actions/variables"))
      return { variables: Object.entries(settings).map(([name, value]) => ({ name, value })) };
    if (route.includes("/actions/runs?")) return { workflow_runs: runs };
    return request(method, route, body);
  };
  const loaded = await ledger.read();
  return { api, ledger, state: loaded.state, commit: loaded.commit, settings, runs, writes };
}
test("migration preview is read-only and retains byte-equivalent history and approval", async () => {
  assert.ok(migration, "missing guarded migration implementation");
  const f = await fixture();
  const result = await migration.migrateConcurrency({ ...f, actor: policy.OWNER });
  assert.equal(result.preview, true);
  assert.equal(result.eligible, true);
  assert.equal(f.writes.length, 0);
  assert.equal((await f.ledger.read()).commit, f.commit);
});
test("migration requires expected commit and preserves counters, grants, approvals and old commit", async () => {
  assert.ok(migration);
  const f = await fixture();
  await assert.rejects(
    migration.migrateConcurrency({ ...f, actor: policy.OWNER, execute: true }),
    /expected|commit/i
  );
  const result = await migration.migrateConcurrency({
    ...f,
    actor: policy.OWNER,
    execute: true,
    expectedCommit: f.commit,
  });
  const { state, commit } = await f.ledger.read();
  assert.equal(state.version, 2);
  assert.deepEqual(state.activeTickets, {});
  assert.equal(Object.hasOwn(state, "active"), false);
  for (const key of ["tickets", "grants", "days", "stop"])
    assert.deepEqual(state[key], f.state[key]);
  assert.deepEqual(state.audit.slice(0, -1), f.state.audit);
  assert.equal(state.audit.at(-1).event, "factory-concurrency-migrated");
  assert.equal(state.audit.at(-1).previousCommit, f.commit);
  assert.equal(result.commit, commit);
  assert.notEqual(commit, f.commit);
  assert.ok(policy.reviewGate(state, { number: 90, head: context.head }).ok);
  assert.ok(!f.writes.some((w) => w.route.includes("/actions/variables")));
});
test("migration refuses stale commit, nonowner, live switches, missing stop and executable run", async () => {
  assert.ok(migration);
  const f = await fixture();
  const run = (extra) =>
    migration.migrateConcurrency({
      ...f,
      actor: policy.OWNER,
      expectedCommit: f.commit,
      execute: true,
      ...extra,
    });
  await assert.rejects(run({ actor: "intruder" }), /owner/i);
  await assert.rejects(run({ expectedCommit: "a".repeat(40) }), /commit/i);
  for (const name of Object.keys(switches)) {
    f.settings[name] = "true";
    await assert.rejects(run(), /switch|disabled|false/i);
    f.settings[name] = "false";
  }
  f.runs.push({ id: 300, path: ".github/workflows/factory-agents.yml", status: "in_progress" });
  await assert.rejects(run(), /running|terminal|agent/i);
  assert.equal((await f.ledger.read()).commit, f.commit);
  const state = structuredClone(f.state);
  delete state.stop;
  assert.equal(migration.previewMigration(state).eligible, false);
});
test("migration refuses active reservations, mixed schemas and repeated migration", async () => {
  assert.ok(migration);
  const pending = policy.reserve(
    policy.emptyState(policy.REPOSITORY),
    context,
    policy.readConfig(vars)
  ).state;
  assert.equal(migration.previewMigration(pending).eligible, false);
  const f = await fixture();
  const mixed = structuredClone(f.state);
  mixed.activeTickets = {};
  assert.throws(() => migration.previewMigration(mixed), /schema/i);
  await migration.migrateConcurrency({
    ...f,
    actor: policy.OWNER,
    expectedCommit: f.commit,
    execute: true,
  });
  assert.equal(migration.previewMigration((await f.ledger.read()).state).eligible, false);
});
