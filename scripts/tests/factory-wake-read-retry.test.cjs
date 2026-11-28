const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Ledger, ROOT } = require("../factory/github.cjs");
const { WakeStore } = require("../factory/wake-store.cjs");
const { main: wakeMain } = require("../factory/wake.cjs");
const { main: automaticMain } = require("../factory/automation.cjs");
const { handleWake } = require("../factory/wake-controller.cjs");
const { BOT, BOT_ID } = require("../factory/wake-contract.cjs");
const { vars } = require("./helpers/factory-fixtures.cjs");
const { fixture, sha } = require("./helpers/event-fixtures.cjs");

const sourcePath = `${ROOT}/actions/runs/701/attempts/1`;
const dispatchPath = `${ROOT}/actions/workflows/factory-automatic.yml/dispatches`;
function mainCI(t) {
  const s = fixture();
  const { api } = s;
  const ci = {
    ...s.run,
    id: 701,
    workflow_id: 71,
    path: ".github/workflows/factory-ci.yml",
    event: "push",
    status: "completed",
    conclusion: "success",
  };
  s.context.event = s.run.event = "workflow_run";
  s.event = { repository: ci.repository, action: "completed", workflow_run: ci };
  const read = api.request;
  api.request = async (method, route, body) => {
    if (method === "GET" && route === sourcePath) return structuredClone(ci);
    if (method === "GET" && route.endsWith("/actions/workflows/factory-ci.yml"))
      return { id: ci.workflow_id, path: ci.path };
    if (method === "GET" && route.startsWith(`${ROOT}/issues?`)) return [];
    if (method === "GET" && route.includes("/runs/701/attempts/1/jobs?"))
      return { jobs: await api.pages() };
    return read(method, route, body);
  };
  api.pages = async () => [
    { name: "verify", run_id: ci.id, head_sha: sha, status: "completed", conclusion: "success" },
  ];
  t.mock.method(WakeStore.prototype, "read", () => s.store.read());
  t.mock.method(WakeStore.prototype, "update", (fn) => s.store.update(fn));
  t.mock.method(Ledger.prototype, "read", () => s.ledger.read());
  return { ...s, ci };
}

function environment(t, s, context, event) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "factory-wake-retry-"));
  const eventPath = path.join(directory, "event.json");
  t.after(() => {
    fs.rmSync(eventPath, { force: true });
    fs.rmdirSync(directory);
  });
  fs.writeFileSync(eventPath, JSON.stringify(event));
  return {
    GITHUB_TOKEN: "fixture-only",
    GH_TOKEN: "fixture-only",
    GITHUB_REPOSITORY: context.repository,
    GITHUB_ACTOR: context.actor,
    GITHUB_TRIGGERING_ACTOR: context.triggeringActor,
    GITHUB_REF: context.ref,
    GITHUB_EVENT_NAME: context.event,
    GITHUB_RUN_ID: context.runId,
    GITHUB_RUN_ATTEMPT: String(context.runAttempt),
    GITHUB_WORKFLOW_SHA: context.workflowSha,
    GITHUB_WORKFLOW_REF: context.workflowRef,
    GITHUB_EVENT_PATH: eventPath,
    FACTORY_VARIABLES: JSON.stringify({
      ...vars,
      ...s.vars,
      FACTORY_GITHUB_APP_CLIENT_ID: "Iv1.fixture123456",
      FACTORY_GITHUB_APP_SLUG: "fixture-factory",
    }),
  };
}

function mockGitHub(t, s, options) {
  const calls = [];
  let failures = options.readFailures;
  t.mock.method(globalThis, "fetch", async (url, request) => {
    const route = url.pathname + url.search;
    const method = request.method;
    calls.push({ method, route });
    if (method === "GET" && route === sourcePath && failures-- > 0)
      return new Response(JSON.stringify({ message: "Synthetic GitHub 500" }), { status: 500 });
    if (options.failDispatch && method === "POST" && route === dispatchPath)
      return new Response(JSON.stringify({ message: "Synthetic ambiguous write" }), {
        status: 500,
      });
    const body = request.body ? JSON.parse(request.body) : undefined;
    const value = await s.api.request(method, route, body);
    return value === null
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(value), { status: 200 });
  });
  return calls;
}

test("the main CI wake retries an HTTP 500 proof read but never replays an uncertain dispatch", async (t) => {
  const s = mainCI(t);
  const calls = mockGitHub(t, s, { readFailures: 1, failDispatch: true });
  const result = await wakeMain(environment(t, s, s.context, s.event));
  assert.equal(result.outcome, "uncertain");
  assert.equal(s.store.state.receipts[result.receiptId].status, "intent");
  assert.equal(
    calls.filter(({ method, route }) => method === "GET" && route === sourcePath).length,
    2
  );
  assert.equal(
    calls.filter(({ method, route }) => method === "POST" && route === dispatchPath).length,
    1
  );
});

for (const num of [1, 3]) {
  test(`normal pickup preserves main CI wake identity with ${num} HTTP 500 proof read failure(s)`, async (t) => {
    const s = mainCI(t);
    const origin = await handleWake(s);
    assert.equal(origin.outcome, "dispatched");
    const id = origin.receiptId;
    const receiver = {
      ...s.ci,
      id: 702,
      workflow_id: 72,
      path: ".github/workflows/factory-automatic.yml",
      event: "workflow_dispatch",
      display_title: `Automatic factory / wake ${id}`,
      actor: { login: BOT, id: BOT_ID },
      triggering_actor: { login: BOT, id: BOT_ID },
    };
    const read = s.api.request;
    s.api.request = (method, route, body) => {
      if (method === "GET" && route.endsWith("/actions/runs/702/attempts/1"))
        return structuredClone(receiver);
      if (method === "GET" && route.endsWith("/actions/workflows/factory-automatic.yml"))
        return { id: receiver.workflow_id, path: receiver.path };
      return read(method, route, body);
    };
    const ctx = {
      ...s.context,
      runId: "702",
      actor: BOT,
      triggeringActor: BOT,
      event: "workflow_dispatch",
      workflowRef: `${s.context.repository}/${receiver.path}@refs/heads/main`,
    };
    const inputs = { operation: "run", dry_run: false, wake_id: id };
    const env = {
      ...environment(t, s, ctx, { inputs }),
      FACTORY_INPUTS: JSON.stringify(inputs),
      FACTORY_OPERATION: "auto_pick",
    };
    const calls = mockGitHub(t, s, { readFailures: num });
    if (num === 1) {
      const result = await automaticMain(env);
      assert.equal(result.ready, false);
      assert.match(result.reason, /No eligible issue/);
      assert.equal(s.store.state.receipts[id].status, "bound");
      assert.equal(s.store.state.receipts[id].receiver.runId, ctx.runId);
    } else {
      await assert.rejects(automaticMain(env), { status: 500 });
      assert.equal(s.store.state.receipts[id].status, "sent");
      assert.equal(s.store.state.receipts[id].receiver, null);
    }
    assert.equal(calls.filter(({ route }) => route === sourcePath).length, num === 1 ? 2 : 3);
    assert.deepEqual(s.ledger.state.grants, {});
    assert.ok(calls.every(({ method }) => method === "GET"));
  });
}
