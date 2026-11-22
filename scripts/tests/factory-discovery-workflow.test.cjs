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
        triggering_actor: { login: p.OWNER, id: 101267861 },
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
        triggering_actor: { login: p.OWNER, id: 101267861 },
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

test("factory App can run discovery only as the verified main CI actor", async () => {
  const d = require("../factory/discovery-contract.cjs");
  const { testedMain, verifyParent } = require("../factory/discovery-run.cjs");
  const repo = { full_name: p.REPOSITORY };
  const actor = { login: "haideearus-software-factory[bot]", id: 356310548, type: "Bot" };
  const context = {
    repository: p.REPOSITORY,
    ref: "refs/heads/main",
    workflowRef: d.WORKFLOW_REF,
    workflowSha: head,
    runId: "100",
    runAttempt: 1,
    actor: actor.login,
    triggeringActor: actor.login,
    event: "workflow_run",
    phase: "discover",
    slot: "discovery",
  };
  const parent = {
    id: 100,
    path: ".github/workflows/factory-discovery.yml",
    head_branch: "main",
    head_sha: head,
    run_attempt: 1,
    event: "workflow_run",
    status: "in_progress",
    repository: repo,
    head_repository: repo,
    actor: { ...actor },
    triggering_actor: { ...actor },
  };
  const ci = {
    ...parent,
    id: 99,
    path: ".github/workflows/factory-ci.yml",
    event: "push",
    status: "completed",
    conclusion: "success",
  };
  const api = {
    async request(method, url) {
      assert.equal(method, "GET");
      return url.endsWith("/branches/main") ? { commit: { sha: head } } : parent;
    },
    async pages(url) {
      return url.includes("/jobs")
        ? [{ name: "verify", head_sha: head, conclusion: "success" }]
        : [ci];
    },
  };
  assert.equal(d.contextOK(context), true);
  await verifyParent(api, context);
  assert.equal((await testedMain(api, context, { workflow_run: ci })).ciRunId, "99");
  assert.equal(d.contextOK({ ...context, event: "workflow_dispatch" }), false);
  parent.triggering_actor.id = 123;
  await assert.rejects(verifyParent(api, context), /identity/i);
  parent.triggering_actor.id = actor.id;
  ci.head_repository = { full_name: "other/fork" };
  await assert.rejects(testedMain(api, context, { workflow_run: ci }), /identity|CI/i);
  ci.head_repository = repo;
  ci.triggering_actor = { ...actor, id: 123 };
  await assert.rejects(testedMain(api, context, { workflow_run: ci }), /identity|CI/i);
  ci.triggering_actor = actor;
  await assert.rejects(testedMain(api, context, { workflow_run: { id: 98 } }), /stale/i);

  // Finding intake rechecks the newest successful main CI without rebinding the
  // original discovery trigger. The current CI may now be owner-authored.
  ci.actor = ci.triggering_actor = { login: p.OWNER, id: 101267861 };
  const currentMain = await testedMain(api, { ...context, event: "workflow_dispatch" }, {});
  assert.equal(currentMain.ciRunId, "99");
});

test("a second sweep on a newer main head rotates to the other functional charter", () => {
  const d = require("../factory/discovery-contract.cjs");
  const day = "2026-11-20";
  const next = "f".repeat(40);
  const state = p.emptyState(p.REPOSITORY);
  const registry = emptyDiscovery();
  const config = { ...p.readConfig(vars), discovery: true };
  const first = selectSweep({ state, registry, head, day, config });
  state.tickets["8"] = { discovery: { charter: first.charter } };
  state.grants.used = {
    ticket: 8,
    phase: "discover",
    at: "2026-11-20T07:30:00.000Z",
    status: "finished",
  };
  registry.sources[d.sweepKey(head, first.charter, day)] = {
    status: "created",
    proof: { head, charter: first.charter, day },
  };
  const second = selectSweep({ state, registry, head: next, day, config });
  assert.equal(second.ready, true);
  assert.notEqual(second.charter, first.charter);
});

test("a delayed Bucharest schedule reaches the usual metered admission and releases no extra budget", async (t) => {
  const d = require("../factory/discovery-contract.cjs");
  const now = new Date("2026-11-22T06:39:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });
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
    FACTORY_VARIABLES: JSON.stringify({
      ...vars,
      FACTORY_DISCOVERY_ENABLED: "true",
      FACTORY_AUTOMATION_ENABLED: "true",
      FACTORY_GITHUB_APP_CLIENT_ID: "Iv1.fixture123456",
      FACTORY_GITHUB_APP_SLUG: "fixture-factory",
    }),
  };
  const api = {
    async request(method, path, body) {
      if (method === "POST") {
        assert.ok(path.endsWith("/issues"));
        return {
          ...body,
          number: 151,
          state: "open",
          user: { login: "github-actions[bot]", id: 41898282 },
        };
      }
      assert.equal(method, "GET");
      if (path.endsWith("/branches/main")) return { commit: { sha: head } };
      assert.ok(path.endsWith("/actions/runs/100"));
      return {
        id: 100,
        run_attempt: 1,
        path: ".github/workflows/factory-discovery.yml",
        head_sha: head,
        head_branch: "main",
        repository: { full_name: p.REPOSITORY },
        actor: { login: p.OWNER, id: 101267861 },
        triggering_actor: { login: p.OWNER, id: 101267861 },
        event: "schedule",
        status: "in_progress",
      };
    },
    async pages(path) {
      if (path.includes("/workflows/factory-ci.yml/"))
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
      if (path.includes("/actions/runs/99/"))
        return [{ name: "verify", head_sha: head, conclusion: "success" }];
      assert.ok(path.includes("/issues?state=open&labels=factory-ready"));
      return [];
    },
  };
  let state = p.emptyState(p.REPOSITORY);
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
  const result = await require("../factory/discovery-run.cjs").main(env, {
    api,
    ledger,
    store: registry(),
    now,
  });
  assert.equal(result?.grant?.phase, "discover");
  assert.equal(result.grant.ticket, 151);
  assert.equal(result.grant.at, "2026-11-22T06:39:00.000Z");
  assert.deepEqual(state.days["2026-11-22"], [151]);
  assert.equal(Object.keys(state.grants).length, 1);
});
