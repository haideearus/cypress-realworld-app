const test = require("node:test"),
  assert = require("node:assert/strict");
const c = require("../factory/discovery-contract.cjs");
const f = require("../factory/discovery-finding-contract.cjs");
const fixture = require("./fixtures/discovery-recovery-source.json");
const modulePath = "../factory/discovery-recovery-contract.cjs";
function context(r, runId = "500") {
  return {
    repository: c.REPOSITORY,
    actor: "haideearus",
    triggeringActor: "haideearus",
    ref: "refs/heads/main",
    event: "workflow_dispatch",
    workflowRef: r.WORKFLOW_REF,
    workflowSha: "b".repeat(40),
    runId,
    runAttempt: 1,
    ciRunId: "501",
  };
}
test("only the exact saved bundle is accepted; original report/proposals stay intact", () => {
  const r = require(modulePath);
  assert.equal(r.validateBundle(fixture), fixture);
  for (const edit of [
    (b) => (b.report.findings[0].summary += "changed"),
    (b) => (b.batches[0].test += "changed"),
    (b) => (b.runAttempt = 2),
    (b) => (b.fixture = true),
    (b) => (b.grantId = "11111111-1111-4111-8111-111111111111"),
  ]) {
    const b = structuredClone(fixture);
    edit(b);
    assert.throws(() => r.validateBundle(b), /source|bundle|identity/i);
  }
});
test("recovery contexts are owner/manual/main/attempt1 and bind fresh helper CI", () => {
  const r = require(modulePath);
  const ctx = context(r);
  assert.equal(r.validateProof(r.makeProof(ctx)).context.runId, "500");
  const reordered = r.makeProof(ctx);
  reordered.source = Object.fromEntries(Object.entries(reordered.source).reverse());
  assert.equal(r.validateProof(reordered), reordered);
  for (const patch of [
    { actor: "other" },
    { triggeringActor: "other" },
    { event: "schedule" },
    { ref: "refs/heads/test" },
    { runAttempt: 2 },
    { ciRunId: "x" },
    { workflowRef: c.WORKFLOW_REF },
  ])
    assert.throws(() => r.makeProof({ ...ctx, ...patch }), /recovery/i);
});
test("recovery permits are durable, two per original source and share eight daily replay slots", () => {
  const r = require(modulePath),
    s = f.emptyFindings(),
    day = "2026-11-18";
  const first = r.reserve(s, context(r), day);
  assert.equal(first.outcome, "intent");
  assert.equal(r.dailyUsage(s, day), 1);
  f.validateFindings(s);
  assert.equal(r.reserve(s, context(r), day).proof.id, first.proof.id);
  assert.throws(() => r.reserve(s, context(r, "502"), day), /reconcile/i);
  r.finish(s, first.proof.id, null, context(r));
  const second = r.reserve(s, context(r, "502"), day);
  r.finish(s, second.proof.id, null, context(r, "502"));
  assert.throws(() => r.reserve(s, context(r, "503"), day), /limit/i);
  assert.equal(r.dailyUsage(s, day), 2);
  f.validateFindings(s);
  const full = f.emptyFindings();
  for (let n = 0; n < 8; n++) full.replays[n] = { day };
  assert.throws(() => r.reserve(full, context(r), day), /limit/i);
});
test("assessment requires its exact artifact; neither a failed nor an unknown replay is a bug pass", () => {
  const r = require(modulePath),
    s = f.emptyFindings(),
    ctx = context(r),
    receipt = r.reserve(s, ctx, "2026-11-18");
  const artifact = {
    id: 900,
    name: r.artifactName(receipt.proof),
    workflowRunId: ctx.runId,
    digest: "sha256:" + "a".repeat(64),
  };
  assert.throws(
    () => r.finish(s, receipt.proof.id, { ...artifact, workflowRunId: "99" }, ctx),
    /artifact/i
  );
  const done = r.finish(s, receipt.proof.id, artifact, ctx);
  assert.equal(done.outcome, "assessed");
  assert.equal(done.confirmation.runId, ctx.runId);
  assert.equal(r.dailyUsage(s, "2026-11-18"), 1);
  f.validateFindings(s);
});
module.exports = { context };

