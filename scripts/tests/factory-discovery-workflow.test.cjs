const test = require("node:test");
const assert = require("node:assert/strict");
const { sourceFor, selectSweep } = require("../factory/discovery-run.cjs");
const { emptyDiscovery } = require("../factory/discovery-contract.cjs");
const p = require("../factory/policy.cjs");
const { head, vars } = require("./helpers/factory-fixtures.cjs");
const proof = {
  version: 1,
  head,
  charter: "feed",
  day: "2026-11-17",
  ciRunId: "99",
  runId: "100",
  runAttempt: 1,
  workflowSha: head,
  workflowRef: require("../factory/discovery-contract.cjs").WORKFLOW_REF,
};
proof.key = require("../factory/discovery-contract.cjs").sweepKey(head, "feed", proof.day);
function registry() {
  let state = emptyDiscovery();
  return {
    async read() {
      return { state: structuredClone(state) };
    },
    async update(fn) {
      const r = fn(structuredClone(state));
      state = r.state;
      return r;
    },
  };
}
test("uncertain source POST is retained and reconciled; a second producer cannot repeat it", async () => {
  const store = registry();
  let posts = 0;
  let body;
  let issues = [];
  const api = {
    async request(method, url, value) {
      assert.equal(method, "POST");
      posts++;
      body = value.body;
      throw Error("lost response");
    },
    async pages() {
      return issues;
    },
  };
  await assert.rejects(sourceFor(api, store, proof), /lost response/);
  await assert.rejects(sourceFor(api, store, proof), /uncertain/i);
  assert.equal(posts, 1);
  issues = [
    {
      number: 900,
      user: { login: "github-actions[bot]", id: 41898282 },
      body,
      labels: [],
      state: "open",
    },
  ];
  assert.equal(await sourceFor(api, store, proof), 900);
  assert.equal(posts, 1);
});
test("two charter sweeps on unchanged main are distinct; global cap and busy capacity hold selection", () => {
  const state = p.emptyState(p.REPOSITORY);
  const day = "2026-11-17";
  const cfg = { ...p.readConfig(vars), daily: 20, discovery: true };
  const first = selectSweep({ state, registry: emptyDiscovery(), head, day, config: cfg });
  const r = emptyDiscovery();
  r.sources[require("../factory/discovery-contract.cjs").sweepKey(head, first.charter, day)] = {};
  assert.notEqual(
    selectSweep({ state, registry: r, head, day, config: cfg }).charter,
    first.charter
  );
  assert.equal(
    selectSweep({ state, registry: r, head, day, config: { ...cfg, daily: 0 } }).ready,
    false
  );
  assert.equal(
    selectSweep({ state, registry: r, head, day, config: cfg, repairsWaiting: true }).ready,
    false
  );
});
