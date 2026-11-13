const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MonitorStore,
  emptyMonitorState,
  validateMonitorState,
} = require("../factory/monitor-state.cjs");
const {
  validateMonitorProof,
  proofFromIncident,
  verifyMonitorIssue,
} = require("../factory/monitor-origin.cjs");
const { createHash } = require("node:crypto");
const repository = "haideearus/cypress-realworld-app";
const id = "12345678-1234-4123-8123-123456789012";
const sha = "a".repeat(40);
function fixture() {
  const issue = {
    number: 50,
    title: "Monitor incident",
    body: "Fixed criteria",
    user: { login: "github-actions[bot]", type: "Bot" },
  };
  const incident = {
    id,
    at: "2026-11-13T20:00:00.000Z",
    day: "2026-11-13",
    phase: "open",
    recovered: false,
    source: { runId: "300", runAttempt: 1, workflowSha: sha },
    criteriaHash: createHash("sha256")
      .update(JSON.stringify([issue.title, issue.body]))
      .digest("hex"),
    issue: 50,
  };
  const state = { ...emptyMonitorState(), active: id, incidents: { [id]: incident } };
  const run = {
    id: 300,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    head_sha: sha,
    head_branch: "main",
    path: ".github/workflows/factory-monitor.yml",
    workflow_id: 60,
    run_attempt: 1,
    event: "schedule",
    actor: { login: "haideearus" },
    triggering_actor: { login: "haideearus" },
    status: "completed",
    conclusion: "success",
  };
  const jobs = {
    jobs: [
      {
        name: "monitor",
        status: "completed",
        conclusion: "success",
        steps: [{ name: "Observe production and publish incident", conclusion: "success" }],
      },
    ],
  };
  const calls = [];
  const api = {
    async request(method, path) {
      calls.push({ method, path });
      assert.equal(method, "GET");
      if (path.endsWith("/git/ref/heads/factory/monitor")) return { object: { sha } };
      if (path.includes("/contents/monitor.json?ref="))
        return {
          type: "file",
          encoding: "base64",
          content: Buffer.from(JSON.stringify(state)).toString("base64"),
        };
      if (path.endsWith("/actions/workflows/factory-monitor.yml"))
        return { id: 60, path: run.path };
      if (path.endsWith("/actions/runs/300/attempts/1")) return run;
      if (path.endsWith("/actions/runs/300/attempts/1/jobs?per_page=100")) return jobs;
      throw new Error("Unexpected fixture route");
    },
  };
  return { issue, incident, state, run, jobs, api, calls };
}
test("monitor state and immutable proof reject malformed provenance", () => {
  const f = fixture();
  assert.equal(validateMonitorState(f.state), f.state);
  const proof = proofFromIncident(f.incident);
  assert.equal(validateMonitorProof(proof), true);
  for (const change of [
    { issue: 0 },
    { runAttempt: 2 },
    { workflowSha: "main" },
    { criteriaHash: "bad" },
    { extra: true },
  ])
    assert.equal(validateMonitorProof({ ...proof, ...change }), false);
  assert.throws(() => validateMonitorState({ ...f.state, active: "missing" }));
  assert.throws(() => validateMonitorState({ ...f.state, repository: "other/repo" }));
});
test("only a successful trusted monitor receipt verifies; labels alone do not", async () => {
  const f = fixture();
  assert.deepEqual(await verifyMonitorIssue(f.api, f.issue), proofFromIncident(f.incident));
  assert.equal(await verifyMonitorIssue(f.api, { ...f.issue, number: 51 }), null);
  assert.equal(await verifyMonitorIssue(f.api, { ...f.issue, body: "Edited criteria" }), null);
  assert.equal(
    await verifyMonitorIssue(f.api, { ...f.issue, user: { login: "attacker", type: "User" } }),
    null
  );
});