test("recovery receipts are pinned, bounded and reject changed contexts or terminal promotion", () => {
  const r = require(modulePath),
    s = f.emptyFindings(),
    ctx = context(r),
    first = r.reserve(s, ctx, "2026-11-18");
  assert.throws(
    () => r.reserve(s, { ...ctx, workflowSha: "c".repeat(40) }, "2026-11-18"),
    /context|identity|run/i
  );
  assert.throws(() => r.reserve(s, { ...ctx, ciRunId: "502" }, "2026-11-18"), /context|identity/i);
  assert.throws(() => r.finish(s, first.proof.id, null, { ...ctx, actor: "other" }), /recovery/i);
  const held = r.finish(s, first.proof.id, null, ctx);
  const artifact = {
    id: 900,
    name: r.artifactName(first.proof),
    workflowRunId: ctx.runId,
    digest: "sha256:" + "a".repeat(64),
  };
  assert.equal(held.outcome, "held");
  assert.throws(() => r.finish(s, first.proof.id, artifact, ctx), /terminal|held|finished/i);
  const changed = structuredClone(held);
  changed.proof.source.head = "c".repeat(40);
  assert.throws(() => r.validateReceipt(changed), /source|recovery/i);
  const intent = structuredClone(held);
  intent.outcome = "intent";
  assert.throws(() => r.validateReceipt(intent), /receipt|recovery/i);
});
test("legacy imports stay readable and optional recovery metadata belongs only to the pinned source", () => {
  const r = require(modulePath),
    legacy = f.emptyFindings();
  const grant = "11111111-1111-4111-8111-111111111111";
  legacy.imports[grant] = {
    runId: "99",
    evidenceHash: null,
    findings: [],
    status: "held-evidence",
  };
  const saved = structuredClone(legacy);
  assert.equal(f.validateFindings(legacy), legacy);
  assert.deepEqual(legacy, saved);
  legacy.imports[grant].recoveries = [];
  assert.throws(() => f.validateFindings(legacy), /recovery|source/i);
  delete legacy.imports[grant].recoveries;
  r.reserve(legacy, context(r), "2026-11-18");
  assert.deepEqual(legacy.imports[grant], saved.imports[grant]);
  const pinned = legacy.imports[r.SOURCE.grantId];
  for (const value of [
    null,
    {},
    [pinned.recoveries[0], pinned.recoveries[0]],
    [...pinned.recoveries, ...pinned.recoveries, ...pinned.recoveries],
  ]) {
    const changed = structuredClone(legacy);
    changed.imports[r.SOURCE.grantId].recoveries = value;
    assert.throws(() => f.validateFindings(changed), /recovery|receipt/i);
  }
});
test("daily quota counts recovery receipts and ordinary attempts together without rewriting prior source metadata", () => {
  const r = require(modulePath),
    s = f.emptyFindings(),
    day = "2026-11-18";
  s.imports[r.SOURCE.grantId] = {
    runId: r.SOURCE.runId,
    evidenceHash: "a".repeat(64),
    findings: [],
    status: "complete",
  };
  for (let n = 0; n < 7; n++) s.replays[n] = { day };
  const first = r.reserve(s, context(r), day);
  r.finish(s, first.proof.id, null, context(r));
  assert.equal(r.dailyUsage(s, day), 8);
  assert.throws(() => r.reserve(s, context(r, "502"), day), /limit/i);
  assert.equal(s.imports[r.SOURCE.grantId].status, "complete");
  assert.equal(s.imports[r.SOURCE.grantId].evidenceHash, "a".repeat(64));
  assert.throws(() => r.reserve({}, context(r), day), /registry|metadata/i);
});
test("a later trusted reconciliation can assess the retained original replay without another permit", () => {
  const r = require(modulePath),
    s = f.emptyFindings(),
    ctx = context(r),
    receipt = r.reserve(s, ctx, "2026-11-18");
  const artifact = {
    id: 900,
    name: r.artifactName(receipt.proof),
    workflowRunId: ctx.runId,
    digest: "sha256:" + "a".repeat(64),
  };
  const reconciliation = { ...context(r, "502"), workflowSha: "c".repeat(40), ciRunId: "503" };
  const finished = r.finish(s, receipt.proof.id, artifact, reconciliation);
  assert.equal(finished.outcome, "assessed");
  assert.equal(finished.confirmation.runId, "502");
  assert.equal(finished.proof.context.runId, "500");
  assert.equal(r.dailyUsage(s, "2026-11-18"), 1);
  assert.equal(s.imports[r.SOURCE.grantId].recoveries.length, 1);
  f.validateFindings(s);
  assert.throws(() => r.reserve(s, context(r, "504"), "2026-11-19"), /assessed|assessment/i);
});
