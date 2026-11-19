const test = require("node:test");
const assert = require("node:assert/strict");
const { sourceFor, selectSweep } = require("../factory/discovery-run.cjs");
const { emptyDiscovery } = require("../factory/discovery-contract.cjs");
const p = require("../factory/policy.cjs");
test("owner preview can inspect eligibility with discovery disabled and performs no writes", async () => {
  const d = require("../factory/discovery-contract.cjs");
  const { vars, head } = require("./helpers/factory-fixtures.cjs");
  const env = {
    GITHUB_REPOSITORY: p.REPOSITORY,
    GITHUB_ACTOR: p.OWNER,
    GITHUB_TRIGGERING_ACTOR: p.OWNER,
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: d.WORKFLOW_REF,
    GITHUB_WORKFLOW_SHA: head,
    GITHUB_RUN_ID: "100",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    FACTORY_INPUTS: JSON.stringify({ operation: "preview", dry_run: true }),
    FACTORY_VARIABLES: JSON.stringify({ ...vars, FACTORY_ENABLED: "false" }),
  };
  const api = {
    async request(method, url) {
      assert.equal(method, "GET");
      if (url.endsWith("/branches/main")) return { commit: { sha: head } };
      return {
        id: 100,
        run_attempt: 1,
        path: ".github/workflows/factory-discovery.yml",
        head_sha: head,
        head_branch: "main",
        repository: { full_name: p.REPOSITORY },
        actor: { login: p.OWNER, id: 101267861 },
        triggering_actor: { login: p.OWNER },
        event: "workflow_dispatch",
        status: "in_progress",
      };
    },
    async pages(url) {
      if (url.includes("/workflows/factory-ci"))
        return [
          {
            id: 99,
            head_sha: head,
            head_branch: "main",
            event: "push",
            path: ".github/workflows/factory-ci.yml",
            status: "completed",
            conclusion: "success",
            repository: { full_name: p.REPOSITORY },
            run_attempt: 1,
          },
        ];
      if (url.includes("/jobs")) return [{ name: "verify", head_sha: head, conclusion: "success" }];
      return [];
    },
  };
  const ledger = {
    async read() {
      return { state: p.emptyState(p.REPOSITORY) };
    },
    async update() {
      throw Error("preview wrote state");
    },
  };
  const store = {
    async read() {
      return { state: emptyDiscovery() };
    },
    async update() {
      throw Error("preview wrote metadata");
    },
  };
  const result = await require("../factory/discovery-run.cjs").main(env, {
    api,
    ledger,
    store,
    now: new Date("2026-11-17T14:00:00Z"),
  });
  assert.equal(result.outcome, "preview");
  assert.equal(result.eligible, true);
  assert.equal(result.discoveryEnabled, false);
  assert.equal(result.ready, false);
});
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
test("unresolved source intent blocks a replacement charter until metadata reconciliation", () => {
  const registryState = emptyDiscovery();
  registryState.sources[proof.key] = { proof, status: "intent", issue: null };
  const choice = selectSweep({
    state: p.emptyState(p.REPOSITORY),
    registry: registryState,
    head,
    day: proof.day,
    config: { ...p.readConfig(vars), discovery: true },
  });
  assert.equal(choice.ready, false);
  assert.equal(choice.reconcileKey, proof.key);
});

test("scheduled finalization after the admission hour releases the existing grant", async () => {
  const d = require("../factory/discovery-policy.cjs");
  const { context } = require("./helpers/factory-fixtures.cjs");
  const config = { ...p.readConfig(vars), discovery: true, automatic: true };
  const request = {
    ...context,
    workflowRef: d.WORKFLOW_REF,
    workflowSha: head,
    head,
    origin: "discovery-sweep",
    phase: "discover",
    slot: "discovery",
    discovery: { ...proof, charter: "functional-feed" },
  };
  request.discovery.key = d.sweepKey(head, "functional-feed", proof.day);
  const admitted = p.reserve(
    p.emptyState(p.REPOSITORY),
    request,
    config,
    new Date("2026-11-17T01:20:00Z")
  );
  let state = admitted.state;
  const ledger = {
    async read() {
      return { state };
    },
    async update(fn) {
      const r = fn(state);
      state = r.state;
      return r;
    },
  };
  const env = {
    GITHUB_REPOSITORY: p.REPOSITORY,
    GITHUB_ACTOR: p.OWNER,
    GITHUB_TRIGGERING_ACTOR: p.OWNER,
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: d.WORKFLOW_REF,
    GITHUB_WORKFLOW_SHA: head,
    GITHUB_RUN_ID: "100",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_EVENT_NAME: "schedule",
    FACTORY_OPERATION: "finish",
    FACTORY_INPUTS: JSON.stringify({ grantId: admitted.grant.id }),
    FACTORY_VARIABLES: JSON.stringify({ ...vars, FACTORY_DISCOVERY_ENABLED: "true" }),
  };
  const api = {
    async request() {
      return {
        id: 100,
        run_attempt: 1,
        path: ".github/workflows/factory-discovery.yml",
        head_sha: head,
        head_branch: "main",
        repository: { full_name: p.REPOSITORY },
        actor: { login: p.OWNER, id: 101267861 },
        triggering_actor: { login: p.OWNER },
        event: "schedule",
        status: "in_progress",
      };
    },
  };
  await require("../factory/discovery-run.cjs").main(env, {
    api,
    ledger,
    store: {},
    now: new Date("2026-11-17T02:20:00Z"),
  });
  assert.equal(state.grants[admitted.grant.id].status, "finished");
  assert.equal(state.active, null);
});
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

test("duplicate main-CI delivery cannot spend the second charter session", () => {
  const registryState = emptyDiscovery();
  registryState.sources[proof.key] = { proof, status: "created", issue: 900 };
  const choice = selectSweep({
    state: p.emptyState(p.REPOSITORY),
    registry: registryState,
    head,
    day: proof.day,
    config: { ...p.readConfig(vars), discovery: true },
    ciSignal: "99",
  });
  assert.equal(choice.ready, false);
  assert.match(choice.reason, /Duplicate main CI/);
});
