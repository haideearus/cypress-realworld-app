const { test } = require("node:test");
const assert = require("node:assert/strict");
const c = require("../factory/wake-contract.cjs");
const d = require("../factory/dependency-contract.cjs");
const lifecycle = require("../factory/dependency-policy.cjs");
const policy = require("../factory/policy.cjs");
const trusted = require("../factory/trusted-wake.cjs");
const { fixture, sha: base } = require("./helpers/event-fixtures.cjs");
const { vars } = require("./helpers/factory-fixtures.cjs");

const number = 17;
const head = "b".repeat(40);
const published = "c".repeat(40);
const ciPath = ".github/workflows/factory-ci.yml";
const config = policy.readConfig({
  ...vars,
  FACTORY_AUTOMATION_ENABLED: "true",
  FACTORY_EVENT_PICKUP_ENABLED: "true",
  FACTORY_GITHUB_APP_CLIENT_ID: "Iv123456789",
  FACTORY_GITHUB_APP_SLUG: "factory-example",
});

function receiver() {
  const s = fixture();
  const repo = { full_name: c.REPOSITORY };
  const bot = { login: c.BOT, id: c.BOT_ID, type: "Bot" };
  const native = { login: "dependabot[bot]", id: 49699333, type: "Bot" };
  s.context.event = s.run.event = "workflow_run";
  s.pr = {
    number,
    state: "open",
    draft: false,
    user: native,
    head: { sha: head, ref: "dependabot/npm_and_yarn/demo-2.0.0", repo },
    base: { sha: base, ref: "main", repo },
  };
  s.ci = {
    ...s.run,
    id: 700,
    workflow_id: 70,
    path: ciPath,
    status: "completed",
    conclusion: "failure",
    event: "pull_request",
    head_sha: head,
    head_branch: s.pr.head.ref,
    actor: native,
    triggering_actor: native,
    display_title: `Factory CI / ${number}`,
    pull_requests: [{ number }],
  };
  const job = { status: "completed", conclusion: "failure", run_id: 700, head_sha: head };
  s.jobs = [
    { ...job, name: "verify" },
    {
      ...job,
      name: "app",
      steps: [{ name: "Run yarn types && yarn lint && yarn test:unit:ci", conclusion: "failure" }],
    },
  ];
  const receipt = c.createWake({
    signal: {
      kind: "dependency-failed-ci",
      lane: "dependency",
      number,
      head,
      revision: base,
      criteriaHash: d.criteria(number),
      sourceRun: "700",
      sourceAttempt: 1,
      actor: { login: native.login, id: native.id },
    },
    producer: {
      runId: s.context.runId,
      runAttempt: 1,
      workflowSha: base,
      actor: { login: s.run.actor.login, id: s.run.actor.id },
      event: "workflow_run",
    },
  });
  receipt.status = "sent";
  s.store.state.receipts[receipt.id] = receipt;
  s.caller = {
    ...s.context,
    actor: bot.login,
    triggeringActor: bot.login,
    event: "workflow_dispatch",
    runId: "900",
    workflowRef: d.WORKFLOW,
  };
  s.receiver = {
    ...s.run,
    id: 900,
    workflow_id: 90,
    path: ".github/workflows/factory-dependencies.yml",
    event: "workflow_dispatch",
    actor: bot,
    triggering_actor: bot,
    display_title: `Dependency maintenance / wake ${receipt.id}`,
  };
  const request = s.api.request;
  s.api.request = async (method, path, body) => {
    if (method === "GET") {
      if (path.endsWith("/actions/workflows/factory-ci.yml")) return { id: 70, path: ciPath };
      if (path.endsWith("/actions/runs/700/attempts/1")) return structuredClone(s.ci);
      if (path.endsWith("/actions/runs/700/attempts/1/jobs?per_page=100"))
        return { jobs: structuredClone(s.jobs) };
      if (path.endsWith("/actions/workflows/factory-dependencies.yml"))
        return { id: 90, path: s.receiver.path };
      if (path.endsWith("/actions/runs/900/attempts/1")) return structuredClone(s.receiver);
      if (path.endsWith(`/pulls/${number}`)) return structuredClone(s.pr);
      if (path.endsWith(`/pulls/${number}/files?per_page=3`))
        return [{ filename: "yarn.lock", status: "modified" }];
      if (path.endsWith("/git/ref/heads/factory/state")) return { object: { sha: base } };
      if (path.includes("/contents/state.json?ref="))
        return {
          type: "file",
          encoding: "base64",
          content: Buffer.from(JSON.stringify(s.ledger.state)).toString("base64"),
        };
    }
    return request(method, path, body);
  };
  s.bind = () =>
    trusted.verifyWake({
      api: s.api,
      context: s.caller,
      receiptId: receipt.id,
      lane: "dependency",
      bind: true,
      store: s.store,
    });
  return s;
}

