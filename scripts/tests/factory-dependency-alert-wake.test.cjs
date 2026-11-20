const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, sha } = require("./helpers/event-fixtures.cjs");
const { alertBranch } = require("../factory/dependency-contract.cjs");
const { issueTitle, issueBody, READY_LABEL } = require("../factory/dependency-alert-repair.cjs");
const { handleWake } = require("../factory/wake-controller.cjs");
const { verifyWake, allowedModelBots } = require("../factory/trusted-wake.cjs");
const { DependencyCoordinator } = require("../factory/dependencies.cjs");
const { claimDependency } = require("../factory/dependency-policy.cjs");
const { readConfig } = require("../factory/policy.cjs");
const { vars: factoryVars } = require("./helpers/factory-fixtures.cjs");

const key = "c".repeat(64);
const head = "b".repeat(40);
const ciPath = ".github/workflows/factory-ci.yml";
const dependencyPath = ".github/workflows/factory-dependencies.yml";

function alertWake() {
  const s = fixture();
  const repo = { full_name: s.context.repository };
  Object.assign(s.vars, {
    FACTORY_DEPENDENCY_ALERT_REPAIR_ENABLED: "true",
    FACTORY_GITHUB_APP_SLUG: "factory-example",
  });
  s.context.event = s.run.event = "workflow_run";
  s.event = {
    repository: repo,
    action: "completed",
    workflow_run: { id: 700, run_attempt: 1, path: ciPath },
  };
  const app = { login: "factory-example[bot]", type: "Bot", id: 801 };
  s.pr = {
    number: 22,
    state: "open",
    draft: false,
    user: { ...app },
    head: { sha: head, ref: alertBranch(key), repo },
    base: { sha, ref: "main", repo },
  };
  s.ci = {
    ...s.run,
    id: 700,
    path: ciPath,
    workflow_id: 70,
    event: "pull_request",
    actor: { ...app },
    triggering_actor: { ...app },
    head_branch: s.pr.head.ref,
    head_sha: head,
    status: "completed",
    conclusion: "success",
    display_title: "Factory CI / 22",
    pull_requests: [{ number: 22 }],
  };
  s.files = [{ filename: "yarn.lock", status: "modified" }];
  s.jobs = [
    { name: "verify", run_id: 700, head_sha: head, status: "completed", conclusion: "success" },
  ];
  s.record = {
    name: "example",
    candidate: "1.1.0",
    day: "2026-11-20",
    base: sha,
    head,
    issue: 8,
    pr: 22,
    phase: "ready",
  };
  s.issue = {
    number: 8,
    state: "open",
    user: { login: "github-actions[bot]", id: 41898282 },
    labels: [{ name: READY_LABEL }],
    title: issueTitle(s.record),
    body: issueBody(key, s.record),
  };
  s.main = sha;
  s.compare = { behind_by: 0, merge_base_commit: { sha }, files: s.files };
  s.native = {
    ...structuredClone(s.pr),
    number: 17,
    head: { sha: head, ref: "dependabot/npm_and_yarn/demo-1.0.1", repo },
    user: { login: "dependabot[bot]", type: "Bot", id: 49699333 },
  };
  const request = s.api.request;
  s.api.request = async (method, path, body) => {
    if (method === "GET") {
      if (path.endsWith(`/actions/workflows/factory-ci.yml`)) return { id: 70, path: ciPath };
      if (path.endsWith("/actions/runs/700/attempts/1")) return structuredClone(s.ci);
      if (path.endsWith("/pulls/22")) return structuredClone(s.pr);
      if (path.endsWith("/pulls/17")) return structuredClone(s.native);
      if (path.includes("/pulls?state=open&base=main")) return structuredClone([s.native, s.pr]);
      if (path.includes("/issues?state=open&labels=factory-ready")) return [];
      if (/\/pulls\/(17|22)\/files\?per_page=3$/.test(path))
        return structuredClone(s.cachedPrFiles || s.files);
      if (path.endsWith("/git/ref/heads/factory/dependency-alerts"))
        return { object: { sha: key.slice(0, 40) } };
      if (path.includes("/contents/dependency-alerts.json?ref=")) {
        const records = s.record ? { [key]: s.record } : {};
        return {
          type: "file",
          encoding: "base64",
          content: Buffer.from(JSON.stringify({ version: 1, cursor: 0, records })).toString(
            "base64"
          ),
        };
      }
      if (path.endsWith("/issues/8")) return structuredClone(s.issue);
      if (path.endsWith("/git/ref/heads/main")) return { object: { sha: s.main } };
      if (path.endsWith(`/compare/${sha}...${head}`)) return structuredClone(s.compare);
      if (path.endsWith("/actions/workflows/factory-dependencies.yml"))
        return { id: 90, path: dependencyPath };
      if (path.endsWith("/actions/runs/900/attempts/1")) return structuredClone(s.receiver);
    }
    return request(method, path, body);
  };
  s.api.pages = async (path, field) => {
    assert.ok(path.endsWith("/actions/runs/700/attempts/1/jobs"));
    assert.equal(field, "jobs");
    return structuredClone(s.jobs);
  };
  return s;
}

