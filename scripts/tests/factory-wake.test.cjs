const test = require("node:test");
const assert = require("node:assert/strict");
let wake;
try {
  wake = require("../factory/wake-controller.cjs");
} catch (e) {
  if (e.code !== "MODULE_NOT_FOUND") throw e;
}
const { fixture, receiverSetup } = require("./helpers/event-fixtures.cjs");

test("wake receipts have a trusted implementation", () => assert.ok(wake));
test("owner issue wake records intent before one dispatch; duplicate events never dispatch twice", async () => {
  const s = fixture();
  const first = await wake.handleWake(s);
  assert.equal(first.outcome, "dispatched");
  assert.equal(s.dispatches.length, 1);
  assert.equal(s.intentAtDispatch.status, "intent");
  assert.equal(s.dispatches[0].ref, "main");
  assert.equal(s.dispatches[0].inputs.dry_run, false);
  assert.equal((await wake.handleWake(s)).outcome, "duplicate");
  assert.equal(s.dispatches.length, 1);
});
test("preview and absent opt-in cannot dispatch or initialize metadata", async () => {
  for (const changes of [{ preview: true }, { vars: {} }]) {
    const s = Object.assign(fixture(), changes);
    await wake.handleWake(s);
    assert.equal(s.dispatches.length, 0);
    assert.equal(s.store.writes, 0);
  }
});
test("foreign issues, comment events, closed issues and edited admitted criteria cannot wake coding", async () => {
  for (const change of [
    (s) => (s.issue.user.login = "stranger"),
    (s) => (s.event.action = "commented"),
    (s) => (s.issue.state = "closed"),
    (s) => (s.ledger.state.tickets["12"] = { criteriaHash: "f".repeat(64) }),
  ]) {
    const s = fixture();
    change(s);
    assert.equal((await wake.handleWake(s)).outcome, "ignored");
    assert.equal(s.dispatches.length, 0);
  }
});
test("full capacity retains a pending signal without dispatch or a model reservation", async () => {
  const s = fixture();
  s.ledger.state.active = { ticket: 9, runId: "9", runAttempt: 1 };
  assert.equal((await wake.handleWake(s)).outcome, "busy");
  assert.equal(s.dispatches.length, 0);
  assert.equal(Object.values(s.store.state.receipts)[0].status, "pending");
  assert.deepEqual(s.ledger.state.grants, {});
});
test("an uncertain POST is retained and never retried blindly", async () => {
  const s = fixture();
  s.uncertain = true;
  assert.equal((await wake.handleWake(s)).outcome, "uncertain");
  assert.equal((await wake.handleWake(s)).outcome, "duplicate");
  assert.equal(s.dispatches.length, 1);
  assert.equal(Object.values(s.store.state.receipts)[0].status, "intent");
});
test("stop blocks wake and never changes usage state", async () => {
  const s = fixture();
  s.ledger.state.stop = {};
  const before = structuredClone(s.ledger.state);
  assert.equal((await wake.handleWake(s)).outcome, "stopped");
  assert.deepEqual(s.ledger.state, before);
  assert.equal(s.dispatches.length, 0);
});

