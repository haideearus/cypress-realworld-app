const test = require("node:test"),
  assert = require("node:assert/strict");
const { MetadataFixture } = require("./helpers/metadata-fixture.cjs");
const { fixture, sha } = require("./helpers/event-fixtures.cjs");
const { WakeStore } = require("../factory/wake-store.cjs"),
  { ActivityStore } = require("../factory/activity-store.cjs");
const { handleWake } = require("../factory/wake-controller.cjs");
const a = require("../factory/activity.cjs");
test("registries require explicit initialization and are separate from usage state", async () => {
  const api = new MetadataFixture(),
    w = new WakeStore(api),
    n = new ActivityStore(api);
  await assert.rejects(w.read(), /Not found/);
  await w.initialize();
  await n.initialize();
  assert.deepEqual([...api.refs.keys()].sort(), ["factory/activity", "factory/wakes"]);
  await assert.rejects(w.initialize(), /already initialized/);
  assert.equal((await n.read()).state.lastMonitor, null);
});
test("real CAS contention permits one event dispatch and preserves both metadata namespaces", async () => {
  const s = fixture(),
    git = new MetadataFixture(),
    base = s.api.request;
  s.api.request = (m, p, b) =>
    p.includes("/git/") || p.includes("/contents/") ? git.request(m, p, b) : base(m, p, b);
  s.store = new WakeStore(s.api);
  await s.store.initialize();
  await new ActivityStore(s.api).initialize();
  const results = await Promise.all([handleWake(s), handleWake(s)]);
  assert.equal(results.filter((r) => r.outcome === "dispatched").length, 1);
  assert.equal(s.dispatches.length, 1);
  assert.equal(Object.keys((await s.store.read()).state.receipts).length, 1);
  assert.deepEqual((await new ActivityStore(s.api).read()).state.events, {});
  assert.deepEqual(s.ledger.state.days, {});
});
test("malformed activity receipts, arbitrary file types and saturated wake metadata fail closed", async () => {
  const api = new MetadataFixture(),
    store = new ActivityStore(api);
  await store.initialize();
  await assert.rejects(
    store.update((s) => {
      s.events.bad = {};
      return { state: s };
    }),
    /activity/
  );
  const s = fixture();
  s.store.state.receipts = Object.fromEntries(
    Array.from({ length: 1201 }, (_, i) => [String(i), {}])
  );
  await assert.rejects(handleWake(s), /registry/);
  assert.equal(s.dispatches.length, 0);
});
test("a configured journal cannot enter app pickup, even if accidentally labelled ready", async () => {
  const s = fixture();
  s.vars.FACTORY_ACTIVITY_ISSUE_NUMBER = "12";
  assert.equal((await handleWake(s)).outcome, "ignored");
  assert.equal(s.dispatches.length, 0);
});
