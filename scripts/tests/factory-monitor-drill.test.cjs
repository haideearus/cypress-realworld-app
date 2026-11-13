const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../factory/policy.cjs");
const { vars } = require("./helpers/factory-fixtures.cjs");
const { emptyMonitorState } = require("../factory/monitor-state.cjs");
const { DrillCoordinator } = require("../factory/monitor-drill.cjs");
const { verifyRepair } = require("../factory/drill-verify.cjs");
const { brokenSource, implementationPath } = require("../factory/drill-fixture.cjs");
const repo = policy.REPOSITORY;
const sha = "a".repeat(40);
const seed = "b".repeat(40);
const context = {
  repository: repo,
  actor: policy.OWNER,
  triggeringActor: policy.OWNER,
  ref: "refs/heads/main",
  event: "workflow_dispatch",
  runId: "700",
  runAttempt: 1,
  workflowRef: `${repo}/.github/workflows/factory-monitor-drill.yml@refs/heads/main`,
  workflowSha: sha,
  sha,
};
const baseline = {
  healthy: false,
  checks: { health: "ok", readiness: "failed", frontend: "ok", regression: "failed" },
  attempts: 1,
  release: sha,
};
function fixture(overrides = {}) {
  let state = policy.emptyState(repo);
  let monitor = emptyMonitorState();
  let monitorCommit = null;
  let serial = 1;
  let issue;
  const calls = [];
  const store = {
    async read() {
      return { state: structuredClone(monitor), commit: monitorCommit };
    },
    async save(next, parent) {
      assert.equal(parent, monitorCommit);
      monitor = structuredClone(next);
      monitorCommit = String(++serial).padStart(40, "0");
      return monitorCommit;
    },
  };
  const ledger = {
    async read() {
      return { state: structuredClone(state), commit: "c".repeat(40) };
    },
    async update(fn) {
      const result = await fn(structuredClone(state));
      policy.validateState(result.state);
      state = structuredClone(result.state);
      return result;
    },
  };
  const api = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (method === "GET" && path.includes("/labels/")) return { name: "factory-drill" };
      if (method === "GET" && path.includes("/git/ref/heads/factory/drill-"))
        throw Object.assign(new Error("missing"), { status: 404 });
      if (method === "GET" && path.endsWith(`/git/commits/${sha}`))
        return { sha, tree: { sha: "d".repeat(40) } };
      if (method === "POST" && /\/git\/(blobs|trees)$/.test(path)) return { sha: "d".repeat(40) };
      if (method === "POST" && path.endsWith("/git/commits")) return { sha: seed };
      if (method === "POST" && path.endsWith("/git/refs"))
        return { ref: body.ref, object: { sha: seed } };
      if (method === "POST" && path.endsWith("/issues")) {
        if (overrides.ambiguousIssue) throw new Error("ambiguous publication");
        issue = {
          ...body,
          number: 80,
          state: "open",
          user: { login: "github-actions[bot]", type: "Bot" },
        };
        return structuredClone(issue);
      }
      if (method === "GET" && path.endsWith("/issues/80")) return structuredClone(issue);
      if (method === "PATCH" && path.endsWith("/issues/80")) {
        issue.state = body.state;
        return structuredClone(issue);
      }
      if (method === "GET" && path.endsWith("/attempts/1"))
        return {
          id: 700,
          run_attempt: 1,
          event: "workflow_dispatch",
          head_branch: "main",
          head_sha: sha,
          path: ".github/workflows/factory-monitor-drill.yml",
          repository: { full_name: repo },
          head_repository: { full_name: repo },
          actor: { login: policy.OWNER },
          triggering_actor: { login: policy.OWNER },
        };
      if (method === "GET" && path.includes("/attempts/1/jobs"))
        return {
          total_count: 3,
          jobs: [
            {
              name: "Preview or PC shutdown window",
              status: "completed",
              conclusion: "success",
              steps: [
                {
                  name: "Allow 90 seconds for the owner to shut down their PC",
                  conclusion: "success",
                  started_at: "2026-11-14T00:55:00Z",
                  completed_at: "2026-11-14T00:56:30Z",
                },
              ],
            },
            {
              name: "coding / agent",
              id: 701,
              runner_id: 10,
              runner_name: "GitHub Actions 10",
              labels: ["ubuntu-latest"],
              status: overrides.running ? "in_progress" : "completed",
              conclusion: overrides.modelFailure ? "failure" : "success",
              steps: [
                {
                  name: "Run the one reserved Claude subscription session",
                  conclusion: "success",
                  started_at: "2026-11-14T00:59:00Z",
                  completed_at: "2026-11-14T01:00:00Z",
                },
              ],
            },
            {
              name: "Verify isolated recovery",
              id: 702,
              runner_id: 11,
              runner_name: "GitHub Actions 11",
              labels: ["ubuntu-24.04"],
              status: "completed",
              conclusion: overrides.modelFailure ? "skipped" : "success",
              steps: [
                {
                  name: "Measure baseline and candidate in the isolated sandbox",
                  conclusion: "success",
                },
              ],
            },
          ],
        };
      throw new Error(`Unexpected ${method} ${path}`);
    },
  };
  const config = policy.readConfig({
    ...vars,
    FACTORY_AUTOMATION_ENABLED: "false",
    FACTORY_AUTOMERGE_ENABLED: "false",
    ...overrides.vars,
  });
  const coordinator = new DrillCoordinator(
    api,
    config,
    { ...context, ...overrides.context },
    {
      ledger,
      store,
      check: async () => ({ ...baseline, ...overrides.baseline }),
      now: () => "2026-11-14T01:00:00.000Z",
    }
  );
  return {
    coordinator,
    calls,
    get state() {
      return state;
    },
    get monitor() {
      return monitor;
    },
    get issue() {
      return issue;
    },
  };
}
test("drill preview and disabled dispatch do not mutate external state", async () => {
  for (const enabled of ["true", "false"]) {
    const f = fixture({ vars: { FACTORY_ENABLED: enabled } });
    assert.equal((await f.coordinator.preview()).outcome, "preview");
    assert.equal(f.calls.length, 0);
    if (enabled === "false") assert.equal((await f.coordinator.prepare()).outcome, "disabled");
    assert.equal(f.calls.length, 0);
  }
});
test("untrusted contexts, enabled automatic pickup, or healthy baseline cannot publish a drill", async () => {
  for (const override of [
    { context: { runAttempt: 2 } },
    { context: { actor: "stranger" } },
    { context: { workflowSha: seed } },
    {
      vars: {
        FACTORY_AUTOMATION_ENABLED: "true",
        FACTORY_GITHUB_APP_CLIENT_ID: "Iv23livBU0LjCX2pzBlV",
        FACTORY_GITHUB_APP_SLUG: "test",
      },
    },
    { baseline: { healthy: true } },
  ]) {
    const f = fixture(override);
    await assert.rejects(() => f.coordinator.prepare());
    assert.equal(
      f.calls.some((x) => x.method !== "GET"),
      false
    );
  }
});
test("preparation creates one isolated branch, deduplicated issue, and one honest coding grant", async () => {
  const f = fixture();
  const prepared = await f.coordinator.prepare();
  assert.equal(prepared.ready, true);
  assert.equal(prepared.head, seed);
  assert.equal(prepared.ticket, 80);
  assert.equal(prepared.deduplicated, true);
  assert.deepEqual(f.issue.labels, ["factory-drill"]);
  assert.equal(f.calls.filter((x) => x.method === "POST" && x.path.endsWith("/issues")).length, 1);
  assert.equal(f.state.tickets[80].origin, "drill");
  assert.equal(f.state.tickets[80].coding, 1);
  assert.equal(f.state.tickets[80].reviews, 0);
  assert.equal(Object.keys(f.state.grants).length, 1);
  assert.deepEqual(f.state.days["2026-11-14"], [80]);
  await assert.rejects(() => f.coordinator.prepare());
  assert.equal(Object.keys(f.state.grants).length, 1);
});
test("ambiguous issue POST preserves intent, never reserves or retries publication", async () => {
  const f = fixture({ ambiguousIssue: true });
  await assert.rejects(() => f.coordinator.prepare());
  assert.equal(f.monitor.incidents[f.monitor.active].phase, "pending");
  assert.equal(Object.keys(f.state.grants).length, 0);
  await assert.rejects(() => f.coordinator.prepare());
  assert.equal(f.calls.filter((x) => x.method === "POST" && x.path.endsWith("/issues")).length, 1);
});
test("terminal failed model consumes its grant and leaves the incident unresolved", async () => {
  const f = fixture({ modelFailure: true });
  const prepared = await f.coordinator.prepare();
  const result = await f.coordinator.finalize({ prepared });
  assert.equal(result.outcome, "blocked");
  assert.equal(f.state.active, null);
  assert.equal(f.state.tickets[80].coding, 1);
  assert.equal(f.state.tickets[80].status, "blocked");
  assert.equal(f.issue.state, "open");
  assert.ok(f.monitor.active);
});
test("a still-running model cannot have its reservation released", async () => {
  const f = fixture({ running: true });
  const prepared = await f.coordinator.prepare();
  await assert.rejects(() => f.coordinator.finalize({ prepared }));
  assert.equal(f.state.active.ticket, 80);
  assert.equal(f.state.grants[prepared.grantId].status, "reserved");
});
async function passing(prepared) {
  const bundle = {
    kind: "code",
    grantId: prepared.grantId,
    base: prepared.head,
    files: [
      {
        path: implementationPath,
        mode: "100644",
        content: brokenSource.replace('? "unavailable"', '? "ok"'),
      },
    ],
    evidence: "Changed readiness response only. Trusted verifier executes the tests.",
  };
  let attempt = 0;
  const report = await verifyRepair({
    ...prepared.identity,
    bundle,
    now: () => "2026-11-14T01:00:00.000Z",
    check: async () =>
      ++attempt === 1
        ? { ...baseline, release: seed }
        : {
            healthy: true,
            checks: { health: "ok", readiness: "ok", frontend: "ok", regression: "ok" },
            attempts: 1,
            release: seed,
          },
  });
  return { bundle, report };
}
test("measured success closes only the drill and retains consumed usage without approval", async () => {
  const f = fixture();
  const prepared = await f.coordinator.prepare();
  const evidence = await passing(prepared);
  const result = await f.coordinator.finalize({ prepared, ...evidence });
  assert.equal(result.outcome, "drill_complete");
  assert.equal(f.monitor.active, null);
  assert.equal(f.monitor.incidents[prepared.incidentId].recovered, true);
  assert.equal(f.issue.state, "closed");
  assert.equal(f.state.active, null);
  assert.equal(f.state.tickets[80].coding, 1);
  assert.equal(f.state.tickets[80].status, "drill_complete");
  assert.equal(f.state.tickets[80].approval, null);
  assert.equal(f.state.tickets[80].pr, null);
  assert.equal(result.countersAfter.daily, 1);
  assert.equal(result.productionApproval, false);
  assert.equal(result.cloud.shutdownWindow.startedAt, "2026-11-14T00:55:00.000Z");
  assert.equal(result.cloud.coding.runnerName, "GitHub Actions 10");
  assert.equal(result.cloud.coding.sessionFinishedAt, "2026-11-14T01:00:00.000Z");
  assert.equal(f.calls.filter((c) => c.method === "PATCH").length, 1);
  await assert.rejects(() => f.coordinator.finalize({ prepared, ...evidence }));
});
test("finalizer binds reports to the ledger, not self-consistent caller supplied identity", async () => {
  for (const field of ["grantId", "runId", "workflowSha", "seedSha"]) {
    const f = fixture();
    const prepared = await f.coordinator.prepare();
    const { bundle, report } = await passing(prepared);
    const altered =
      field === "grantId"
        ? "11111111-1111-4111-8111-111111111111"
        : field === "runId"
          ? "999"
          : "f".repeat(40);
    prepared.identity[field] = altered;
    report[field] = altered;
    if (field === "seedSha") {
      prepared.identity.head = altered;
      report.baseline.release = altered;
      report.candidate.release = altered;
    }
    await assert.rejects(() => f.coordinator.finalize({ prepared, bundle, report }));
    assert.equal(f.issue.state, "open");
    assert.equal(f.state.grants[prepared.grantId].status, "reserved");
  }
});
test("edited issue or report digest never authorizes recovery", async () => {
  for (const change of ["issue", "digest"]) {
    const f = fixture();
    const prepared = await f.coordinator.prepare();
    const { bundle, report } = await passing(prepared);
    if (change === "issue") f.issue.body += " changed after reservation";
    else report.bundleSha256 = "f".repeat(64);
    await assert.rejects(() => f.coordinator.finalize({ prepared, bundle, report }));
    assert.equal(f.issue.state, "open");
    assert.equal(f.monitor.incidents[prepared.incidentId].recovered, false);
  }
});
