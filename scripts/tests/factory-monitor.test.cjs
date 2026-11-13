const test = require("node:test");
const assert = require("node:assert/strict");
const { monitor, assertMonitorContext } = require("../factory/monitor.cjs");
const { emptyMonitorState, validateMonitorState } = require("../factory/monitor-state.cjs");
const repository = "haideearus/cypress-realworld-app";
const sha = "a".repeat(40);
const context = {
  repository,
  ref: "refs/heads/main",
  workflowRef: `${repository}/.github/workflows/factory-monitor.yml@refs/heads/main`,
  workflowSha: sha,
  sha,
  runId: "300",
  runAttempt: 1,
  eventName: "workflow_dispatch",
  actor: "haideearus",
  triggeringActor: "haideearus",
};
function fixture() {
  const events = [];
  let state = emptyMonitorState();
  let commit = null;
  let seq = 0;
  let issueState = "open";
  let issueNumber = 49;
  const store = {
    async read() {
      events.push("read");
      return { state: structuredClone(state), commit };
    },
    async save(next, parent) {
      validateMonitorState(next);
      assert.equal(parent, commit);
      events.push(`save:${next.active ? next.incidents[next.active].phase : "healthy"}`);
      state = structuredClone(next);
      commit = String(++seq).padStart(40, "0");
      return commit;
    },
  };
  const api = {
    async request(method, path, body) {
      events.push(`${method}:${path}`);
      if (method === "POST" && path.endsWith("/issues"))
        return {
          number: ++issueNumber,
          title: body.title,
          body: body.body,
          user: { login: "github-actions[bot]", type: "Bot" },
        };
      if (method === "GET" && path.endsWith(`/issues/${issueNumber}`))
        return { number: issueNumber, state: issueState };
      throw new Error("Unexpected request");
    },
  };
  let healthy = false;
  const probe = async () => {
    events.push("probe");
    return {
      healthy,
      checks: { health: healthy ? "ok" : "failed", readiness: "ok", frontend: "ok" },
      attempts: 3,
    };
  };
  const options = {
    api,
    store,
    context,
    enabled: true,
    dryRun: false,
    probe,
    now: () => "2026-11-13T20:00:00.000Z",
  };
  return {
    options,
    events,
    store,
    get state() {
      return state;
    },
    set healthy(v) {
      healthy = v;
    },
    set issueState(v) {
      issueState = v;
    },
  };
}
test("disabled monitoring performs no probe or mutation; preview never writes", async () => {
  const f = fixture();
  const r = await monitor({ ...f.options, enabled: false });
  assert.equal(r.outcome, "disabled");
  assert.deepEqual(f.events, []);
  const p = await monitor({ ...f.options, enabled: false, dryRun: true });
  assert.equal(p.outcome, "preview");
  assert.deepEqual(f.events, ["probe"]);
});
test("untrusted context, rerun or ambiguous inputs stop before network work", async () => {
  const f = fixture();
  for (const change of [
    { repository: "other/repo" },
    { ref: "refs/heads/test" },
    { runAttempt: 2 },
    { sha: "b".repeat(40) },
    { actor: "attacker" },
    { eventName: "pull_request" },
  ])
    assert.throws(() => assertMonitorContext({ ...context, ...change }));
  await assert.rejects(monitor({ ...f.options, dryRun: "false" }));
  assert.deepEqual(f.events, []);
});
test("unhealthy monitoring creates one sanitized incident after persisting its intent", async () => {
  const f = fixture();
  const r = await monitor(f.options);
  assert.equal(r.outcome, "incident_created");
  assert.equal(r.issue, 50);
  assert.ok(f.events.indexOf("save:pending") < f.events.findIndex((e) => e.startsWith("POST:")));
  assert.equal(Object.values(f.state.incidents)[0].phase, "open");
  const second = await monitor({
    ...f.options,
    context: { ...context, runId: "301" },
    now: () => "2026-11-14T20:00:00.000Z",
  });
  assert.equal(second.outcome, "incident_existing");
  assert.equal(f.events.filter((e) => e.startsWith("POST:")).length, 1);
});
test("uncertain issue creation is never retried and leaves the pending intent", async () => {
  const f = fixture();
  f.options.api = {
    request: async () => {
      throw new Error("private response must not be logged");
    },
  };
  await assert.rejects(monitor(f.options), /private response/);
  assert.equal(Object.values(f.state.incidents)[0].phase, "pending");
  const r = await monitor(f.options);
  assert.equal(r.outcome, "publication_needs_owner_recovery");
});
test("healthy observation preserves issue history and permits rearm only after issue closes", async () => {
  const f = fixture();
  await monitor(f.options);
  f.healthy = true;
  const r = await monitor(f.options);
  assert.equal(r.outcome, "recovered");
  assert.equal(Object.values(f.state.incidents)[0].recovered, true);
  assert.notEqual(f.state.active, null);
  f.issueState = "closed";
  await monitor(f.options);
  assert.equal(f.state.active, null);
  assert.equal(Object.keys(f.state.incidents).length, 1);
  f.healthy = false;
  await monitor(f.options);
  assert.equal(Object.keys(f.state.incidents).length, 2);
});
test("closing an issue while outage continues does not create fresh repair budget", async () => {
  const f = fixture();
  await monitor(f.options);
  f.issueState = "closed";
  await monitor(f.options);
  assert.equal(f.events.filter((e) => e.startsWith("POST:")).length, 1);
  assert.notEqual(f.state.active, null);
});
test("two incident creation intents per UTC date cap flapping without deleting history", async () => {
  const f = fixture();
  for (let n = 0; n < 2; n++) {
    f.healthy = false;
    f.issueState = "open";
    await monitor(f.options);
    f.healthy = true;
    f.issueState = "closed";
    await monitor(f.options);
  }
  f.healthy = false;
  const r = await monitor(f.options);
  assert.equal(r.outcome, "incident_creation_limit");
  assert.equal(Object.keys(f.state.incidents).length, 2);
});
test("invalid probe output and time cannot be published", async () => {
  const f = fixture();
  await assert.rejects(
    monitor({
      ...f.options,
      probe: async () => ({ healthy: false, checks: { health: "<secret>" } }),
    })
  );
  await assert.rejects(monitor({ ...f.options, now: () => "bad" }));
  assert.ok(!f.events.some((e) => e.startsWith("POST:")));
});
