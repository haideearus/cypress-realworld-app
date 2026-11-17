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

module.exports = { v2, request, config };
