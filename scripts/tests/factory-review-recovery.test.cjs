const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../factory/policy.cjs");
const recovery = require("../factory/review-recovery.cjs");
const { criteriaHash } = require("../factory/controller.cjs");
const { ROOT } = require("../factory/github.cjs");
const { AGENT_WORKFLOWS } = require("../factory/stop.cjs");

const { SOURCE, SLOT, WORKFLOW_REF } = recovery;
const workflowSha = "c".repeat(40);
const originalRevision = { head: SOURCE.head, runId: SOURCE.ci.runId };
const input = {
  repository: policy.REPOSITORY,
  actor: policy.OWNER,
  triggeringActor: policy.OWNER,
  ref: "refs/heads/main",
  event: "workflow_dispatch",
  workflowRef: WORKFLOW_REF,
  workflowSha,
  runId: "44499999999",
  runAttempt: 1,
};
const issue = {
  number: SOURCE.ticket,
  state: "open",
  title: "Like button",
  body: "Name the button",
};
const config = {
  enabled: true,
  autoMerge: false,
  minutes: 15,
  turns: 20,
  coding: 5,
  reviews: 10,
  retries: 4,
  daily: 20,
  concurrent: 1,
  timezone: "UTC",
  appSlug: SOURCE.appSlug,
};

function fixture(parked = false) {
  const state = policy.emptyState(policy.REPOSITORY);
  state.days["2026-11-19"] = [SOURCE.ticket];
  state.tickets[SOURCE.ticket] = {
    origin: "factory",
    status: parked ? "blocked" : "awaiting_review",
    head: SOURCE.head,
    branch: SOURCE.branch,
    pr: SOURCE.pr,
    coding: 1,
    reviews: 0,
    retries: 0,
    approval: null,
    criteriaHash: criteriaHash(issue),
    ci: SOURCE.ci,
    automatic: {
      workflowRef: policy.AUTOMATIC_WORKFLOW_REF,
      workflowSha: SOURCE.base,
      runId: SOURCE.parent,
      runAttempt: 1,
      appSlug: SOURCE.appSlug,
    },
  };
  state.grants[SOURCE.codeGrant] = {
    id: SOURCE.codeGrant,
    status: "finished",
    outcome: "awaiting_review",
    ticket: SOURCE.ticket,
    phase: "code",
    slot: "cycle1",
    head: SOURCE.base,
    runId: SOURCE.parent,
    runAttempt: 1,
    at: "2026-11-19T00:48:38.565Z",
  };
  state.active = parked ? null : { ticket: SOURCE.ticket, runId: SOURCE.parent, runAttempt: 1 };
  return state;
}

test("hands off one review and keeps the published coding grant, saved CI and original admission", () => {
  for (const parked of [false, true]) {
    const original = fixture(parked);
    const { state, grant } = recovery.reserve(original, input, config, originalRevision);
    assert.deepEqual(state.days, original.days);
    assert.deepEqual(state.grants[SOURCE.codeGrant], original.grants[SOURCE.codeGrant]);
    assert.deepEqual(state.tickets[SOURCE.ticket].ci, SOURCE.ci);
    assert.equal(state.tickets[SOURCE.ticket].coding, 1);
    assert.equal(state.tickets[SOURCE.ticket].retries, 0);
    assert.equal(state.tickets[SOURCE.ticket].reviews, 1);
    assert.equal(grant.phase, "review");
    assert.equal(grant.slot, SLOT);
    assert.equal(grant.head, SOURCE.head);
    assert.equal(policy.preflight(state, grant.id, { ...input, ...grant }, config).id, grant.id);
    assert.throws(() => recovery.reserve(state, input, config, originalRevision));
  }
});

test("refuses modified evidence, foreign ownership, exhausted limits and a rerun", () => {
  const altered = fixture();
  altered.tickets[SOURCE.ticket].ci = { ...SOURCE.ci, runId: 123 };
  assert.throws(() => recovery.reserve(altered, input, config, originalRevision));
  const foreign = fixture();
  foreign.active.runId = "123";
  assert.throws(() => recovery.reserve(foreign, input, config, originalRevision));
  assert.throws(() =>
    recovery.reserve(fixture(), { ...input, runAttempt: 2 }, config, originalRevision)
  );
  assert.throws(() =>
    recovery.reserve(fixture(), input, { ...config, reviews: 0 }, originalRevision)
  );
  assert.throws(() =>
    recovery.reserve(fixture(), input, { ...config, autoMerge: true }, originalRevision)
  );
});

test("binds CI for the updated head without replacing the first CI receipt", () => {
  const revision = { head: "e".repeat(40), runId: 44499999981 };
  const { state, grant } = recovery.reserve(fixture(), input, config, revision);
  const ticket = state.tickets[SOURCE.ticket];
  assert.deepEqual(ticket.ci, SOURCE.ci);
  assert.deepEqual(recovery.reviewEvidence(ticket, grant, input).ci, { ...revision, passed: true });
  assert.throws(() => recovery.reviewEvidence(ticket, { ...grant, head: SOURCE.head }, input));
  assert.throws(() =>
    recovery.reserve(fixture(), input, config, { ...revision, runId: SOURCE.ci.runId })
  );
});

