const test = require("node:test");
const assert = require("node:assert/strict");
const e = require("../factory/discovery-evidence.cjs");
const o = require("../factory/discovery-oracles.cjs");
const head = "a".repeat(40),
  grantId = "11111111-1111-4111-8111-111111111111";
const oracle = {
  kind: "unexpected-server-error",
  route: "/transactions",
  authenticated: false,
  query: {},
};
test("invented expectations and production URLs cannot enter trusted oracle replay", () => {
  assert.throws(() => o.validateOracle({ ...oracle, kind: "model-expects" }), /Unsupported/);
  assert.throws(
    () => o.validateOracle({ ...oracle, route: "https://live.example/transactions" }),
    /Unsupported/
  );
  assert.throws(
    () => o.validateOracle({ ...oracle, query: { url: "https://live.example" } }),
    /Unsupported/
  );
});
test("same supported failure twice is verified; flaky, baseline and startup failures are held", async () => {
  const base = {
    version: 1,
    kind: oracle.kind,
    symptom: "server-error",
    status: 500,
    signature: "transactions:500",
    inputHash: o.oracleHash(oracle),
  };
  const finding = {
    title: "Unexpected error",
    summary: "GET transaction returns 500",
    test: "a.api.test.cjs",
    mode: "api",
    oracle,
  };
  let count = 0;
  const replay = async () => {
    count++;
    return { observation: base };
  };
  const r = await e.verifyReproducer({ head, grantId, finding, baselinePassed: true, replay });
  assert.equal(r.status, "verified");
  assert.equal(count, 2);
  assert.equal(r.replays.length, 2);
  const flaky = await e.verifyReproducer({
    head,
    grantId,
    finding,
    baselinePassed: true,
    replay: async () => ({ observation: { ...base, signature: String(++count) } }),
  });
  assert.equal(flaky.status, "held");
  assert.equal(
    (await e.verifyReproducer({ head, grantId, finding, baselinePassed: false, replay })).status,
    "held"
  );
  assert.equal(
    (
      await e.verifyReproducer({
        head,
        grantId,
        finding,
        baselinePassed: true,
        replay: async () => {
          throw Error("startup");
        },
      })
    ).status,
    "held"
  );
});
test("zero findings preserve reported checked and skipped coverage without claiming exhaustive testing", () => {
  const report = {
    version: 1,
    head,
    grantId,
    checked: ["feed boundaries"],
    skipped: ["external auth"],
    findings: [],
  };
  assert.equal(e.validateCandidateReport(report, { head, grantId }).findings.length, 0);
  assert.throws(
    () => e.validateCandidateReport({ ...report, head: "b".repeat(40) }, { head, grantId }),
    /identity/
  );
  assert.throws(
    () => e.validateCandidateReport({ ...report, findings: [{}, {}, {}] }, { head, grantId }),
    /report|finding/i
  );
});
