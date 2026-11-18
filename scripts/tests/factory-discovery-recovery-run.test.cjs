const test = require("node:test"),
  assert = require("node:assert/strict");
test("recovery admission requires paused automation, discovery off and idle un-stopped ledger", () => {
  const { allowed } = require("../factory/discovery-recovery-run.cjs");
  const state = { version: 2, activeTickets: {}, tickets: {}, stop: null };
  const cfg = { enabled: true, automatic: false, autoMerge: false, discovery: false };
  assert.equal(allowed(state, cfg), true);
  for (const change of [
    { enabled: false },
    { automatic: true },
    { autoMerge: true },
    { discovery: true },
  ])
    assert.equal(allowed(state, { ...cfg, ...change }), false);
  assert.equal(allowed({ ...state, stop: { reason: "stop" } }, cfg), false);
  assert.equal(
    allowed({ ...state, activeTickets: { 92: { ticket: 92, runId: "100", runAttempt: 1 } } }, cfg),
    false
  );
  assert.equal(allowed({ ...state, tickets: { 1: { merge: { status: "intent" } } } }, cfg), false);
});
test("recovery normalizes a narrow context and never runs on owner branch or retry", () => {
  const { contextFor } = require("../factory/discovery-recovery-run.cjs");
  const r = require("../factory/discovery-recovery-contract.cjs");
  const env = {
    GITHUB_REPOSITORY: "haideearus/cypress-realworld-app",
    GITHUB_ACTOR: "haideearus",
    GITHUB_TRIGGERING_ACTOR: "haideearus",
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF: r.WORKFLOW_REF,
    GITHUB_WORKFLOW_SHA: "b".repeat(40),
    GITHUB_RUN_ID: "500",
    GITHUB_RUN_ATTEMPT: "1",
  };
  assert.equal(contextFor(env, "501").ciRunId, "501");
  assert.throws(() => contextFor({ ...env, GITHUB_RUN_ATTEMPT: "2" }, "501"));
  assert.throws(() => contextFor({ ...env, GITHUB_REF: "refs/heads/agent/recovery" }, "501"));
});
function trialSetup(patch = {}) {
  const r = require("../factory/discovery-recovery-contract.cjs");
  const f = require("../factory/discovery-finding-contract.cjs");
  const vars = {
    ...require("./helpers/factory-fixtures.cjs").vars,
    FACTORY_ENABLED: "true",
    FACTORY_DISCOVERY_ENABLED: "false",
    FACTORY_AUTOMATION_ENABLED: "false",
    FACTORY_AUTOMERGE_ENABLED: "false",
    ...patch,
  };
  const env = {
    GITHUB_REPOSITORY: "haideearus/cypress-realworld-app",
    GITHUB_ACTOR: "haideearus",
    GITHUB_TRIGGERING_ACTOR: "haideearus",
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF: r.WORKFLOW_REF,
    GITHUB_WORKFLOW_SHA: "b".repeat(40),
    GITHUB_RUN_ID: "500",
    GITHUB_RUN_ATTEMPT: "1",
    FACTORY_VARIABLES: JSON.stringify(vars),
    FACTORY_INPUTS: JSON.stringify({ operation: "preview", dry_run: true }),
  };
  const controls = {
    version: 2,
    activeTickets: {},
    tickets: { 92: { coding: 0, reviews: 0, retries: 0, status: "blocked" } },
    grants: { used: { status: "finished", outcome: "blocked" } },
    days: { "2026-11-18": [92] },
    stop: null,
  };
  const registry = f.emptyFindings();
  let writes = 0;
  return {
    env,
    controls,
    registry,
    getWrites: () => writes,
    deps: {
      api: {
        request: () => {
          throw Error("unexpected network");
        },
      },
      ledger: {
        read: async () => ({ state: structuredClone(controls) }),
        update: () => {
          throw Error("must never write usage");
        },
      },
      store: {
        read: async () => ({ state: structuredClone(registry) }),
        update: async (fn) => {
          writes++;
          return fn(registry);
        },
      },
      testedMain: async () => ({ ciRunId: "501" }),
      provenance: {
        verifyProducer: async () => ({ status: "in_progress" }),
        verifyOriginal: async () => ({ artifact: {} }),
      },
      now: new Date("2026-11-18T12:00:00Z"),
    },
  };
}
test("preview is read-only under live production switches and cannot reserve or call a model", async () => {
  const trial = trialSetup({
    FACTORY_AUTOMATION_ENABLED: "true",
    FACTORY_AUTOMERGE_ENABLED: "true",
    FACTORY_GITHUB_APP_CLIENT_ID: "Iv1.fixture123",
    FACTORY_GITHUB_APP_SLUG: "fixture-app",
  });
  const saved = JSON.stringify(trial.controls);
  const result = await require("../factory/discovery-recovery-run.cjs").main(trial.env, trial.deps);
  assert.equal(result.outcome, "recovery_preview");
  assert.equal(result.eligible, false);
  assert.equal(result.ready, false);
  assert.equal(result.modelCalls, 0);
  assert.equal(trial.getWrites(), 0);
  assert.equal(JSON.stringify(trial.controls), saved);
});
test("manual recovery reserves only finding replay metadata and never refunds source counters", async () => {
  const trial = trialSetup(),
    saved = JSON.stringify(trial.controls);
  trial.env.FACTORY_INPUTS = JSON.stringify({ operation: "run", dry_run: false });
  const result = await require("../factory/discovery-recovery-run.cjs").main(trial.env, trial.deps);
  assert.equal(result.ready, true);
  assert.equal(result.modelCalls, 0);
  assert.equal(trial.getWrites(), 1);
  assert.equal(JSON.stringify(trial.controls), saved);
  assert.equal(
    trial.registry.imports[require("../factory/discovery-recovery-contract.cjs").SOURCE.grantId]
      .recoveries.length,
    1
  );
});
test("active stop or pickup opt-in vetoes a live recovery before metadata reservation", async () => {
  for (const patch of [
    { FACTORY_DISCOVERY_ENABLED: "true" },
    {
      FACTORY_AUTOMATION_ENABLED: "true",
      FACTORY_GITHUB_APP_CLIENT_ID: "Iv1.fixture123",
      FACTORY_GITHUB_APP_SLUG: "fixture-app",
    },
  ]) {
    const trial = trialSetup(patch);
    trial.env.FACTORY_INPUTS = JSON.stringify({ operation: "run", dry_run: false });
    await assert.rejects(
      require("../factory/discovery-recovery-run.cjs").main(trial.env, trial.deps),
      /paused/
    );
    assert.equal(trial.getWrites(), 0);
  }
  const trial = trialSetup();
  trial.controls.stop = { reason: "stop" };
  trial.env.FACTORY_INPUTS = JSON.stringify({ operation: "run", dry_run: false });
  await assert.rejects(
    require("../factory/discovery-recovery-run.cjs").main(trial.env, trial.deps),
    /paused/
  );
  assert.equal(trial.getWrites(), 0);
});
test("provider API environment is rejected before reading state", async () => {
  await assert.rejects(
    require("../factory/discovery-recovery-run.cjs").main({
      ANTHROPIC_API_KEY: "fixture-disallowed",
    }),
    /subscription/
  );
});
test("stop after replay closes the permit held without assessing artifacts or changing usage", async () => {
  const trial = trialSetup(),
    r = require("../factory/discovery-recovery-contract.cjs");
  const ctx = require("../factory/discovery-recovery-run.cjs").contextFor(trial.env, "501");
  const receipt = r.reserve(trial.registry, ctx, "2026-11-18");
  trial.controls.stop = { reason: "operator-stop" };
  const saved = JSON.stringify(trial.controls);
  trial.env.FACTORY_OPERATION = "finish";
  trial.env.FACTORY_REPLAY_SUCCESS = "true";
  trial.env.FACTORY_INPUTS = JSON.stringify({
    receiptId: receipt.proof.id,
    artifactName: r.artifactName(receipt.proof),
  });
  const result = await require("../factory/discovery-recovery-run.cjs").main(trial.env, trial.deps);
  assert.equal(result.outcome, "held");
  assert.equal(r.dailyUsage(trial.registry, "2026-11-18"), 1);
  assert.equal(JSON.stringify(trial.controls), saved);
  assert.equal(trial.getWrites(), 1);
});
test("metadata reconciliation of a failed replay retains its consumed permit and cannot reserve again", async () => {
  const trial = trialSetup(),
    r = require("../factory/discovery-recovery-contract.cjs");
  const ctx = require("../factory/discovery-recovery-run.cjs").contextFor(trial.env, "501");
  const receipt = r.reserve(trial.registry, ctx, "2026-11-18");
  trial.env.GITHUB_RUN_ID = "502";
  trial.deps.api.pages = async () => [];
  trial.env.FACTORY_INPUTS = JSON.stringify({ operation: "reconcile", dry_run: false });
  const result = await require("../factory/discovery-recovery-run.cjs").main(trial.env, trial.deps);
  assert.equal(result.outcome, "held");
  assert.equal(r.dailyUsage(trial.registry, "2026-11-18"), 1);
  assert.equal(receipt.proof.context.runId, "500");
  assert.equal(receipt.confirmation.runId, "502");
  assert.equal(trial.getWrites(), 1);
});
