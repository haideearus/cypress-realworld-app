const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const { prepareCandidate, performDeployment } = require("../factory/deploy.cjs");

const repo = "haideearus/cypress-realworld-app";
const root = `/repos/${repo}`;
const sha = "a".repeat(40);
function fixture() {
  const context = {
    repository: repo,
    ref: "refs/heads/main",
    workflowRef: `${repo}/.github/workflows/factory-deploy.yml@refs/heads/main`,
    workflowSha: sha,
    sha,
    runId: "200",
    runAttempt: "1",
    eventName: "workflow_dispatch",
    actor: "haideearus",
    triggeringActor: "haideearus",
  };
  const run = {
    id: 100,
    workflow_id: 10,
    path: ".github/workflows/factory-ci.yml",
    event: "push",
    head_branch: "main",
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    repository: { full_name: repo },
    head_repository: { full_name: repo },
  };
  const jobs = [{ name: "verify", head_sha: sha, status: "completed", conclusion: "success" }];
  const approvals = [
    {
      state: "approved",
      user: { login: "haideearus", type: "User" },
      environments: [{ id: 77, name: "production", created_at: "2020-01-01" }],
      comment: "untrusted comment must never reach evidence",
    },
  ];
  const main = { object: { sha } };
  const requests = [];
  const api = {
    async request(method, url) {
      requests.push({ method, url });
      assert.equal(method, "GET");
      if (url === `${root}/actions/workflows/factory-ci.yml`) return { id: 10, path: run.path };
      if (url === `${root}/actions/runs/100`) return structuredClone(run);
      if (url === `${root}/git/ref/heads/main`) return main;
      if (url === `${root}/actions/runs/200/approvals`) return approvals;
      throw new Error(`Unexpected request ${url}`);
    },
    async pages(url, key) {
      assert.equal(url, `${root}/actions/runs/100/attempts/${run.run_attempt}/jobs`);
      assert.equal(key, "jobs");
      return jobs;
    },
  };
  return {
    api,
    context,
    event: { inputs: { ci_run_id: "100" } },
    ciRunId: "100",
    run,
    jobs,
    approvals,
    main,
    requests,
  };
}
function deployment(f) {
  const calls = [];
  return {
    ...f,
    expectedSha: sha,
    expectedCiAttempt: "1",
    hook: "private-hook-secret",
    evidence: {},
    now: () => "2026-11-13T20:00:00.000Z",
    calls,
    trigger: async (args) => {
      calls.push(["trigger", args]);
      return { httpStatus: 200, deployId: "dep-example", malicious: "secret" };
    },
    verify: async (args) => {
      calls.push(["verify", args]);
      return {
        release: sha,
        health: true,
        ready: true,
        frontend: true,
        observedAt: "2026-11-13T20:01:00.000Z",
        malicious: "secret",
      };
    },
  };
}

test("candidate is the successful main push verified by the real CI job", async () => {
  const f = fixture();
  assert.deepEqual(await prepareCandidate(f), { sha, ciRunId: "100", ciAttempt: 1 });
});

test("automatic trigger accepts the factory App actor but validates the upstream run", async () => {
  const f = fixture();
  Object.assign(f.context, {
    eventName: "workflow_run",
    actor: "haideearus-software-factory[bot]",
  });
  f.event = { workflow_run: { id: 100 } };
  assert.equal((await prepareCandidate(f)).sha, sha);
  f.event.workflow_run.id = 999;
  await assert.rejects(prepareCandidate(f), /ci_input_mismatch/);
});

test("foreign repository/ref/workflow and deployment reruns fail before any API call", async () => {
  for (const [key, value] of [
    ["repository", "other/repo"],
    ["ref", "refs/heads/agent/test"],
    ["workflowRef", `${repo}/.github/workflows/other.yml@refs/heads/main`],
    ["workflowSha", "bad"],
    ["sha", "b".repeat(40)],
    ["runAttempt", "2"],
    ["runId", "../1"],
    ["eventName", "pull_request"],
    ["actor", "outsider"],
    ["triggeringActor", "outsider"],
  ]) {
    const f = fixture();
    f.context[key] = value;
    await assert.rejects(prepareCandidate(f));
    assert.equal(f.requests.length, 0, key);
  }
});

test("CI input rejects malformed values before constructing API paths", async () => {
  for (const id of ["", "0", "01", "1/approvals", "100\n", "9007199254740992"]) {
    const f = fixture();
    f.ciRunId = id;
    f.event.inputs.ci_run_id = id;
    await assert.rejects(prepareCandidate(f));
    assert.equal(f.requests.length, 0);
  }
});

test("PR/fork/failed/skipped/wrong-workflow CI and stale main never authorize deployment", async () => {
  for (const patch of [
    { event: "pull_request" },
    { event: "workflow_dispatch" },
    { head_branch: "feature" },
    { repository: { full_name: "other/repo" } },
    { head_repository: { full_name: "other/repo" } },
    { status: "in_progress" },
    { conclusion: "failure" },
    { conclusion: "skipped" },
    { workflow_id: 20 },
    { path: "other.yml" },
    { head_sha: "b".repeat(40) },
    { id: 999 },
    { run_attempt: 0 },
  ]) {
    const f = fixture();
    Object.assign(f.run, patch);
    const d = deployment(f);
    await assert.rejects(performDeployment(d));
    assert.equal(d.calls.length, 0);
  }
  const f = fixture();
  f.main.object.sha = "b".repeat(40);
  await assert.rejects(prepareCandidate(f), /stale_candidate/);
});

