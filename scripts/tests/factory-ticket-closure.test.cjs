const assert = require("node:assert/strict");
const { test } = require("node:test");
const policy = require("../factory/policy.cjs");
const { criteriaHash } = require("../factory/controller.cjs");
const { ROOT } = require("../factory/github.cjs");
const { vars, context: base, reviewFeedback } = require("./helpers/factory-fixtures.cjs");
const { runClosure } = require("../factory/ticket-closure.cjs");

const head = "a".repeat(40);
const build = "b".repeat(40);
const merged = "c".repeat(40);
const release = "d".repeat(40);
const path = ".github/workflows/factory-ticket-closure.yml";
const owner = { login: policy.OWNER, id: 101267861, type: "User" };
const app = { login: "haideearus-software-factory[bot]", id: 356310548, type: "Bot" };

function setup({ preview = false } = {}) {
  const issue = {
    number: 10,
    state: "open",
    user: owner,
    labels: [{ name: "factory-ready" }],
    title: "Fix an app bug",
    body: "Acceptance criterion",
  };
  const automatic = {
    workflowRef: policy.AUTOMATIC_WORKFLOW_REF,
    workflowSha: build,
    runId: "100",
    runAttempt: 1,
    appSlug: "haideearus-software-factory",
  };
  const identity = {
    ...base,
    event: "schedule",
    workflowRef: automatic.workflowRef,
    workflowSha: build,
  };
  const config = { ...policy.readConfig(vars), automatic: true, appSlug: automatic.appSlug };
  const coding = policy.reserve(
    policy.emptyState(policy.REPOSITORY),
    { ...identity, head: build },
    config
  );
  Object.assign(coding.state.tickets["10"], { criteriaHash: criteriaHash(issue), automatic });
  const coded = policy.finish(coding.state, coding.grant.id, {
    status: "awaiting_review",
    pr: 21,
    head,
  });
  const review = policy.reserve(coded, { ...identity, head, phase: "review" }, config);
  const state = policy.finish(review.state, review.grant.id, {
    status: "reviewed",
    pr: 21,
    head,
    verdict: "pass",
    evidence: `https://github.com/${policy.REPOSITORY}/actions/runs/100`,
  });
  const ticket = state.tickets["10"];
  Object.assign(ticket, {
    branch: "agent/factory-10",
    feedback: reviewFeedback(head),
    ci: { head, passed: true, runId: 33, requestId: "22222222-2222-4222-8222-222222222222" },
    merge: {
      status: "merged",
      head,
      pr: 21,
      mergeCommit: merged,
      at: "2026-11-21T00:00:00.000Z",
      runId: "100",
      runAttempt: 1,
    },
  });
  const repo = { full_name: policy.REPOSITORY };
  const pr = {
    number: 21,
    state: "closed",
    merged: true,
    merge_commit_sha: merged,
    changed_files: 1,
    user: app,
    head: { sha: head, ref: "agent/factory-10", repo },
    base: { ref: "main", repo },
  };
  const deployment = {
    id: 90,
    path: ".github/workflows/factory-deploy.yml",
    workflow_id: 40,
    display_title: "Production deployment / CI 92",
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: release,
    event: "workflow_run",
    head_repository: repo,
    repository: repo,
    actor: app,
    triggering_actor: app,
  };
  const context = {
    repository: policy.REPOSITORY,
    ref: "refs/heads/main",
    workflowRef: `${policy.REPOSITORY}/${path}@refs/heads/main`,
    workflowSha: release,
    sha: release,
    runId: "111",
    runAttempt: "1",
    eventName: preview ? "workflow_dispatch" : "workflow_run",
    actor: preview ? owner.login : app.login,
    triggeringActor: preview ? owner.login : app.login,
  };
  const f = {
    issue,
    state,
    ticket,
    pr,
    deployment,
    context,
    laterFiles: [{ filename: "yarn.lock" }],
    approvals: [{ state: "approved", user: owner, environments: [{ name: "production", id: 4 }] }],
    activeRelease: release,
    calls: [],
    stopAfterPlan: false,
    loseResponse: false,
    event: preview
      ? { inputs: { deployment_run_id: "90", ticket: "10" } }
      : {
          action: "completed",
          workflow_run: structuredClone(deployment),
          repository: repo,
        },
    enabled: true,
  };
  f.api = {
    async pages(url) {
      assert.equal(url, `${ROOT}/issues?state=open&labels=factory-ready`);
      return issue.state === "open" ? [structuredClone(issue)] : [];
    },
    async request(method, url, body) {
      f.calls.push([method, url, body]);
      const p = url.slice(ROOT.length).split("?")[0];
      if (method === "PATCH") {
        assert.equal(p, "/issues/10");
        Object.assign(issue, body);
        if (f.loseResponse) throw Error("connection lost");
        return structuredClone(issue);
      }
      assert.equal(method, "GET");
      if (p === "/issues/10") return structuredClone(issue);
      if (p === "/pulls/21") return structuredClone(pr);
      if (p === "/pulls/21/files") return [{ filename: "src/Repair.tsx" }];
      if (p === `/compare/${merged}...${release}`)
        return {
          status: "ahead",
          behind_by: 0,
          merge_base_commit: { sha: merged },
          base_commit: { sha: merged },
          files: f.laterFiles,
        };
      if (p === "/actions/runs/90/attempts/1") return structuredClone(deployment);
      if (p === "/actions/runs/92")
        return {
          ...deployment,
          id: 92,
          event: "push",
          path: ".github/workflows/factory-ci.yml",
          workflow_id: 42,
        };
      if (p === "/actions/workflows/factory-deploy.yml") return { id: 40, path: deployment.path };
      if (p === "/actions/workflows/factory-ci.yml")
        return { id: 42, path: ".github/workflows/factory-ci.yml" };
      if (p.startsWith("/contents/.github/workflows/")) return { type: "file", sha: build };
      if (p === "/actions/runs/90/approvals") return f.approvals;
      if (p.endsWith("/jobs")) {
        const job = (name, step) => ({
          name,
          status: "completed",
          conclusion: "success",
          head_sha: release,
          steps: step ? [{ name: step, status: "completed", conclusion: "success" }] : [],
        });
        const jobs = p.includes("/92/")
          ? [job("verify")]
          : [
              job("prepare", "Validate tested commit without deployment credentials"),
              job(
                `Deploy tested commit ${release}`,
                "Revalidate human approval, deploy once, and verify the live release"
              ),
            ];
        return { total_count: jobs.length, jobs };
      }
      throw Error("Unexpected route " + p);
    },
  };
  let reads = 0;
  f.ledger = {
    async read() {
      return {
        state: f.stopAfterPlan && ++reads > 1 ? { ...state, stop: {} } : structuredClone(state),
      };
    },
  };
  f.verifyLive = async () => ({
    release: f.activeRelease,
    health: true,
    ready: true,
    frontend: true,
  });
  return f;
}
const patches = (f) => f.calls.filter(([method]) => method === "PATCH");