test("rejects using the recovery workflow for coding or elsewhere", () => {
  const request = {
    ...input,
    ticket: SOURCE.ticket,
    head: SOURCE.head,
    slot: SLOT,
    phase: "review",
  };
  policy.authorize(request);
  assert.throws(() => policy.authorize({ ...request, phase: "code" }));
  assert.throws(() => policy.authorize({ ...request, workflowRef: policy.AUTOMATIC_WORKFLOW_REF }));
  assert.throws(() => policy.authorize({ ...request, ticket: 97 }));
});

test("requires both original files and an unchanged patch after the branch update", () => {
  const files = [
    {
      filename: "src/components/TransactionDetail.tsx",
      status: "modified",
      sha: "d".repeat(40),
      patch: "@@ -1 +1 @@\n-old\n+new",
    },
    {
      filename: "src/components/__tests__/TransactionDetail.test.tsx",
      status: "added",
      sha: "e".repeat(40),
      patch: "@@ -0,0 +1 @@\n+test",
    },
  ];
  assert.deepEqual(recovery.patch(files), recovery.patch([...files].reverse()));
  assert.throws(() => recovery.patch(files.slice(0, 1)));
  assert.throws(() => recovery.patch([...files, { ...files[0], filename: "AGENTS.md" }]));
  assert.notDeepEqual(
    recovery.patch(files),
    recovery.patch([{ ...files[0], patch: "+changed" }, files[1]])
  );
});

test("reuses saved CI only for the original revision and verifies native CI after a merge update", async () => {
  const head = "e".repeat(40);
  const ciRun = "44499999981";
  const files = [
    {
      filename: "src/components/TransactionDetail.tsx",
      status: "modified",
      sha: head,
      patch: "+new",
    },
    {
      filename: "src/components/__tests__/TransactionDetail.test.tsx",
      status: "added",
      sha: head,
      patch: "+test",
    },
  ];
  const repo = { full_name: policy.REPOSITORY };
  const pr = {
    number: SOURCE.pr,
    state: "open",
    draft: false,
    user: { login: SOURCE.appSlug + "[bot]" },
    head: { sha: head, ref: SOURCE.branch, repo },
    base: { sha: workflowSha, ref: "main", repo },
  };
  const workflow = { id: 20, path: ".github/workflows/factory-ci.yml" };
  const run = {
    id: Number(ciRun),
    workflow_id: workflow.id,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    path: workflow.path,
    repository: repo,
    head_repository: repo,
    event: "pull_request",
    head_sha: head,
    head_branch: SOURCE.branch,
    display_title: "Factory CI / 113",
    pull_requests: [{ number: SOURCE.pr, head: { sha: head }, base: { sha: workflowSha } }],
  };
  const commit = { parents: [{ sha: SOURCE.head }, { sha: workflowSha }] };
  const routes = new Map([
    [`${ROOT}/pulls/113`, pr],
    [`${ROOT}/git/commits/${head}`, commit],
    [`${ROOT}/compare/${SOURCE.base}...${SOURCE.head}?per_page=1`, { files }],
    [`${ROOT}/compare/${workflowSha}...${head}?per_page=1`, { files }],
    [`${ROOT}/actions/runs/${ciRun}/attempts/1`, run],
    [`${ROOT}/actions/workflows/factory-ci.yml`, workflow],
  ]);
  const controller = {
    context: { ...input },
    issue: async () => issue,
    api: {
      request(method, route) {
        assert.equal(method, "GET");
        assert.ok(routes.has(route), route);
        return routes.get(route);
      },
      pages(route, key) {
        assert.equal(route, `${ROOT}/actions/runs/${ciRun}/attempts/1/jobs`);
        assert.equal(key, "jobs");
        return [{ name: "verify", status: "completed", conclusion: "success" }];
      },
    },
  };
  const ticket = fixture().tickets[SOURCE.ticket];
  const check = (id) => recovery.reviewedRevision(controller, ticket, id);
  assert.deepEqual(await check(ciRun), { head, runId: Number(ciRun) });
  await assert.rejects(check(), /run ID/);
  const exactParent = commit.parents.pop();
  await assert.rejects(check(ciRun), /merge current main/);
  commit.parents.push(exactParent);
  run.pull_requests[0].base.sha = SOURCE.base;
  await assert.rejects(check(ciRun), /unrelated/);
  pr.head.sha = SOURCE.head;
  await assert.rejects(check(), /Update PR #113/);
  pr.base.sha = SOURCE.base;
  controller.context.workflowSha = SOURCE.base;
  assert.deepEqual(await check(), originalRevision);
});

test("emergency stop sees the saved-CI review parent", () => {
  assert.ok(AGENT_WORKFLOWS.includes(".github/workflows/factory-review-recovery.yml"));
});