test("orphaned pending or unrecovered incidents cannot authorize a new publication", () => {
  const f = fixture();
  assert.throws(() => validateMonitorState({ ...f.state, active: null }), /Invalid monitor/);
  f.incident.phase = "pending";
  f.incident.issue = null;
  assert.throws(() => validateMonitorState({ ...f.state, active: null }), /Invalid monitor/);
  f.incident.recovered = true;
  assert.throws(() => validateMonitorState(f.state), /Invalid monitor/);
  f.incident.phase = "open";
  f.incident.issue = 50;
  f.incident.recovered = false;
  const secondId = "22345678-1234-4123-8123-123456789012";
  f.state.incidents[secondId] = { ...f.incident, id: secondId, recovered: true };
  assert.throws(() => validateMonitorState(f.state), /Invalid monitor/);
});
test("failed, foreign, in-progress, rerun and wrong publisher proof are rejected", async () => {
  for (const patch of [
    { conclusion: "failure" },
    { status: "in_progress" },
    { head_branch: "feature" },
    { head_sha: "b".repeat(40) },
    { run_attempt: 2 },
    { workflow_id: 70 },
    { event: "pull_request" },
    { repository: { full_name: "other/repo" } },
    { actor: { login: "attacker" } },
  ]) {
    const f = fixture();
    Object.assign(f.run, patch);
    assert.equal(await verifyMonitorIssue(f.api, f.issue), null, JSON.stringify(patch));
  }
  const f = fixture();
  f.jobs.jobs[0].steps[0].conclusion = "failure";
  assert.equal(await verifyMonitorIssue(f.api, f.issue), null);
});
test("recovery stops new admission but preserves an already frozen receipt for merge", async () => {
  const f = fixture();
  const proof = proofFromIncident(f.incident);
  f.incident.recovered = true;
  f.state.active = null;
  assert.equal(await verifyMonitorIssue(f.api, f.issue), null);
  assert.deepEqual(
    await verifyMonitorIssue(f.api, f.issue, { proof, requireActive: false }),
    proof
  );
  assert.equal(
    await verifyMonitorIssue(f.api, f.issue, {
      proof: { ...proof, runId: "400" },
      requireActive: false,
    }),
    null
  );
});
test("a later skipped rerun cannot invalidate the recorded successful first attempt", async () => {
  const f = fixture();
  const original = f.api.request.bind(f.api);
  f.api.request = async (method, path) =>
    path.endsWith("/actions/runs/300")
      ? { ...f.run, run_attempt: 2, status: "completed", conclusion: "skipped" }
      : original(method, path);
  assert.deepEqual(await verifyMonitorIssue(f.api, f.issue), proofFromIncident(f.incident));
  assert.ok(f.calls.some((call) => call.path.endsWith("/actions/runs/300/attempts/1")));
});

test("missing monitor registry is untrusted; transport failures are not swallowed", async () => {
  const f = fixture();
  assert.equal(
    await verifyMonitorIssue(
      {
        request: async () => {
          throw Object.assign(new Error(), { status: 404 });
        },
      },
      f.issue
    ),
    null
  );
  await assert.rejects(
    verifyMonitorIssue(
      {
        request: async () => {
          throw Object.assign(new Error("unavailable"), { status: 503 });
        },
      },
      f.issue
    ),
    /unavailable/
  );
});
test("registry writes use append-only commits and a non-forced compare-and-swap", async () => {
  const calls = [];
  const api = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      return path.includes("refs") ? { object: { sha } } : { sha };
    },
  };
  const store = new MonitorStore(api);
  await store.save(emptyMonitorState(), sha);
  assert.equal(calls.at(-1).method, "PATCH");
  assert.deepEqual(calls.at(-1).body, { sha, force: false });
  assert.deepEqual(calls.find((c) => c.path.endsWith("/git/commits")).body.parents, [sha]);
  calls.length = 0;
  await store.save(emptyMonitorState(), null);
  assert.deepEqual(calls.at(-1).body, { ref: "refs/heads/factory/monitor", sha });
});