test("closes an unchanged factory repair on a verified descendant and never rewrites its ledger", async () => {
  const f = setup();
  const ledgerBefore = structuredClone(f.state);
  const result = await runClosure(f);
  assert.equal(result.closed[0].issue, 10);
  assert.equal(result.release, release);
  assert.deepEqual(patches(f), [
    ["PATCH", `${ROOT}/issues/10`, { state: "closed", state_reason: "completed" }],
  ]);
  assert.deepEqual(f.state, ledgerBefore);
  assert.deepEqual((await runClosure(f)).closed, []);
  assert.equal(patches(f).length, 1);
});

test("an owner preview of the same exact repair nominates it with zero writes", async () => {
  const f = setup({ preview: true });
  assert.equal((await runClosure(f)).eligible[0].issue, 10);
  assert.equal(f.issue.state, "open");
  assert.equal(patches(f).length, 0);
});

test("holds when production approval is absent or the current release is different", async () => {
  const unapproved = setup();
  unapproved.approvals = [];
  await assert.rejects(runClosure(unapproved));
  assert.equal(patches(unapproved).length, 0);
  const stale = setup();
  stale.activeRelease = merged;
  assert.equal((await runClosure(stale)).outcome, "live_release_unverified");
  assert.equal(patches(stale).length, 0);
});

