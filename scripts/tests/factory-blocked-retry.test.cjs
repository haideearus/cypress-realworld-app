const assert = require("node:assert/strict");
const test = require("node:test");
const policy = require("../factory/policy.cjs");
const { queueBlockedRetry, testedFixOnMain } = require("../factory/blocked-retry.cjs");
const { criteriaHash } = require("../factory/controller.cjs");

const past = "a".repeat(40);
const fixed = "b".repeat(40);
const main = "c".repeat(40);
const now = new Date("2026-11-20T11:34:00Z");
const context = {
  repository: policy.REPOSITORY,
  actor: policy.OWNER,
  triggeringActor: policy.OWNER,
  ref: "refs/heads/main",
  workflowRef: policy.AUTOMATIC_WORKFLOW_REF,
  event: "workflow_dispatch",
  workflowSha: main,
  runId: "200",
  runAttempt: 1,
};
const config = {
  enabled: true,
  automatic: true,
  priorityRetry: true,
  appSlug: "factory-app",
  coding: 2,
  retries: 1,
  daily: 5,
  reviews: 2,
  minutes: 10,
  turns: 20,
  concurrent: 1,
  timezone: "Europe/Bucharest",
};

function fixture({ merged = true, publishing = false, tested = true } = {}) {
  const issued = {
    number: 109,
    state: "open",
    title: "Notifications link needs a name",
    body: "Provide an accessible name.",
    created_at: "2026-11-20T07:30:00Z",
    labels: [{ name: "factory-ready" }],
    user: { login: policy.OWNER },
  };
  const first = {
    ...context,
    runId: "100",
    event: "schedule",
    workflowSha: past,
    ticket: 109,
    phase: "code",
    slot: "cycle1",
    head: past,
  };
  const { state: reserved, grant } = policy.reserve(
    policy.emptyState(policy.REPOSITORY),
    first,
    config,
    new Date("2026-11-20T10:55:00Z")
  );
  reserved.tickets[109].criteriaHash = criteriaHash(issued);
  reserved.tickets[109].automatic = {
    workflowRef: first.workflowRef,
    workflowSha: past,
    runId: first.runId,
    runAttempt: 1,
    appSlug: config.appSlug,
  };
  let ledger = policy.finish(reserved, grant.id, { status: "blocked" }, now);
  const snapshot = structuredClone(ledger);
  const sha = "d".repeat(40);
  const repo = { full_name: policy.REPOSITORY };
  const source = {
    id: 100,
    status: "completed",
    conclusion: "failure",
    run_attempt: 1,
    path: ".github/workflows/factory-automatic.yml",
    head_branch: "main",
    head_sha: past,
    repository: repo,
    head_repository: repo,
  };
  const fix = {
    number: 111,
    merged,
    state: "closed",
    merge_commit_sha: fixed,
    user: { login: policy.OWNER },
    base: { ref: "main", repo },
  };
  const ci = {
    id: 300,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    event: "push",
    path: ".github/workflows/factory-ci.yml",
    head_branch: "main",
    head_sha: main,
    repository: repo,
  };
  const api = {
    request: async (verb, path) => {
      assert.equal(verb, "GET");
      if (path.endsWith("/issues/109")) return issued;
      if (path.endsWith("/branches/main")) return { commit: { sha: main } };
      if (path.endsWith("/actions/runs/100")) return source;
      if (path.endsWith("/pulls/111")) return fix;
      if (path.endsWith("/pulls/111/files?per_page=100"))
        return [{ filename: "scripts/factory/worker.cjs" }];
      if (
        path.endsWith("/compare/" + fixed + "..." + main) ||
        path.endsWith("/compare/" + past + "..." + fixed)
      )
        return { status: "ahead" };
      if (path.endsWith("/git/ref/heads/agent/factory-109")) {
        if (publishing) return { object: { sha: past } };
        throw Object.assign(Error("Missing branch"), { status: 404 });
      }
      throw Error("Unexpected read " + path);
    },
    pages: async (path, key) => {
      assert.equal(key, path.includes("/jobs") ? "jobs" : "workflow_runs");
      if (path.includes("/100/attempts/1/jobs"))
        return [
          {
            id: 901,
            name: "cycle1 / coding / agent",
            completed_at: "2026-11-20T11:00:00Z",
            status: "completed",
            conclusion: "failure",
            run_id: 100,
            run_attempt: 1,
          },
        ];
      if (path.includes("/300/attempts/1/jobs"))
        return [
          { id: 902, name: "verify", head_sha: main, status: "completed", conclusion: "success" },
        ];
      if (path.includes("factory-ci.yml/runs?")) return tested ? [ci] : [];
      throw Error("Unexpected list " + path);
    },
  };
  let writes = 0;
  const coordinator = {
    context,
    config,
    api,
    verifyDelayedIssue: async (issue, ticket) =>
      issue.number === 109 &&
      issue.labels[0].name === "factory-ready" &&
      criteriaHash(issue) === ticket.criteriaHash,
    ledger: {
      read: async () => ({ state: structuredClone(ledger), commit: sha }),
      update: async (apply, opts) => {
        assert.equal(opts.expectedCommit, sha);
        ledger = policy.validateState((await apply(structuredClone(ledger))).state);
        writes++;
      },
    },
  };
  return { coordinator, snapshot, current: () => ledger, writes: () => writes };
}

test("a proven harness fix can preview retry of the original blocked issue with no writes", async () => {
  const f = fixture();
  const verdict = await queueBlockedRetry(
    f.coordinator,
    { ticket: 109, fixPr: 111, dryRun: true },
    now
  );
  assert.equal(verdict.modelCalls, 0);
  assert.match(verdict.reason, /preview/i);
  assert.equal(f.writes(), 0);
});

test("queues a single retry after verified recovery and preserves attempts until pickup", async () => {
  const f = fixture();
  const inputs = { ticket: 109, fixPr: 111, dryRun: false };
  const verdict = await queueBlockedRetry(f.coordinator, inputs, now);
  assert.equal(verdict.ready, false);
  assert.equal(verdict.modelCalls, 0);
  const ticket = f.current().tickets[109];
  assert.equal(ticket.delayedRetry.notBefore, "2026-11-20T11:30:00.000Z");
  assert.deepEqual(ticket.delayedRetry.fix, { pr: 111, mergeCommit: fixed, ciRunId: "300" });
  assert.deepEqual(f.current().grants, f.snapshot.grants);
  assert.deepEqual(f.current().days, f.snapshot.days);
  assert.equal(ticket.coding, 1);
  assert.equal(ticket.retries, 0);
  await assert.rejects(queueBlockedRetry(f.coordinator, inputs, now), /eligible/i);
  assert.equal(f.writes(), 1);
});

test("unmerged fix or published branch cannot activate a blocked retry", async () => {
  for (const options of [{ merged: false }, { publishing: true }]) {
    const f = fixture(options);
    await assert.rejects(
      queueBlockedRetry(f.coordinator, { ticket: 109, fixPr: 111, dryRun: false }, now),
      /merged harness fix|publication branch/
    );
    assert.deepEqual(f.current(), f.snapshot);
  }
});

test("a queued receipt waits when the current main commit has no passing push CI", async () => {
  const { coordinator } = fixture({ tested: false });
  assert.equal(await testedFixOnMain(coordinator.api, context, { mergeCommit: fixed }), false);
});
