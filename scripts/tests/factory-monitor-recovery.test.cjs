const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const policy = require("../factory/policy.cjs");
const { ROOT } = require("../factory/github.cjs");
const { validateMonitorState } = require("../factory/monitor-state.cjs");
const { proofFromIncident } = require("../factory/monitor-proof.cjs");
const { vars, context: base } = require("./helpers/factory-fixtures.cjs");
const at = "2026-11-16T00:10:00.000Z",
  head = "a".repeat(40),
  merge = "c".repeat(40),
  source = "b".repeat(40),
  workflowSha = "d".repeat(40);
function fixture() {
  const context = {
    repository: policy.REPOSITORY,
    actor: policy.OWNER,
    triggeringActor: policy.OWNER,
    ref: "refs/heads/main",
    eventName: "schedule",
    workflowRef: `${policy.REPOSITORY}/.github/workflows/factory-monitor.yml@refs/heads/main`,
    workflowSha,
    sha: workflowSha,
    runId: "900",
    runAttempt: 1,
  };
  const issue = {
    number: 64,
    state: "open",
    title: "Production monitor incident",
    body: "Fixed acceptance criteria",
    user: { login: "github-actions[bot]", type: "Bot" },
  };
  const incident = {
    id: "12345678-1234-4123-8123-123456789012",
    at: "2026-11-16T00:00:00.000Z",
    day: "2026-11-16",
    phase: "open",
    recovered: false,
    source: { runId: "700", runAttempt: 1, workflowSha: source },
    criteriaHash: createHash("sha256")
      .update(JSON.stringify([issue.title, issue.body]))
      .digest("hex"),
    issue: 64,
    probeMode: "feed-contract",
  };
  const registry = {
    version: 1,
    repository: policy.REPOSITORY,
    active: incident.id,
    incidents: { [incident.id]: incident },
  };
  const request = {
    ...base,
    ticket: 64,
    head,
    event: "schedule",
    workflowRef: `${policy.REPOSITORY}/.github/workflows/factory-automatic.yml@refs/heads/main`,
    workflowSha,
  };
  const config = { ...policy.readConfig(vars), automatic: true, appSlug: "fixture-factory" };
  let r = policy.reserve(
    policy.emptyState(policy.REPOSITORY),
    request,
    config,
    new Date(incident.at)
  );
  Object.assign(r.state.tickets["64"], {
    criteriaHash: incident.criteriaHash,
    monitor: proofFromIncident(incident),
    automatic: {
      workflowRef: request.workflowRef,
      workflowSha,
      runId: request.runId,
      runAttempt: 1,
      appSlug: "fixture-factory",
    },
  });
  let state = policy.finish(r.state, r.grant.id, { status: "awaiting_review", head, pr: 20 });
  r = policy.reserve(state, { ...request, phase: "review" }, config);
  state = policy.finish(r.state, r.grant.id, {
    status: "reviewed",
    head,
    pr: 20,
    verdict: "pass",
    evidence: `https://github.com/${policy.REPOSITORY}/actions/runs/100`,
  });
  state.tickets["64"].ci = {
    head,
    passed: true,
    runId: 400,
    requestId: "22222222-2222-4222-8222-222222222222",
  };
  state.tickets["64"].merge = {
    status: "merged",
    head,
    pr: 20,
    at: "2026-11-16T00:04:00.000Z",
    runId: "100",
    runAttempt: 1,
    mergeCommit: merge,
  };
  const pr = {
    number: 20,
    state: "closed",
    merged: true,
    merge_commit_sha: merge,
    merged_at: "2026-11-16T00:04:00.000Z",
    head: { sha: head, ref: "agent/factory-64", repo: { full_name: policy.REPOSITORY } },
    base: { ref: "main", repo: { full_name: policy.REPOSITORY } },
    user: { login: "fixture-factory[bot]" },
  };
  const workflow = (name, id) => ({ id, path: `.github/workflows/${name}.yml` });
  const run = (id, name, wid, sha, event = "workflow_run") => ({
    id,
    workflow_id: wid,
    path: `.github/workflows/${name}.yml`,
    head_sha: sha,
    head_branch: "main",
    repository: { full_name: policy.REPOSITORY },
    head_repository: { full_name: policy.REPOSITORY },
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    event,
    actor: { login: policy.OWNER },
    triggering_actor: { login: policy.OWNER },
    created_at: "2026-11-16T00:05:00.000Z",
  });
  const monitorRun = run(700, "factory-monitor", 11, source, "schedule");
  const ci = run(500, "factory-ci", 22, merge, "push");
  const deploy = run(600, "factory-deploy", 33, merge);
  deploy.display_title = "Production deployment / CI 500";
  const auto = run(100, "factory-automatic", 44, workflowSha, "schedule");
  const job = (name, sha, steps = []) => ({
    name,
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    steps: steps.map((name) => ({ name, status: "completed", conclusion: "success" })),
  });
  const jobs = {
    700: [job("monitor", source, ["Observe production and publish incident"])],
    500: [job("verify", merge)],
    600: [
      job("prepare", merge, ["Validate tested commit without deployment credentials"]),
      job(`Deploy tested commit ${merge}`, merge, [
        "Revalidate human approval, deploy once, and verify the live release",
      ]),
    ],
    100: [
      job("cycle1 / review / agent", workflowSha, [
        "Run the one reserved Claude subscription session",
      ]),
      job("cycle1 / assess", workflowSha),
    ],
  };
  const approvals = [
    {
      state: "approved",
      user: { login: policy.OWNER, type: "User" },
      environments: [{ id: 1, name: "production" }],
    },
  ];
  const observation = {
    healthy: true,
    checks: { health: "ok", readiness: "ok", frontend: "ok" },
    attempts: 1,
    release: merge,
    appChecks: {
      healthy: true,
      checks: { login: "ok", session: "ok", feed: "ok", logout: "ok" },
      attempts: 1,
      feedContract: "ok",
      releases: { before: merge, after: merge },
    },
  };
  const calls = [];
  let sequence = 0,
    monitorCommit = "e".repeat(40),
    failClose = false,
    failFinal = false;
  const store = {
    read: async () => ({ state: structuredClone(registry), commit: monitorCommit }),
    save: async (next, parent) => {
      assert.equal(parent, monitorCommit);
      validateMonitorState(next);
      if (failFinal && next.active === null) throw Error("lost registry write");
      Object.assign(registry, structuredClone(next));
      monitorCommit = String(++sequence).padStart(40, "0");
      return monitorCommit;
    },
  };
  const f = {
    context,
    issue,
    incident,
    registry,
    state,
    pr,
    ci,
    deploy,
    auto,
    monitorRun,
    jobs,
    approvals,
    observation,
    calls,
    store,
    api: null,
    now: () => at,
  };
  f.api = {
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      const p = new URL("https://api.github.com" + path);
      const suffix = p.pathname.slice(ROOT.length);
      if (method === "PATCH" && suffix === "/issues/64") {
        Object.assign(issue, { state: body.state, state_reason: body.state_reason });
        if (failClose) throw Error("lost close response");
        return structuredClone(issue);
      }
      assert.equal(method, "GET", "verifier must have no write capability");
      if (suffix === "/issues/64") return structuredClone(issue);
      if (suffix === "/pulls/20") return structuredClone(pr);
      if (suffix === "/git/ref/heads/factory/state") return { object: { sha: "f".repeat(40) } };
      if (suffix === "/contents/state.json")
        return {
          type: "file",
          encoding: "base64",
          content: Buffer.from(JSON.stringify(state)).toString("base64"),
        };
      if (suffix === "/git/ref/heads/factory/monitor") return { object: { sha: monitorCommit } };
      if (suffix === "/contents/monitor.json")
        return {
          type: "file",
          encoding: "base64",
          content: Buffer.from(JSON.stringify(registry)).toString("base64"),
        };
      for (const [name, id] of [
        ["factory-monitor", 11],
        ["factory-ci", 22],
        ["factory-deploy", 33],
        ["factory-automatic", 44],
      ])
        if (suffix === `/actions/workflows/${name}.yml`) return workflow(name, id);
      if (suffix === "/actions/workflows/factory-deploy.yml/runs")
        return { total_count: 1, workflow_runs: [structuredClone(deploy)] };
      if (suffix === "/actions/workflows/factory-ci.yml/runs")
        return { total_count: 1, workflow_runs: [structuredClone(ci)] };
      if (suffix.startsWith("/contents/.github/workflows/"))
        return { type: "file", sha: "f".repeat(40) };
      const m = /^\/actions\/runs\/(\d+)(?:\/attempts\/1)?$/.exec(suffix);
      if (m) return structuredClone({ 100: auto, 500: ci, 600: deploy, 700: monitorRun }[m[1]]);
      const j = /^\/actions\/runs\/(\d+)\/attempts\/1\/jobs$/.exec(suffix);
      if (j) return { total_count: jobs[j[1]].length, jobs: structuredClone(jobs[j[1]]) };
      if (suffix === "/actions/runs/600/approvals") return structuredClone(approvals);
      throw Error("Unexpected proof route " + suffix);
    },
  };
  f.failClose = () => {
    failClose = true;
  };
  f.failFinal = () => {
    failFinal = true;
  };
  f.allowFinal = () => {
    failFinal = false;
  };
  return f;
}
test("a real ledger approval, merged repair, named-approved deployment and matching live mode verify read-only", async () => {
  const { verifyRepair } = require("../factory/monitor-recovery.cjs");
  const f = fixture();
  const before = JSON.stringify(f.state);
  const proof = await verifyRepair(f);
  assert.equal(proof.pr, 20);
  assert.equal(proof.mergeCommit, merge);
  assert.equal(proof.deployRunId, "600");
  assert.equal(proof.probeMode, "feed-contract");
  assert.equal(JSON.stringify(f.state), before);
  assert.ok(f.calls.every((c) => c.method === "GET"));
});
test("unreviewed, wrong-source, wrong-release or unapproved repairs cannot close an issue", async () => {
  const { verifyRepair } = require("../factory/monitor-recovery.cjs");
  for (const change of [
    (f) => (f.issue.body += " changed"),
    (f) => (f.issue.user.login = "attacker"),
    (f) => (f.observation.release = head),
    (f) => delete f.observation.appChecks.feedContract,
    (f) => (f.observation.appChecks.feedContract = "failed"),
    (f) => (f.state.tickets["64"].approval = null),
    (f) => (f.state.tickets["64"].approval.fixture = true),
    (f) => (f.state.tickets["64"].merge.mergeCommit = head),
    (f) => (f.state.active = { ticket: 64, runId: "100", runAttempt: 1 }),
    (f) => (f.pr.merged = false),
    (f) => (f.pr.head.sha = source),
    (f) => (f.pr.base.ref = "develop"),
    (f) => (f.ci.conclusion = "failure"),
    (f) => (f.deploy.path = ".github/workflows/foreign.yml"),
    (f) => (f.deploy.run_attempt = 2),
    (f) => (f.deploy.display_title = "Production deployment / CI 999"),
    (f) => (f.deploy.head_repository.full_name = "attacker/repo"),
    (f) => (f.deploy.conclusion = "failure"),
    (f) => (f.jobs[600][1].steps[0].conclusion = "skipped"),
    (f) => (f.approvals[0].user.login = "attacker"),
    (f) => (f.approvals[0].state = "rejected"),
    (f) => (f.approvals[0].environments[0].name = "staging"),
    (f) => (f.auto.conclusion = "cancelled"),
    (f) => (f.jobs[100][0].conclusion = "skipped"),
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(() => verifyRepair(f));
    assert.ok(f.calls.every((c) => c.method === "GET"));
  }
});
test("retirement records intent before close and confirms completed state before clearing the active pointer", async () => {
  const { retireIncident } = require("../factory/monitor-recovery.cjs");
  const f = fixture();
  const original = JSON.stringify(f.state);
  const result = await retireIncident(f);
  assert.equal(result.outcome, "incident_retired");
  assert.equal(f.issue.state, "closed");
  assert.equal(f.registry.active, null);
  assert.equal(f.registry.incidents[f.incident.id].retirement.phase, "complete");
  assert.equal(JSON.stringify(f.state), original);
  assert.deepEqual(
    f.calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path, c.body]),
    [["PATCH", ROOT + "/issues/64", { state: "closed", state_reason: "completed" }]]
  );
});
test("lost issue-close or final registry responses retain intent and reconcile without duplicate publication", async () => {
  const { retireIncident } = require("../factory/monitor-recovery.cjs");
  for (const mode of ["close", "save"]) {
    const f = fixture();
    if (mode === "close") f.failClose();
    else f.failFinal();
    await assert.rejects(() => retireIncident(f));
    assert.equal(f.registry.active, f.incident.id);
    assert.equal(f.registry.incidents[f.incident.id].retirement.phase, "intent");
    f.allowFinal();
    const result = await retireIncident(f);
    assert.equal(result.outcome, "incident_retired");
    assert.equal(f.registry.active, null);
    assert.equal(f.calls.filter((c) => c.method === "PATCH").length, 1);
  }
});
test("a manually closed issue with missing deployment evidence does not retire or reset budget", async () => {
  const { retireIncident } = require("../factory/monitor-recovery.cjs");
  const f = fixture();
  f.issue.state = "closed";
  f.deploy.conclusion = "failure";
  const before = JSON.stringify(f.state);
  await assert.rejects(() => retireIncident(f));
  assert.equal(f.registry.active, f.incident.id);
  assert.equal(JSON.stringify(f.state), before);
  assert.ok(f.calls.every((c) => c.method === "GET"));
});
test("signed-in checks from a different release cannot retire the later availability release", async () => {
  const { verifyRepair } = require("../factory/monitor-recovery.cjs");
  const f = fixture();
  f.observation.appChecks.releases = { before: head, after: head };
  await assert.rejects(() => verifyRepair(f));
  assert.ok(f.calls.every((c) => c.method === "GET"));
});
test("unbound legacy journey remains observable but cannot certify a repaired deployment", async () => {
  const { verifyRepair } = require("../factory/monitor-recovery.cjs");
  const f = fixture();
  delete f.incident.probeMode;
  f.state.tickets["64"].monitor = proofFromIncident(f.incident);
  delete f.observation.appChecks.feedContract;
  delete f.observation.appChecks.releases;
  await assert.rejects(() => verifyRepair(f));
});
test("another ticket's approval cannot mask a wrong review grant on this incident", async () => {
  const { verifyRepair } = require("../factory/monitor-recovery.cjs");
  const f = fixture();
  const r = policy.reserve(
    f.state,
    { ...base, ticket: 65, phase: "review", slot: "existing", origin: "owner-pr", pr: 20, head },
    policy.readConfig(vars)
  );
  Object.assign(
    f.state,
    policy.finish(r.state, r.grant.id, {
      status: "reviewed",
      head,
      pr: 20,
      verdict: "pass",
      evidence: `https://github.com/${policy.REPOSITORY}/actions/runs/100`,
    })
  );
  const code = Object.values(f.state.grants).find((g) => g.ticket === 64 && g.phase === "code");
  f.state.tickets["64"].approval.grant = code.id;
  assert.equal(
    policy.reviewGate(f.state, { number: 20, head }).ok,
    true,
    "the other ticket covers this PR in the generic gate"
  );
  await assert.rejects(() => verifyRepair(f));
});
test("production monitor retires once and repeated healthy observations keep history without further writes", async () => {
  const { monitor } = require("../factory/monitor.cjs");
  const f = fixture();
  const args = {
    ...f,
    enabled: true,
    dryRun: false,
    probe: async () => f.observation,
    appChecks: f.observation.appChecks,
  };
  const before = JSON.stringify(f.state);
  assert.equal((await monitor(args)).outcome, "incident_retired");
  const count = f.calls.length;
  assert.equal((await monitor(args)).outcome, "healthy");
  assert.equal(f.calls.length, count);
  assert.equal(Object.keys(f.registry.incidents).length, 1);
  assert.equal(JSON.stringify(f.state), before);
});