test("keeps open a later edit to repair files, changed issue, or unmerged repair", async () => {
  for (const change of [
    (f) => {
      f.laterFiles = [{ filename: "src/Repair.tsx" }];
    },
    (f) => {
      f.issue.body = "New acceptance criterion";
    },
    (f) => {
      f.pr.merged = false;
    },
    (f) => {
      f.issue.labels = [];
    },
  ]) {
    const f = setup();
    change(f);
    assert.deepEqual((await runClosure(f)).closed, []);
    assert.equal(patches(f).length, 0);
  }
});

test("keeps false automation, an emergency stop, and a forged event from closing tickets", async () => {
  const disabled = setup();
  disabled.enabled = false;
  assert.deepEqual((await runClosure(disabled)).closed, []);
  const stopped = setup();
  stopped.stopAfterPlan = true;
  await assert.rejects(runClosure(stopped));
  const forged = setup();
  forged.event.workflow_run.repository.full_name = "another/repo";
  await assert.rejects(runClosure(forged));
  for (const f of [disabled, stopped, forged]) assert.equal(patches(f).length, 0);
});

test("reconciles a lost response by reading the completed issue without another write", async () => {
  const f = setup();
  f.loseResponse = true;
  assert.equal((await runClosure(f)).closed[0].issue, 10);
  assert.equal(patches(f).length, 1);
});

test("per-ticket proof read failures hold the ticket with a specific result", async () => {
  const f = setup();
  const request = f.api.request;
  async function requestWithExpiredProof(method, url, body) {
    if (url === `${ROOT}/pulls/21`) throw Object.assign(Error("Expired proof"), { status: 404 });
    return request(method, url, body);
  }
  f.api.request = requestWithExpiredProof;
  assert.deepEqual((await runClosure(f)).held, [{ issue: 10, reason: "repair_proof_unavailable" }]);
  assert.equal(patches(f).length, 0);
});

test("a release change after proof collection holds without closing the issue", async () => {
  const f = setup();
  let probes = 0;
  f.verifyLive = async () => ({
    release: ++probes === 1 ? release : merged,
    health: true,
    ready: true,
    frontend: true,
  });
  const result = await runClosure(f);
  assert.equal(result.outcome, "live_release_unverified");
  assert.equal(f.issue.state, "open");
  assert.equal(patches(f).length, 0);
});

test("action dispatch is read-only and closure has only the issue write permission", () => {
  const { readFileSync } = require("node:fs");
  const yaml = require("js-yaml");
  const definition = yaml.load(
    readFileSync(".github/workflows/factory-ticket-closure.yml", "utf8")
  );
  assert.deepEqual(definition.on.workflow_run.workflows, ["Approved production deployment"]);
  assert.equal(definition.permissions.issues, "read");
  assert.equal(definition.jobs.preview.permissions, undefined);
  assert.match(definition.jobs.preview.if, /github\.event_name == 'workflow_dispatch'/);
  assert.doesNotMatch(definition.jobs.close.if, /workflow_dispatch/);
  assert.equal(definition.jobs.close.permissions.issues, "write");
  assert.ok(
    Object.entries(definition.jobs.close.permissions).every(
      ([key, value]) => key === "issues" || value === "read"
    )
  );
  assert.equal(definition.jobs.close.concurrency.group, "factory-ticket-closure");
  assert.doesNotMatch(JSON.stringify(definition), /secrets\./);
});

test("scheduled catch-up selects the current release and pins the successful first attempt", async () => {
  const f = setup();
  f.context.eventName = "schedule";
  f.context.actor = owner.login;
  f.context.triggeringActor = owner.login;
  f.event = {};
  f.readLiveRelease = async () => release;
  const request = f.api.request;
  f.api.request = async (method, url, body) => {
    if (
      url ===
      `${ROOT}/actions/workflows/factory-deploy.yml/runs?branch=main&head_sha=${release}&per_page=5`
    ) {
      return { workflow_runs: [{ ...f.deployment, run_attempt: 2, conclusion: "skipped" }] };
    }
    if (url === `${ROOT}/actions/runs/90`) throw Error("latest attempt isn't deployment evidence");
    return request(method, url, body);
  };
  assert.equal((await runClosure(f)).closed[0].issue, 10);
  assert.ok(
    f.calls.some(
      ([method, url]) => method === "GET" && url === `${ROOT}/actions/runs/90/attempts/1`
    )
  );
});
