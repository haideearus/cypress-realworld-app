const test = require("node:test"),
  assert = require("node:assert/strict");
const source = require("./fixtures/discovery-recovery-source.json");
test("recovered assessment cannot replace original report, source or latest RED", () => {
  const rc = require("../factory/discovery-recovery-contract.cjs");
  const validate = require("../factory/discovery-recovery-evidence.cjs").validateEvidence;
  const context = {
    repository: "haideearus/cypress-realworld-app",
    actor: "haideearus",
    triggeringActor: "haideearus",
    ref: "refs/heads/main",
    event: "workflow_dispatch",
    workflowRef: rc.WORKFLOW_REF,
    workflowSha: "b".repeat(40),
    runId: "500",
    runAttempt: 1,
    ciRunId: "501",
  };
  const proof = rc.makeProof(context);
  const evidence = {
    version: 1,
    head: source.head,
    grantId: source.grantId,
    source: source.source,
    fixture: false,
    report: source.report,
    sourceHash: source.sourceHash,
    findings: [source.batches[0], source.batches[2]].map((original, index) => ({
      finding: source.report.findings[index],
      original,
      status: "held",
    })),
    recovery: proof,
  };
  assert.equal(validate(evidence, proof), evidence);
  for (const alter of [
    (b) => (b.report.findings[0].summary += "bad"),
    (b) => (b.sourceHash = "a".repeat(64)),
    (b) => (b.findings[1].original = source.batches[1]),
    (b) => (b.recovery.context.runId = "700"),
    (b) => (b.fixture = true),
  ]) {
    const b = structuredClone(evidence);
    alter(b);
    assert.throws(() => validate(b, proof));
  }
});
