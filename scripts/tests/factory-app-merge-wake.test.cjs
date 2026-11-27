const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture } = require("./helpers/event-fixtures.cjs");
const { handleWake } = require("../factory/wake-controller.cjs");
const { verifySource, verifyWake } = require("../factory/trusted-wake.cjs");
const { Ledger } = require("../factory/github.cjs");
const c = require("../factory/wake-contract.cjs");

function mergedFixture() {
  const s = fixture();
  s.context.event = s.run.event = "workflow_run";
  const parent = {
    ...s.run,
    id: 700,
    event: "workflow_dispatch",
    display_title: "Automatic factory",
    workflow_id: 70,
    path: ".github/workflows/factory-automatic.yml",
    status: "completed",
    conclusion: "success",
  };
  s.event = { repository: parent.repository, action: "completed", workflow_run: parent };
  const repo = { full_name: c.REPOSITORY };
  const pr = {
    number: 13,
    merged: true,
    state: "closed",
    head: { ref: "agent/factory-12", repo, sha: "c".repeat(40) },
    base: { ref: "main", repo },
    user: { login: "factory-test[bot]" },
    merge_commit_sha: "b".repeat(40),
  };
  const ticket = {
    origin: "factory",
    automatic: { appSlug: "factory-test" },
    status: "reviewed",
    head: pr.head.sha,
    pr: pr.number,
    merge: {
      status: "merged",
      pr: pr.number,
      head: pr.head.sha,
      mergeCommit: pr.merge_commit_sha,
      runId: "700",
      runAttempt: 1,
    },
  };
  s.ledger.state.tickets["12"] = ticket;
  const request = s.api.request;
  s.api.request = (method, path, body) => {
    if (path.endsWith("/actions/workflows/factory-automatic.yml"))
      return { id: parent.workflow_id, path: parent.path };
    if (path.endsWith("/actions/runs/700/attempts/1")) return structuredClone(parent);
    if (path.endsWith("/pulls/13")) return structuredClone(pr);
    return request(method, path, body);
  };
  s.api.pages = async () => [];
  return { ...s, parent, pr, ticket };
}

test("a confirmed merge-only parent hands off once before deployment or push CI", async (t) => {
  const s = mergedFixture();
  t.mock.method(Ledger.prototype, "read", () => s.ledger.read());
  const before = structuredClone(s.ledger.state);
  const results = await Promise.all([handleWake(s), handleWake(s)]);
  assert.deepEqual(results.map((r) => r.outcome).sort(), ["dispatched", "duplicate"]);
  const receipt = Object.values(s.store.state.receipts)[0];
  assert.equal(receipt.signal.lane, "app");
  assert.equal(receipt.signal.number, 12);
  assert.equal(receipt.signal.head, s.pr.merge_commit_sha);
  assert.deepEqual(s.dispatches, [
    { ref: "main", inputs: { wake_id: receipt.id, dry_run: false } },
  ]);
  await verifySource(s.api, receipt.signal, false);
  s.pr.merge_commit_sha = "d".repeat(40);
  await assert.rejects(verifySource(s.api, receipt.signal, false));
  assert.deepEqual(s.ledger.state, before);
});

test("wrong head, base, actor, PR origin, parent attempt or pending confirmation cannot hand off", async () => {
  for (const change of [
    (s) => (s.pr.head.sha = "d".repeat(40)),
    (s) => (s.pr.base.ref = "other"),
    (s) => (s.pr.user.login = "another-bot"),
    (s) => (s.pr.head.repo = { full_name: "fork/repo" }),
    (s) => (s.ticket.merge.runAttempt = 2),
    (s) => (s.ticket.merge.status = "intent"),
    (s) => (s.pr.merged = false),
    (s) => (s.parent.head_branch = "other"),
  ]) {
    const s = mergedFixture();
    change(s);
    assert.equal((await handleWake(s)).outcome, "ignored");
    assert.equal(s.dispatches.length, 0);
  }
});

test("the single occupied slot keeps the post-merge check pending until capacity returns", async () => {
  const s = mergedFixture();
  s.ledger.state.active = { ticket: 94, runId: "701", runAttempt: 1 };
  assert.equal((await handleWake(s)).outcome, "busy");
  assert.equal(s.dispatches.length, 0);
  s.ledger.state.active = null;
  assert.equal((await handleWake(s)).outcome, "dispatched");
  assert.equal(s.dispatches.length, 1);
});

