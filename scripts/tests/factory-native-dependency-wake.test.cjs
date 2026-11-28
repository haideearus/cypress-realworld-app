const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture } = require("./helpers/event-fixtures.cjs");
const contract = require("../factory/wake-contract.cjs");
const { handleWake } = require("../factory/wake-controller.cjs");
const { criteria } = require("../factory/dependency-contract.cjs");

const nativeActor = { login: "dependabot[bot]", id: 49699333, type: "Bot" };
const head = "d".repeat(40);
const branch = "dependabot/npm_and_yarn/faker-js/faker-10.5.0";
const ciPath = ".github/workflows/factory-ci.yml";
const approvedStep = "Run yarn types && yarn lint && yarn test:unit:ci";

function failedFixture({
  step = approvedStep,
  actor = nativeActor,
  stale = false,
  rediscover = false,
} = {}) {
  const s = fixture();
  s.context.event = s.run.event = "workflow_run";
  const run = {
    ...s.run,
    id: 2320,
    workflow_id: 70,
    event: "pull_request",
    head_branch: branch,
    head_sha: head,
    path: ciPath,
    status: "completed",
    conclusion: "failure",
    actor,
    triggering_actor: actor,
    display_title: "Factory CI / 232",
    pull_requests: [{ number: 232 }],
  };
  const pr = {
    number: 232,
    state: "open",
    draft: false,
    user: nativeActor,
    base: { ref: "main", repo: run.repository, sha: s.context.workflowSha },
    head: { ref: branch, repo: run.repository, sha: head },
  };
  const idle = {
    ...s.run,
    id: 701,
    workflow_id: 71,
    path: ".github/workflows/factory-automatic.yml",
    event: "schedule",
    head_branch: "main",
    conclusion: "success",
    status: "completed",
  };
  s.event = {
    repository: run.repository,
    action: "completed",
    workflow_run: rediscover ? idle : run,
  };
  const request = s.api.request;
  const jobs = ["app", "verify"].map((name) => ({
    name,
    status: "completed",
    conclusion: "failure",
    run_id: run.id,
    run_attempt: run.run_attempt,
    head_sha: run.head_sha,
    steps: name === "app" ? [{ name: step, conclusion: "failure" }] : [],
  }));
  s.api.request = (method, route, body) => {
    if (method === "GET" && route.endsWith("/actions/workflows/factory-ci.yml"))
      return { id: run.workflow_id, path: ciPath };
    if (method === "GET" && route.endsWith("/actions/workflows/factory-automatic.yml"))
      return { id: idle.workflow_id, path: idle.path };
    if (method === "GET" && route.endsWith("/actions/runs/2320/attempts/1")) return run;
    if (method === "GET" && route.endsWith("/actions/runs/701/attempts/1")) return idle;
    if (method === "GET" && route.includes("/actions/runs/2320/attempts/1/jobs")) return { jobs };
    if (method === "GET" && route.includes("/actions/workflows/factory-ci.yml/runs?"))
      return { workflow_runs: route.includes("status=success") ? [] : [run] };
    if (method === "GET" && route.endsWith("/pulls/232")) return pr;
    if (method === "GET" && route.endsWith("/pulls/232/files?per_page=3"))
      return [{ filename: "yarn.lock", status: "modified" }];
    if (method === "GET" && route.includes("/compare/"))
      return { behind_by: stale ? 1 : 0, merge_base_commit: { sha: s.context.workflowSha } };
    return request(method, route, body);
  };
  s.api.pages = async (route) =>
    route.includes("/runs/701/")
      ? [
          {
            name: "pick",
            status: "completed",
            conclusion: "success",
            steps: [
              {
                name: "Hand off an idle app queue to dependency maintenance",
                conclusion: "success",
              },
            ],
          },
        ]
      : jobs;
  return s;
}

function activeParent(s, options = {}) {
  const sha = options.sha ?? s.context.workflowSha;
  s.ledger.state.active = { ticket: 4, runId: "4", runAttempt: 1 };
  const request = s.api.request;
  s.api.request = (method, route, body) => {
    if (method === "GET" && route.endsWith("/actions/runs/4/attempts/1")) {
      if (options.unreadable)
        throw Object.assign(new Error("Actions run unavailable"), { status: 502 });
      return {
        ...s.run,
        id: options.id ?? 4,
        path: ".github/workflows/factory-automatic.yml",
        event: "schedule",
        head_sha: sha,
      };
    }
    return request(method, route, body);
  };
}

test("exact native app CI failure wakes only its original dependency PR and deduplicates", async () => {
  const s = failedFixture();
  const result = await handleWake(s);
  assert.equal(result.outcome, "dispatched");
  const receipt = s.store.state.receipts[result.receiptId];
  assert.deepEqual(receipt.signal, {
    kind: "dependency-failed-ci",
    lane: "dependency",
    number: 232,
    head,
    revision: s.context.workflowSha,
    criteriaHash: criteria(232),
    sourceRun: "2320",
    sourceAttempt: 1,
    actor: { login: nativeActor.login, id: nativeActor.id },
  });
  assert.equal(contract.isDependencyCI(receipt.signal), true);
  assert.equal((await handleWake(s)).outcome, "duplicate");
  assert.equal(s.dispatches.length, 1);
  assert.deepEqual(s.ledger.state.grants, {});
});

test("an unrelated failure, foreign actor or stale main cannot wake compatibility", async () => {
  for (const source of [
    { step: "Set up job" },
    { actor: { ...nativeActor, id: 1 } },
    { stale: true },
  ]) {
    const s = failedFixture(source);
    assert.equal((await handleWake(s)).outcome, "ignored");
    assert.equal(s.dispatches.length, 0);
    assert.deepEqual(s.store.state.receipts, {});
  }
});

test("busy native failure is retained and dispatched once the scheduled wake sees a free slot", async () => {
  const busy = failedFixture();
  activeParent(busy);
  assert.equal((await handleWake(busy)).outcome, "busy");
  const [id, pending] = Object.entries(busy.store.state.receipts).at(0);
  assert.equal(pending.status, "pending");
  assert.equal(busy.dispatches.length, 0);
  busy.ledger.state.active = null;
  busy.context = { ...busy.context, event: "schedule", runId: "801" };
  const existing = busy.api.request;
  busy.api.request = (method, route, body) =>
    method === "GET" && route.endsWith("/actions/runs/801/attempts/1")
      ? { ...busy.run, id: 801, event: "schedule", created_at: new Date().toISOString() }
      : existing(method, route, body);
  const resumed = await handleWake(busy);
  assert.equal(resumed.outcome, "dispatched");
  assert.equal(resumed.receiptId, id);
  assert.equal(busy.dispatches.length, 1);
});

test("a new failed CI receipt waits for rediscovery while older or unknown worker code is active", async () => {
  for (const options of [{ sha: "f".repeat(40) }, { unreadable: true }, { id: 5 }]) {
    const s = failedFixture();
    activeParent(s, options);
    assert.equal((await handleWake(s)).outcome, "busy");
    assert.deepEqual(s.store.state.receipts, {});
    assert.equal(s.store.writes, 0);
    assert.equal(s.dispatches.length, 0);
  }
});

test("idle pickup can rediscover a missed native failure", async () => {
  const idle = failedFixture({ rediscover: true });
  const result = await handleWake(idle);
  assert.equal(result.outcome, "dispatched");
  assert.equal(idle.store.state.receipts[result.receiptId].signal.kind, "dependency-failed-ci");
  assert.equal(idle.store.state.receipts[result.receiptId].signal.sourceRun, "2320");
  assert.equal(idle.dispatches.length, 1);
});