function receiverInput(s, receiptId) {
  const actor = { login: "github-actions[bot]", id: 41898282 };
  s.receiver = {
    ...s.run,
    id: 900,
    workflow_id: 90,
    path: dependencyPath,
    actor,
    triggering_actor: actor,
    event: "workflow_dispatch",
    display_title: `Dependency maintenance / wake ${receiptId}`,
  };
  return {
    ...s,
    receiptId,
    lane: "dependency",
    bind: true,
    context: {
      ...s.context,
      actor: actor.login,
      triggeringActor: actor.login,
      event: "workflow_dispatch",
      runId: "900",
      workflowRef: `${s.context.repository}/${dependencyPath}@refs/heads/main`,
    },
  };
}

test("current green Factory CI wakes a receipt-backed alert PR and binds one Dependency maintenance run", async () => {
  const s = alertWake();
  const result = await handleWake(s);
  assert.equal(result.outcome, "dispatched");
  assert.equal(result.lane, "dependency");
  assert.deepEqual(s.dispatches, [
    { ref: "main", inputs: { wake_id: result.receiptId, preview: false } },
  ]);
  assert.equal(s.intentAtDispatch.signal.number, 22);
  assert.equal(s.intentAtDispatch.signal.head, head);
  assert.equal(s.intentAtDispatch.status, "intent");
  const proof = await verifyWake(receiverInput(s, result.receiptId));
  assert.equal(proof.sourceActor, "factory-example[bot]");
  assert.equal(s.store.state.receipts[result.receiptId].receiver.runId, "900");
  assert.equal((await handleWake(s)).outcome, "duplicate");
  assert.equal(s.dispatches.length, 1);
});

test("generated CI wake requires the configured App, exact receipt, and current PR evidence", async (t) => {
  for (const [name, change] of [
    ["alert opt-in disabled", (s) => (s.vars.FACTORY_DEPENDENCY_ALERT_REPAIR_ENABLED = "false")],
    ["other App", (s) => (s.vars.FACTORY_GITHUB_APP_SLUG = "another-app")],
    ["CI actor differs from PR author", (s) => (s.ci.actor.id = 802)],
    ["no linked PR on the run", (s) => (s.ci.pull_requests = [])],
    ["main push instead of PR CI", (s) => (s.ci.event = "push")],
    ["missing alert receipt", (s) => (s.record = null)],
    ["held alert ticket", (s) => (s.issue.labels = [{ name: "factory-dependency-held" }])],
    ["stale head", (s) => (s.ci.head_sha = "d".repeat(40))],
    ["stale base", (s) => (s.main = "d".repeat(40))],
    ["base is outside head history", (s) => (s.compare.behind_by = 1)],
    ["manifest edits", (s) => s.files.push({ filename: "package.json", status: "modified" })],
    ["failed verify job", (s) => (s.jobs[0].conclusion = "failure")],
    ["verify job from a different run", (s) => (s.jobs[0].run_id = 701)],
  ]) {
    await t.test(name, async () => {
      const s = alertWake();
      change(s);
      assert.equal((await handleWake(s)).outcome, "ignored");
      assert.deepEqual(s.dispatches, []);
      assert.deepEqual(s.store.state.receipts, {});
    });
  }
});

test("a generated CI wake cannot bind after the alert ticket loses readiness", async () => {
  const s = alertWake();
  const { receiptId, outcome } = await handleWake(s);
  assert.equal(outcome, "dispatched");
  s.issue.labels = [];
  await assert.rejects(verifyWake(receiverInput(s, receiptId)), /alert|dependency/i);
  assert.equal(s.store.state.receipts[receiptId].receiver, null);
});

