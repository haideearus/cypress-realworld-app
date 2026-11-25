const assert = require("node:assert/strict");
const test = require("node:test");
const policy = require("../factory/policy.cjs");
const { queueBlockedRetry, testedFixOnMain } = require("../factory/blocked-retry.cjs");
const { AutomaticCoordinator } = require("../factory/automation.cjs");
const { criteriaHash } = require("../factory/controller.cjs");

const past = "a".repeat(40);
const fixed = "b".repeat(40);
const main = "c".repeat(40);
const wakeFailureHead = "60ec2c6a851b315e3db3f175a62cc580ef9e99ab";
const wakeFix = "56294cf7fe21ebe1a040a66798b5f75fe7ed9411";
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

function fixture({
  merged = true,
  publishing = false,
  pullRequest = false,
  tested = true,
  known = false,
  causeProven = true,
  changedIssue = false,
  differentFix = false,
  otherReady = false,
} = {}) {
  const head = known ? wakeFailureHead : past;
  const repair = known && !differentFix ? wakeFix : fixed;
  const original = known ? 44424312124 : 100;
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
    runId: String(original),
    event: "schedule",
    workflowSha: head,
    ticket: 109,
    phase: "code",
    slot: "cycle1",
    head,
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
    workflowSha: head,
    runId: first.runId,
    runAttempt: 1,
    appSlug: config.appSlug,
  };
  let ledger = policy.finish(reserved, grant.id, { status: "blocked" }, now);
  const snapshot = structuredClone(ledger);
  if (changedIssue) issued.body += " Update the acceptance criteria.";
  const sha = "d".repeat(40);
  const repo = { full_name: policy.REPOSITORY };
  const source = {
    id: original,
    status: "completed",
    conclusion: "failure",
    run_attempt: 1,
    path: ".github/workflows/factory-automatic.yml",
    head_branch: "main",
    head_sha: head,
    repository: repo,
    head_repository: repo,
    event: "workflow_dispatch",
    actor: { login: "github-actions[bot]", id: 41898282 },
    triggering_actor: { login: "github-actions[bot]", id: 41898282 },
  };
  const fix = {
    number: 111,
    merged,
    state: "closed",
    merge_commit_sha: repair,
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
      if (path.includes("/issues?")) return otherReady ? [{ ...issued, number: 110 }] : [];
      if (path.endsWith("/branches/main")) return { commit: { sha: main } };
      if (path.endsWith(`/actions/runs/${original}`)) return source;
      if (path.endsWith("/pulls/111")) return fix;
      if (path.endsWith("/pulls/111/files?per_page=100"))
        return [
          { filename: "scripts/factory/worker.cjs" },
          { filename: "scripts/factory/trusted-wake.cjs" },
          { filename: ".github/workflows/factory-model.yml" },
        ];
      if (
        path.endsWith(
          "/pulls?state=all&per_page=1&head=" +
            encodeURIComponent(`${policy.OWNER}:agent/factory-109`)
        )
      )
        return pullRequest ? [{ number: 112, state: "closed" }] : [];
      if (
        path.endsWith("/compare/" + repair + "..." + main) ||
        path.endsWith("/compare/" + head + "..." + repair)
      )
        return { status: "ahead" };
      if (path.endsWith("/git/ref/heads/agent/factory-109")) {
        if (publishing) return { object: { sha: past } };
        throw Object.assign(Error("Missing branch"), { status: 404 });
      }
      if (path.endsWith("/git/ref/heads/factory/monitor-drill"))
        throw Object.assign(Error("Missing drill registry"), { status: 404 });
      throw Error("Unexpected read " + path);
    },
    pages: async (path, key) => {
      assert.equal(key, path.includes("/jobs") ? "jobs" : "workflow_runs");
      if (path.includes(`/${original}/attempts/1/jobs`))
        return [
          {
            id: known ? 135225265791 : 901,
            name: "cycle1 / coding / agent",
            completed_at: "2026-11-20T11:00:00Z",
            status: "completed",
            conclusion: "failure",
            run_id: original,
            run_attempt: 1,
            head_sha: head,
            steps: [
              {
                name: "Verify the durable reservation and prepare the isolated role",
                status: "completed",
                conclusion: "success",
              },
              {
                name: "Run the one reserved Claude subscription session",
                status: "completed",
                conclusion: "failure",
              },
              {
                name: "Validate and collect only the role output",
                status: "completed",
                conclusion: causeProven ? "skipped" : "success",
              },
            ],
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
  const coordinator = new AutomaticCoordinator(api, config, {
    ...context,
    ...(known ? { event: "schedule" } : {}),
    ticket: 1,
    phase: "code",
    slot: "cycle1",
    head: main,
  });
  coordinator.ledger = {
    read: async () => ({ state: structuredClone(ledger), commit: sha }),
    update: async (apply, opts) => {
      assert.equal(opts.expectedCommit, sha);
      const saved = await apply(structuredClone(ledger));
      ledger = policy.validateState(saved.state);
      writes++;
      return { ...saved, commit: sha };
    },
  };
  return { coordinator, grant, snapshot, current: () => ledger, writes: () => writes };
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

test("normal pickup reserves one recovery of the exact pre-Claude wake failure", async () => {
  const f = fixture({ known: true });
  const preview = await f.coordinator.pick({ dryRun: true });
  assert.equal(preview.ticket, 109);
  assert.deepEqual(f.current(), f.snapshot);

  const result = await f.coordinator.pick();
  assert.equal(result.ready, true);
  assert.equal(result.ticket, 109);
  assert.equal(result.head, main);
  const ticket = f.current().tickets[109];
  assert.equal(ticket.delayedRetry.grantId, f.grant.id);
  assert.equal(ticket.delayedRetry.jobId, 135225265791);
  assert.deepEqual(ticket.delayedRetry.fix, { pr: 111, mergeCommit: wakeFix, ciRunId: "300" });
  assert.deepEqual(ticket.automatic, f.snapshot.tickets[109].automatic);
  assert.equal(ticket.criteriaHash, f.snapshot.tickets[109].criteriaHash);
  assert.deepEqual(f.current().grants[f.grant.id], f.snapshot.grants[f.grant.id]);
  assert.deepEqual(f.current().days, f.snapshot.days);
  assert.deepEqual([ticket.coding, ticket.retries], [2, 1]);
  assert.equal((await f.coordinator.pick()).ready, false);
  assert.equal(f.writes(), 1);
});

test("automatic blocked pickup requires the original job, frozen criteria, tested repair and no publication", async () => {
  for (const options of [
    { known: false },
    { causeProven: false },
    { changedIssue: true },
    { differentFix: true },
    { tested: false },
    { publishing: true },
    { pullRequest: true },
  ]) {
    const f = fixture({ known: true, ...options });
    assert.equal((await f.coordinator.pick()).ready, false, JSON.stringify(options));
    assert.deepEqual(f.current(), f.snapshot);
  }
});

test("new ordinary work goes ahead of the known blocked recovery", async () => {
  const f = fixture({ known: true, otherReady: true });
  const preview = await f.coordinator.pick({ dryRun: true });
  assert.equal(preview.ticket, 110);
  assert.equal(f.writes(), 0);
});
