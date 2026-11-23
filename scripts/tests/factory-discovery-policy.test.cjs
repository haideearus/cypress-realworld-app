const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../factory/policy.cjs");
const d = require("../factory/discovery-policy.cjs");
const { vars, head } = require("./helpers/factory-fixtures.cjs");
const config = () =>
  p.readConfig({ ...vars, FACTORY_MAX_TICKETS_PER_DAY: "20", FACTORY_DISCOVERY_ENABLED: "true" });
const now = new Date("2026-11-17T14:00:00Z");
function request(ticket = 100, charter = "functional-feed", revision = head) {
  return {
    repository: p.REPOSITORY,
    actor: p.OWNER,
    triggeringActor: p.OWNER,
    ref: "refs/heads/main",
    event: "workflow_dispatch",
    workflowRef: d.WORKFLOW_REF,
    workflowSha: revision,
    runId: String(ticket),
    runAttempt: 1,
    ticket,
    head: revision,
    phase: "discover",
    slot: "discovery",
    origin: "discovery-sweep",
    discovery: {
      version: 1,
      head: revision,
      charter,
      day: "2026-11-17",
      ciRunId: "99",
      key: d.sweepKey(revision, charter, "2026-11-17"),
      runId: String(ticket),
      runAttempt: 1,
      workflowSha: revision,
      workflowRef: d.WORKFLOW_REF,
    },
  };
}
function one(state, req = request(), cfg = config()) {
  return p.reserve(state, req, cfg, now);
}
test("two sweeps consume shared admission and a third is rejected without refund after failure", () => {
  let s = p.emptyState(p.REPOSITORY);
  for (const [id, charter] of [
    [100, "functional-feed"],
    [101, "functional-directory"],
  ]) {
    const r = one(s, request(id, charter));
    p.validateState(r.state);
    p.preflight(r.state, r.grant.id, request(id, charter), config());
    s = p.finish(r.state, r.grant.id, { status: "blocked" }, now);
    p.validateState(s);
  }
  assert.deepEqual(s.days["2026-11-17"], [100, 101]);
  assert.equal(Object.values(s.grants).filter((g) => g.phase === "discover").length, 2);
  assert.throws(() => one(s, request(102, "functional-feed", "b".repeat(40))), /Discovery daily/);
  assert.throws(
    () => p.reserve(s, request(100), config(), new Date("2026-11-18T14:00:00Z")),
    /already|repeated/i
  );
});
test("same source and charter cannot reserve twice through a different issue or parent", () => {
  const r = one(p.emptyState(p.REPOSITORY));
  const s = p.finish(r.state, r.grant.id, { status: "discovery_complete" }, now);
  assert.throws(() => one(s, request(101)), /Duplicate discovery/);
  assert.throws(
    () => p.reserve(s, { ...request(), phase: "code" }, config(), now),
    /discovery|Unauthorized/i
  );
  assert.equal(p.reviewGate(s, { head, number: 100 }).ok, false);
});

test("opt-in admits three distinct charters and rejects a fourth on the same day", () => {
  const cfg = p.readConfig({
    ...vars,
    FACTORY_MAX_TICKETS_PER_DAY: "20",
    FACTORY_DISCOVERY_ENABLED: "true",
    FACTORY_MAX_DISCOVERY_SWEEPS_PER_DAY: "3",
  });
  let state = p.emptyState(p.REPOSITORY);
  for (const [id, charter] of [
    [100, "functional-feed"],
    [101, "functional-directory"],
    [102, "functional-notifications"],
  ]) {
    const r = one(state, { ...request(id, charter), quota: { limit: 1000, remaining: 250 } }, cfg);
    state = p.finish(r.state, r.grant.id, { status: "blocked" }, now);
    p.validateState(state);
  }
  assert.deepEqual(state.days["2026-11-17"], [100, 101, 102]);
  assert.throws(() => one(state, request(103, "functional-settings"), cfg), /Discovery daily/);
  assert.throws(
    () => p.readConfig({ ...vars, FACTORY_MAX_DISCOVERY_SWEEPS_PER_DAY: "4" }),
    /approved limit|discovery sweep/i
  );
});

test("the third selection reserves quota headroom and excludes all used charters after a push", () => {
  const cfg = { ...config(), discoverySweeps: 3 };
  const nextHead = "b".repeat(40);
  let state = p.emptyState(p.REPOSITORY);
  for (const [id, charter] of [
    [100, "functional-feed"],
    [101, "functional-directory"],
  ]) {
    const r = one(state, request(id, charter), cfg);
    state = p.finish(r.state, r.grant.id, { status: "discovery_complete" }, now);
  }
  const input = {
    state,
    registry: { sources: {} },
    head: nextHead,
    day: "2026-11-17",
    config: cfg,
  };
  const { selectSweep } = require("../factory/discovery-run.cjs");
  assert.match(selectSweep(input).reason, /GitHub API headroom/);
  assert.equal(selectSweep({ ...input, quota: { limit: 1000, remaining: 249 } }).ready, false);
  const allowed = selectSweep({ ...input, quota: { limit: 1000, remaining: 250 } });
  assert.equal(allowed.ready, true);
  assert.ok(["functional-notifications", "functional-settings"].includes(allowed.charter));
  assert.throws(
    () =>
      one(
        state,
        { ...request(102, allowed.charter, nextHead), quota: { limit: 1000, remaining: 249 } },
        cfg
      ),
    /GitHub API headroom/
  );
  assert.equal(Object.keys(state.grants).length, 2);
  assert.throws(
    () => one(state, request(102, "functional-directory", nextHead), cfg),
    /already used/i
  );
});
test("discovery cannot bypass the global cap, stop, disabled opt-in or active work", () => {
  assert.throws(
    () => one(p.emptyState(p.REPOSITORY), request(), { ...config(), daily: 0 }),
    /Daily ticket/
  );
  assert.throws(() => one(p.emptyState(p.REPOSITORY), request(), p.readConfig(vars)), /disabled/i);
  const s = one(p.emptyState(p.REPOSITORY)).state;
  assert.throws(() => one(s, request(101, "functional-directory")), /active|capacity/i);
  assert.throws(
    () => one(p.emptyState(p.REPOSITORY), request(101, "session")),
    /Functional discovery charter/
  );
  const r = request();
  r.discovery.workflowSha = "b".repeat(40);
  assert.throws(() => one(p.emptyState(p.REPOSITORY), r), /provenance/i);
  assert.throws(
    () => one(p.emptyState(p.REPOSITORY), { ...request(), actor: "github-actions[bot]" }),
    /Unauthorized/i
  );
});
test("both shared slots block a third and stop inventory contains discovery parents", () => {
  let s = p.emptyState(p.REPOSITORY);
  s.version = 2;
  s.activeTickets = {};
  delete s.active;
  const cfg = { ...config(), concurrent: 2 };
  s = one(s, request(), cfg).state;
  s = one(s, request(101, "functional-directory"), cfg).state;
  assert.throws(
    () => one(s, request(102, "functional-feed", "b".repeat(40)), cfg),
    /active|capacity/i
  );
  assert.ok(
    require("../factory/stop.cjs").AGENT_WORKFLOWS.includes(
      ".github/workflows/factory-discovery.yml"
    )
  );
});