test("only a real bot dispatch can bind an intent and survive policy reservation without impersonating owner", async () => {
  const {
    verifyWake,
    isTrustedWakeContext,
    allowedModelBots,
  } = require("../factory/trusted-wake.cjs");
  const p = require("../factory/policy.cjs");
  const { vars } = require("./helpers/factory-fixtures.cjs");
  const s = await receiverSetup();
  s.store.state.receipts[s.receiptId].status = "intent";
  const proof = await verifyWake({ ...s, lane: "app", bind: true });
  const context = {
    ...s.context,
    wake: proof,
    ticket: 12,
    head: "a".repeat(40),
    phase: "code",
    slot: "cycle1",
  };
  assert.equal(isTrustedWakeContext(context), true);
  const config = p.readConfig({
    ...vars,
    FACTORY_EVENT_PICKUP_ENABLED: "true",
    FACTORY_AUTOMATION_ENABLED: "true",
    FACTORY_GITHUB_APP_CLIENT_ID: "Iv1.fixture123456",
    FACTORY_GITHUB_APP_SLUG: "fixture-factory",
  });
  const result = p.reserve(p.emptyState(s.context.repository), context, config);
  assert.equal(result.state.audit.at(-1).actor, "github-actions[bot]");
  assert.equal(s.store.state.receipts[s.receiptId].receiver.runId, "900");
  const ticket = result.state.tickets["12"];
  ticket.automatic = {
    workflowRef: context.workflowRef,
    workflowSha: context.workflowSha,
    runId: context.runId,
    runAttempt: context.runAttempt,
    appSlug: config.appSlug,
  };
  assert.equal(p.preflight(result.state, result.grant.id, context, config).id, result.grant.id);
  assert.equal(allowedModelBots(context, ticket), "github-actions[bot]");
  assert.equal(allowedModelBots({ ...context, phase: "review" }, ticket), "github-actions[bot]");
  for (const invalid of [
    { ...context, wake: undefined },
    { ...context, wake: JSON.parse(JSON.stringify(proof)) },
    { ...context, runId: "901" },
    { ...context, runAttempt: 2 },
    { ...context, actor: "another[bot]" },
    { ...context, triggeringActor: "haideearus" },
    { ...context, workflowRef: context.workflowRef.replace("automatic", "dependencies") },
  ])
    assert.equal(allowedModelBots(invalid, ticket), "");
  for (const outsideScope of [
    { ...ticket, automatic: undefined },
    { ...ticket, finding: {} },
    { ...ticket, origin: "dependency-pr" },
    { ...ticket, origin: "drill" },
    { ...ticket, origin: "owner-pr" },
  ])
    assert.equal(allowedModelBots(context, outsideScope), "");
  assert.equal(
    isTrustedWakeContext({ ...context, wake: JSON.parse(JSON.stringify(proof)) }),
    false
  );
});
test("forged actor, rerun, workflow path/SHA, changed source and failed producer fail closed", async () => {
  const { verifyWake } = require("../factory/trusted-wake.cjs");
  for (const mutate of [
    (s) => (s.context.actor = "stranger"),
    (s) => (s.context.runAttempt = 2),
    (s) => (s.receiver.path = ".github/workflows/factory-agents.yml"),
    (s) => (s.receiver.head_sha = "f".repeat(40)),
    (s) => (s.issue.body = "changed acceptance criteria"),
    (s) => Object.assign(s.run, { status: "completed", conclusion: "failure" }),
  ]) {
    const s = await receiverSetup();
    mutate(s);
    await assert.rejects(verifyWake({ ...s, lane: "app", bind: true }));
    assert.equal(s.store.state.receipts[s.receiptId].receiver, null);
  }
});
test("a receipt admits one receiver only, including when receiver beats producer acknowledgment", async () => {
  const { verifyWake } = require("../factory/trusted-wake.cjs");
  const s = await receiverSetup();
  s.store.state.receipts[s.receiptId].status = "intent";
  await verifyWake({ ...s, lane: "app", bind: true });
  s.context.runId = "901";
  s.receiver.id = 901;
  const base = s.api.request;
  s.api.request = (m, p, b) =>
    p.includes("/runs/901/") ? Promise.resolve(s.receiver) : base(m, p, b);
  await assert.rejects(verifyWake({ ...s, lane: "app", bind: true }), /bound|receiver/);
  assert.equal(s.store.state.receipts[s.receiptId].receiver.runId, "900");
});
test("retained bound provenance remains verifiable after its issue closes, without admitting a new receiver", async () => {
  const { verifyWake } = require("../factory/trusted-wake.cjs");
  const s = await receiverSetup();
  await verifyWake({ ...s, lane: "app", bind: true });
  s.issue.state = "closed";
  await verifyWake({ ...s, lane: "app", bind: false });
  assert.equal(s.store.state.receipts[s.receiptId].receiver.runId, "900");
});
test("an activity observer sees an early receipt as pending without binding or authorizing it", async () => {
  const { isTrustedWakeContext } = require("../factory/trusted-wake.cjs");
  const { observeRun } = require("../factory/activity-observer.cjs");
  const s = await receiverSetup();
  s.store.state.receipts[s.receiptId].status = "intent";
  const base = s.api.request;
  s.api.request = (m, p, b) =>
    p.endsWith("/git/ref/heads/factory/wakes")
      ? Promise.resolve({ object: { sha: "b".repeat(40) } })
      : p.includes("/contents/wakes.json")
        ? Promise.resolve({
            type: "file",
            encoding: "base64",
            content: Buffer.from(JSON.stringify(s.store.state)).toString("base64"),
          })
        : base(m, p, b);
  s.api.pages = async () => [];
  const writes = s.store.writes;
  assert.equal(
    (await observeRun({ ...s, runId: 900, runAttempt: 1, preview: true })).outcome,
    "awaiting_binding"
  );
  assert.equal(s.store.writes, writes);
  assert.equal(isTrustedWakeContext(s.context), false);
  await require("../factory/trusted-wake.cjs").verifyWake({ ...s, lane: "app", bind: true });
  assert.equal(
    (await observeRun({ ...s, runId: 900, runAttempt: 1, preview: true })).outcome,
    "preview"
  );
});
