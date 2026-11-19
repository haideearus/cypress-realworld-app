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