test("successful empty or skipped CI does not substitute for the required verify job", async () => {
  for (const rows of [
    [],
    [{ name: "other", conclusion: "success" }],
    [{ name: "verify", status: "completed", conclusion: "skipped", head_sha: sha }],
    [{ name: "verify", status: "completed", conclusion: "success", head_sha: "b".repeat(40) }],
  ]) {
    const f = fixture();
    f.jobs.splice(0, f.jobs.length, ...rows);
    await assert.rejects(prepareCandidate(f), /ci_verify_missing/);
  }
});

test("deploy requires a unique named human production approval, never just an actor or secret", async () => {
  for (const mutate of [
    (f) => f.approvals.splice(0),
    (f) => {
      f.approvals[0].state = "rejected";
    },
    (f) => {
      f.approvals[0].user.login = "someone-else";
    },
    (f) => {
      f.approvals[0].user.type = "Bot";
    },
    (f) => {
      f.approvals[0].environments[0].name = "staging";
    },
    (f) => f.approvals.push(structuredClone(f.approvals[0])),
  ]) {
    const f = fixture();
    mutate(f);
    const d = deployment(f);
    await assert.rejects(performDeployment(d), /approval_required/);
    assert.equal(d.calls.length, 0);
  }
});

test("approval is audited without inventing an approval timestamp or retaining comments", async () => {
  const d = deployment(fixture());
  await performDeployment(d);
  assert.deepEqual(
    d.calls.map((x) => x[0]),
    ["trigger", "verify"]
  );
  assert.equal(d.calls[0][1].sha, sha);
  assert.equal(d.evidence.outcome, "verified");
  assert.equal(d.evidence.approval.actor, "haideearus");
  assert.equal(d.evidence.approval.observedAt, "2026-11-13T20:00:00.000Z");
  assert.doesNotMatch(
    JSON.stringify(d.evidence),
    /private-hook-secret|untrusted comment|malicious|2020-01-01|approved_at/
  );
});

test("a failed-job rerun cannot reuse saved preparation outputs and approval", async () => {
  const d = deployment(fixture());
  d.context.runAttempt = "2";
  await assert.rejects(performDeployment(d), /untrusted_context/);
  assert.equal(d.calls.length, 0);
  assert.equal(d.requests.length, 0);
});

test("changed expected commit or CI attempt stops before the hook", async () => {
  for (const patch of [{ expectedSha: "b".repeat(40) }, { expectedCiAttempt: "2" }]) {
    const d = deployment(fixture());
    Object.assign(d, patch);
    await assert.rejects(performDeployment(d), /candidate_changed/);
    assert.equal(d.calls.length, 0);
  }
});

test("main advancing while approval is fetched is rechecked before the hook", async () => {
  const d = deployment(fixture());
  const request = d.api.request;
  d.api.request = async (method, url) => {
    const result = await request(method, url);
    if (url.endsWith("/approvals")) d.main.object.sha = "b".repeat(40);
    return result;
  };
  await assert.rejects(performDeployment(d), /stale_candidate/);
  assert.equal(d.calls.length, 0);
});

test("ambiguous hook failure is attempted only once and health cannot turn it green", async () => {
  const d = deployment(fixture());
  let posts = 0;
  d.trigger = async () => {
    posts++;
    throw new Error("network timeout");
  };
  await assert.rejects(performDeployment(d));
  assert.equal(posts, 1);
  assert.equal(d.calls.length, 0);
  assert.equal(d.evidence.hookAttempted, true);
  assert.notEqual(d.evidence.outcome, "verified");
});

test("a hook accepted response is not deployment success without live verification", async () => {
  const d = deployment(fixture());
  d.verify = async () => {
    throw new Error("old release");
  };
  await assert.rejects(performDeployment(d));
  assert.equal(d.evidence.phase, "verify_release");
  assert.notEqual(d.evidence.outcome, "verified");
});

test("workflow isolates hook behind approval, never executes PR inputs/artifacts or model calls", () => {
  const text = fs.readFileSync(
    path.resolve(__dirname, "../../.github/workflows/factory-deploy.yml"),
    "utf8"
  );
  const flow = yaml.load(text);
  assert.deepEqual(Object.keys(flow.on).sort(), ["workflow_dispatch", "workflow_run"]);
  assert.deepEqual(flow.on.workflow_run.workflows, ["Factory CI"]);
  assert.deepEqual(flow.on.workflow_run.branches, ["main"]);
  assert.deepEqual(flow.on.workflow_run.types, ["completed"]);
  assert.deepEqual(flow.permissions, { contents: "read", actions: "read" });
  assert.equal(flow.jobs.deploy.environment.name, "production");
  assert.equal(flow.jobs.deploy.needs, "prepare");
  assert.equal(flow.jobs.deploy.concurrency["cancel-in-progress"], false);
  assert.equal(flow.jobs.deploy["timeout-minutes"], 30);
  assert.doesNotMatch(JSON.stringify(flow.jobs.prepare), /secrets\./);
  assert.doesNotMatch(
    text,
    /CLAUDE_CODE|ANTHROPIC|OPENAI|FACTORY_GITHUB_APP_PRIVATE_KEY|download-artifact|npm install|yarn install/
  );
  for (const job of Object.values(flow.jobs)) {
    assert.match(job.if, /github\.run_attempt == 1/);
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
      if (step.uses?.startsWith("actions/checkout@")) {
        assert.equal(step.with.ref, "${{ github.workflow_sha }}");
        assert.equal(step.with["persist-credentials"], false);
      }
      if (step.run) assert.doesNotMatch(step.run, /\$\{\{/);
    }
  }
  const hooks = flow.jobs.deploy.steps.filter((s) => s.env?.RENDER_DEPLOY_HOOK_URL);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].env.RENDER_DEPLOY_HOOK_URL, "${{ secrets.RENDER_DEPLOY_HOOK_URL }}");
  assert.equal(hooks[0].run, "node scripts/factory/deploy.cjs deploy");
});
