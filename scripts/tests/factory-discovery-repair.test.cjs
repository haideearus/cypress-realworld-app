const test = require("node:test");
const assert = require("node:assert/strict");
const c = require("../factory/discovery-contract.cjs");
const f = require("../factory/discovery-finding-contract.cjs");
const fx = require("./helpers/finding-fixtures.cjs");
const worker = require("../factory/worker.cjs");
test("finding-origin coders have edit-only tools; generated tests never execute on the OAuth host", () => {
  const args = worker.buildArgs({ turns: 200 }, "code", false, true);
  assert.match(args, /--tools "Read,Glob,Grep,Edit,Write"/);
  assert.match(args, /Bash,PowerShell/);
  assert.doesNotMatch(args, /Bash\(yarn/);
  assert.match(worker.promptFor("code", fx.head, false, false, true), /trusted.*RED.*GREEN/i);
});
test("trusted repair receipt binds original discovery, code grant, exact files and RED/GREEN", () => {
  const repair = require("../factory/discovery-repair.cjs");
  const candidate = f.candidateFromEvidence(fx.evidence(), 0, fx.artifact, fx.proof());
  const grant = {
    id: fx.grant,
    head: fx.head,
    phase: "code",
    slot: "cycle1",
    runId: "300",
    runAttempt: 1,
  };
  const ticket = {
    finding: { origin: { key: candidate.key, candidateHash: c.digest(candidate) } },
    findingRedHash: undefined,
  };
  const bundle = {
    kind: "code",
    grantId: grant.id,
    base: grant.head,
    files: [{ path: "src/a.ts", mode: "100644", content: "fixed" }],
  };
  const proof = repair.repairProof(
    ticket,
    grant,
    bundle,
    { outcome: "ready", redHash: "d".repeat(64) },
    { outcome: "observed-resolved", evidenceHash: "e".repeat(64) }
  );
  bundle.findingVerification = proof;
  assert.equal(repair.validRepairProof(ticket, grant, bundle), true);
  bundle.files[0].content = "different";
  assert.equal(repair.validRepairProof(ticket, grant, bundle), false);
  bundle.files[0].content = "fixed";
  proof.greenOutcome = "ready";
  assert.equal(repair.validRepairProof(ticket, grant, bundle), false);
});