function interruptedFixture() {
  const s = mergedFixture();
  s.parent.conclusion = "cancelled";
  Object.assign(s.ticket, {
    merge: undefined,
    status: "awaiting_review",
    coding: 1,
    retries: 0,
    branch: "agent/factory-12",
    monitor: {
      issue: 12,
      probeMode: require("../factory/functional-discovery-contract.cjs").PROBE_MODE,
    },
    automatic: {
      ...s.ticket.automatic,
      workflowSha: s.parent.head_sha,
      runId: "700",
      runAttempt: 1,
    },
  });
  s.ledger.state.active = { ticket: 12, runId: "700", runAttempt: 1 };
  s.ledger.state.grants.code = {
    ...s.ledger.state.active,
    phase: "code",
    status: "finished",
    outcome: "awaiting_review",
  };
  return s;
}

test("the targeted recovery wake honors the stop and requires its own published interrupted branch", async () => {
  const stopped = interruptedFixture();
  stopped.ledger.state.stop = {};
  assert.equal((await handleWake(stopped)).outcome, "stopped");
  assert.deepEqual(stopped.dispatches, []);
  for (const change of [
    (s) => (s.ticket.monitor.probeMode = "production"),
    (s) => (s.ticket.automatic.workflowSha = "f".repeat(40)),
    (s) => (s.ticket.branch = "agent/factory-99"),
    (s) => (s.parent.conclusion = "failure"),
    (s) => (s.ticket.status = "coding"),
  ]) {
    const s = interruptedFixture();
    change(s);
    assert.equal((await handleWake(s)).outcome, "ignored");
    assert.deepEqual(s.dispatches, []);
  }
});

test("a terminal interrupted functional parent wakes only its own published repair", async (t) => {
  const s = interruptedFixture();
  t.mock.method(Ledger.prototype, "read", () => s.ledger.read());
  const before = structuredClone(s.ledger.state);
  const result = await handleWake(s);
  assert.equal(result.outcome, "dispatched");
  assert.deepEqual(s.ledger.state, before);
  assert.equal((await handleWake(s)).outcome, "duplicate");
  const receipt = s.store.state.receipts[result.receiptId];
  const bot = { login: c.BOT, id: c.BOT_ID };
  const receiver = {
    ...s.parent,
    id: 701,
    actor: bot,
    triggering_actor: bot,
    display_title: `Automatic factory / wake ${receipt.id}`,
    status: "in_progress",
    conclusion: null,
  };
  const request = s.api.request;
  s.api.request = (method, path, body) =>
    path.endsWith("/actions/runs/701/attempts/1")
      ? structuredClone(receiver)
      : request(method, path, body);
  const context = {
    ...s.context,
    actor: c.BOT,
    triggeringActor: c.BOT,
    runId: "701",
    event: "workflow_dispatch",
    workflowSha: receiver.head_sha,
    workflowRef: `${c.REPOSITORY}/${receiver.path}@refs/heads/main`,
  };
  context.wake = await verifyWake({
    ...s,
    context,
    receiptId: receipt.id,
    lane: "app",
    bind: true,
  });
  const trusted = require("../factory/trusted-wake.cjs");
  assert.equal(trusted.interruptedWakeTarget(context), 12);
  assert.equal(trusted.allowedModelBots({ ...context, phase: "code", ticket: 12 }, s.ticket), "");
  assert.equal(trusted.allowedModelBots({ ...context, phase: "review", ticket: 13 }, s.ticket), "");
  s.ledger.state.active = null;
  s.ticket.publishedRecovery = { interruptedHead: s.ticket.head };
  await trusted.verifySource(s.api, receipt.signal, true);
  await assert.rejects(trusted.verifySource(s.api, receipt.signal, false));
  assert.equal(
    trusted.allowedModelBots({ ...context, phase: "review", ticket: 12 }, s.ticket),
    c.BOT
  );
  delete s.ticket.publishedRecovery;
  await assert.rejects(trusted.verifySource(s.api, receipt.signal, true));
});