test("a failed native CI binds only its exact source head and verified app failure", async () => {
  const s = receiver();
  s.jobs[1].steps[0].conclusion = "success";
  await assert.rejects(s.bind, /failed CI proof/i);
  s.jobs[1].steps[0].conclusion = "failure";
  const proof = await s.bind();
  const context = { ...s.caller, wake: proof };
  assert.deepEqual(trusted.dependencyWakeTarget(context), {
    number,
    head,
    base,
    compatibility: true,
  });
  s.pr.head.sha = published;
  await assert.rejects(s.bind, /without a confirmed same-run repair/i);
});

test("only same-run confirmed branch publication can extend a failed receipt to readonly review", async () => {
  const s = receiver();
  const proof = await s.bind();
  const context = { ...s.caller, wake: proof, ticket: number, phase: "code", slot: "cycle1", head };
  const admit = lifecycle.claimDependency(s.ledger.state, s.pr, context, config);
  const claim = lifecycle.reserveDependencyCompatibility(admit, number, context, config, {
    package: { name: "demo", version: "2.0.0" },
    reason: "native_ci_failure",
  });
  const review = { ...context, phase: "review", slot: "dependency", head };
  const code = { ...context, phase: "code", slot: d.COMPATIBILITY_SLOT, head };
  assert.equal(trusted.allowedModelBots(code, claim.state.tickets[number]), c.BOT);
  assert.equal(trusted.allowedModelBots(review, claim.state.tickets[number]), "");
  const evidence = { grantId: claim.grant.id, originalHead: head, head: published, base };
  const intent = lifecycle.beginDependencyCompatibilityPublish(
    claim.state,
    number,
    context,
    config,
    evidence
  );
  s.pr.head.sha = published;
  s.ledger.state = intent;
  await assert.rejects(s.bind, /without a confirmed same-run repair/i);
  s.ledger.state = lifecycle.recordDependencyCompatibility(
    intent,
    number,
    context,
    config,
    evidence
  );
  const current = s.ledger.state.tickets[number];
  const after = { ...review, head: published, wake: await s.bind() };
  assert.equal(trusted.allowedModelBots(after, current), c.BOT);
  assert.equal(trusted.allowedModelBots({ ...after, ticket: 99 }, current), "");
  assert.equal(trusted.allowedModelBots({ ...code, head: published }, current), "");
  assert.equal(
    await trusted.verifyPreparationOrigin(
      s.api,
      s.receiver,
      current,
      d.validateTicket(current),
      s.store
    ),
    true
  );
  s.ci.pull_requests = [];
  await assert.rejects(s.bind, /failed CI proof/i);
  const mergeCommit = "d".repeat(40);
  Object.assign(s.pr, { state: "closed", merged: true, merge_commit_sha: mergeCommit });
  current.merge = {
    status: "merged",
    head: published,
    pr: number,
    at: new Date().toISOString(),
    runId: "901",
    runAttempt: 1,
    mergeCommit,
  };
  await assert.rejects(s.bind, /failed CI proof/i);
  current.merge.runId = context.runId;
  await assert.doesNotReject(s.bind);
});