test("capacity drain dispatches the original exact dependency CI receipt once", async () => {
  const s = alertWake();
  s.ledger.state.active = { ticket: 9, runId: "701", runAttempt: 1 };
  const pending = await handleWake(s);
  assert.equal(pending.outcome, "busy");
  assert.equal(s.dispatches.length, 0);
  s.ledger.state.active = null;
  s.ledger.state.grants = {
    used: { id: "used", ticket: 9, runId: "701", runAttempt: 1, status: "finished" },
  };
  s.event.workflow_run = { id: 701, run_attempt: 1, path: dependencyPath };
  const request = s.api.request;
  s.api.request = async (method, path, body) =>
    method === "GET" && path.endsWith("/actions/runs/701/attempts/1")
      ? {
          ...s.run,
          id: 701,
          workflow_id: 90,
          path: dependencyPath,
          status: "completed",
          conclusion: "success",
        }
      : request(method, path, body);
  const drained = await handleWake(s);
  assert.equal(drained.outcome, "dispatched");
  assert.equal(drained.receiptId, pending.receiptId);
  const proof = await verifyWake(receiverInput(s, drained.receiptId));
  assert.equal(proof.sourceActor, "factory-example[bot]");
  assert.equal((await handleWake(s)).outcome, "duplicate");
  assert.equal(s.dispatches.length, 1);
});

test("a CI wake selects its own PR and allows only the bound dependency review bot", async (t) => {
  for (const number of [22, 17]) {
    await t.test(`PR ${number}`, async () => {
      const s = alertWake();
      if (number === 17)
        Object.assign(s.ci, {
          actor: { ...s.native.user },
          triggering_actor: { ...s.native.user },
          head_branch: s.native.head.ref,
          display_title: "Factory CI / 17",
          pull_requests: [{ number: 17 }],
        });
      const dispatched = await handleWake(s);
      assert.equal(dispatched.outcome, "dispatched");
      const input = receiverInput(s, dispatched.receiptId);
      const context = {
        ...input.context,
        wake: await verifyWake(input),
        ticket: number,
        head,
        phase: "review",
        slot: "dependency",
      };
      const config = readConfig({
        ...factoryVars,
        ...s.vars,
        FACTORY_GITHUB_APP_CLIENT_ID: "Iv123456789",
      });
      assert.throws(
        () =>
          claimDependency(
            s.ledger.state,
            number === 22 ? s.native : s.pr,
            context,
            config,
            new Date(),
            s.record
          ),
        /wake/i
      );
      if (number === 22) {
        const scheduled = new DependencyCoordinator(s.api, config, {
          ...context,
          actor: "haideearus",
          triggeringActor: "haideearus",
          event: "schedule",
          runId: "901",
          wake: undefined,
        });
        scheduled.ledger = s.ledger;
        assert.equal((await scheduled.select(true)).ticket, 17);
      }
      const coordinator = new DependencyCoordinator(s.api, config, context);
      coordinator.ledger = s.ledger;
      assert.deepEqual(await coordinator.select(false), {
        ready: true,
        mode: "review",
        ticket: number,
        head,
      });
      const ticket = s.ledger.state.tickets[number];
      assert.equal(allowedModelBots(context, ticket), "github-actions[bot]");
      for (const invalid of [
        { ...context, wake: structuredClone(context.wake) },
        { ...context, ticket: 99 },
        { ...context, head: sha },
        { ...context, phase: "code" },
        { ...context, slot: "cycle1" },
        { ...context, runId: "901" },
      ])
        assert.equal(allowedModelBots(invalid, ticket), "");
      assert.equal(allowedModelBots(context, { ...ticket, pr: 99 }), "");
      assert.equal(allowedModelBots(context, { ...ticket, head: sha }), "");
    });
  }
});

test("green alert CI with cached base uses the receipt and proves the current base at bind", async () => {
  const s = alertWake();
  s.pr.base.sha = "e".repeat(40);
  s.cachedPrFiles = [{ filename: ".github/workflows/factory-ci.yml", status: "modified" }];
  const result = await handleWake(s);
  assert.equal(result.outcome, "dispatched");
  assert.equal(s.intentAtDispatch.signal.revision, s.record.base);
  await verifyWake(receiverInput(s, result.receiptId));
  assert.equal(s.store.state.receipts[result.receiptId].receiver.runId, "900");
});

test("cached alert metadata cannot allow an out-of-scope Git diff", async () => {
  const s = alertWake();
  s.pr.base.sha = "e".repeat(40);
  s.compare.files.push({ filename: "package.json", status: "modified" });
  assert.equal((await handleWake(s)).outcome, "ignored");
  assert.deepEqual(s.dispatches, []);
});