test("an idle post-merge app check hands off to the existing dependency selector", async (t) => {
  const s = mergedFixture();
  t.mock.method(Ledger.prototype, "read", () => s.ledger.read());
  t.mock.method(
    require("../factory/dependency-tracking.cjs"),
    "previewNativeRecovery",
    async () => 260
  );
  const { receiptId } = await handleWake(s);
  const bot = { login: c.BOT, id: c.BOT_ID };
  const receiver = {
    ...s.parent,
    id: 701,
    actor: bot,
    triggering_actor: bot,
    head_sha: s.pr.merge_commit_sha,
    display_title: `Automatic factory / wake ${receiptId}`,
  };
  const bridge = {
    ...s.run,
    id: 801,
    head_sha: receiver.head_sha,
  };
  const request = s.api.request;
  s.api.request = (method, path, body) => {
    if (path.endsWith("/actions/runs/701/attempts/1")) return structuredClone(receiver);
    if (path.endsWith("/actions/runs/801/attempts/1")) return structuredClone(bridge);
    if (path.includes("/factory-ci.yml/runs?")) return { workflow_runs: [] };
    return request(method, path, body);
  };
  s.api.pages = async () => [
    {
      name: "pick",
      status: "completed",
      conclusion: "success",
      steps: [
        { name: "Hand off an idle app queue to dependency maintenance", conclusion: "success" },
      ],
    },
  ];
  const context = {
    ...s.context,
    actor: c.BOT,
    triggeringActor: c.BOT,
    runId: "701",
    event: "workflow_dispatch",
    workflowSha: receiver.head_sha,
    workflowRef: `${c.REPOSITORY}/${receiver.path}@refs/heads/main`,
  };
  await verifyWake({ ...s, context, receiptId, lane: "app", bind: true });
  const completion = {
    ...s,
    context: { ...s.context, runId: "801", workflowSha: bridge.head_sha },
    event: { ...s.event, workflow_run: receiver },
  };
  assert.equal((await handleWake(completion)).lane, "dependency");
  assert.equal((await handleWake(completion)).outcome, "duplicate");
  assert.equal(s.dispatches.length, 2);
});

test("a later interrupted continuation remains bound to its retained head after another resume", async (t) => {
  const s = interruptedFixture();
  t.mock.method(Ledger.prototype, "read", () => s.ledger.read());
  s.ticket.automatic.runId = "600";
  s.ticket.publishedRecovery = {
    interruptedHead: "d".repeat(40),
    parent: { runId: "700", runAttempt: 1, workflowSha: s.parent.head_sha, head: s.ticket.head },
  };
  const result = await handleWake(s);
  assert.equal(result.outcome, "dispatched");
  const { signal } = s.store.state.receipts[result.receiptId];
  assert.equal(signal.head, s.ticket.head);
  s.ledger.state.active = null;
  s.ticket.publishedRecovery.interruptedParents = [s.ticket.publishedRecovery.parent];
  s.ticket.publishedRecovery.parent = { ...s.ticket.publishedRecovery.parent, runId: "702" };
  await verifySource(s.api, signal, true);
  await assert.rejects(verifySource(s.api, signal, false));
  s.ticket.publishedRecovery.interruptedParents = [];
  await assert.rejects(verifySource(s.api, signal, true));
});

test("a grantless completed recovery that released a hold wakes ordinary pickup once", async (t) => {
  const s = interruptedFixture();
  t.mock.method(Ledger.prototype, "read", () => s.ledger.read());
  s.parent.conclusion = "success";
  s.ticket.automatic.runId = "600";
  s.parent.display_title = `Automatic factory / wake ${"a".repeat(64)}`;
  s.parent.actor = s.parent.triggering_actor = { login: c.BOT, id: c.BOT_ID };
  s.ticket.status = "blocked";
  s.ledger.state.active = null;
  s.ledger.state.grants.code.runId = "600";
  s.ticket.publishedRecovery = { interruptedHead: s.ticket.head };
  assert.equal((await handleWake(s)).outcome, "ignored");
  s.ledger.state.audit.push({
    event: "published_review_terminal_run_released", ticket: 12, runId: "600", runAttempt: 1,
    receiverRunId: "700", receiverAttempt: 1, receiverSha: s.parent.head_sha,
  });
  const result = await handleWake(s);
  assert.equal(result.outcome, "dispatched");
  const { signal } = s.store.state.receipts[result.receiptId];
  assert.equal(signal.revision, "app-release");
  await verifySource(s.api, signal, false);
  assert.equal((await handleWake(s)).outcome, "duplicate");
  s.ledger.state.audit[0].receiverSha = "f".repeat(40);
  await assert.rejects(verifySource(s.api, signal, true));
});
