const test = require("node:test");
const assert = require("node:assert/strict");
const f = require("../factory/discovery-finding-contract.cjs");
const pub = require("../factory/discovery-publication.cjs");
const intake = require("../factory/discovery-intake.cjs");
const fx = require("./helpers/finding-fixtures.cjs");
function setup(useFunctional = false) {
  const state = f.emptyFindings();
  const candidate = f.candidateFromEvidence(
    useFunctional ? fx.functionalEvidence() : fx.evidence(),
    0,
    fx.artifact,
    useFunctional ? fx.proof(fx.grant, "functional-feed") : fx.proof()
  );
  pub.stageFinding(state, candidate);
  const row = state.records[candidate.key];
  pub.claimPublication(
    state,
    candidate.key,
    "2026-11-17",
    fx.context,
    { enabled: true, automatic: true, discovery: true },
    false
  );
  row.publication.issue = 123;
  row.publication.writeStarted = true;
  row.status = "published";
  return { state, candidate, row };
}
test("current-head replays consume bounded allowances before execution, across SHAs and failure", () => {
  const { state, candidate } = setup();
  for (let i = 0; i < 2; i++) {
    const receipt = intake.reserveReplay(
      state,
      candidate.key,
      "2026-11-17",
      fx.context,
      (i ? "b" : "a").repeat(40)
    );
    assert.equal(receipt.outcome, "intent");
  }
  assert.throws(
    () => intake.reserveReplay(state, candidate.key, "2026-11-17", fx.context, "c".repeat(40)),
    /limit/
  );
  assert.equal(Object.values(state.replays).length, 2);
  assert.equal(candidate.source.head, fx.head);
});
test("a real current-head RED and two matching typed observations are ready; broken or mixed evidence holds", () => {
  const { candidate } = setup();
  const row = fx.evidence().findings[0];
  const red = [row.original.result, structuredClone(row.original.result)];
  const oracle = row.replays;
  assert.equal(intake.assessReplay(candidate, red, oracle), "ready");
  assert.equal(intake.assessReplay(candidate, [{ ...red[0], code: 124 }, red[1]], oracle), "held");
  const healthy = oracle.map((r) => ({
    ...r,
    observation: require("../factory/discovery-oracles.cjs").observe(candidate.oracle, 401, {}),
  }));
  assert.equal(intake.assessReplay(candidate, red, healthy), "held");
  assert.equal(
    intake.assessReplay(
      candidate,
      red.map((r) => ({ ...r, code: 0 })),
      healthy
    ),
    "observed-resolved"
  );
  const unavailable = oracle.map((r) => ({
    ...r,
    observation: require("../factory/discovery-oracles.cjs").observe(candidate.oracle, 503, {}),
  }));
  assert.equal(
    intake.assessReplay(
      candidate,
      red.map((r) => ({ ...r, code: 0 })),
      unavailable
    ),
    "held"
  );
});
test("changed RED text or unverified origins never reach a sandbox", async () => {
  const { candidate } = setup();
  let calls = 0;
  const bundle = fx.evidence();
  bundle.findings[0].original.test += "changed";
  await assert.rejects(
    () =>
      intake.replayForIntake({
        candidate,
        bundle,
        image: "sha256:" + "a".repeat(64),
        tests: "unused",
        run: async () => {
          calls++;
        },
      }),
    /evidence|RED/
  );
  assert.equal(calls, 0);
});
test("eight total attempts/day are retained; stop and capacity block replay, not just model admission", () => {
  const { state, candidate } = setup();
  const controls = {
    enabled: true,
    automatic: true,
    discovery: true,
    daily: 20,
    concurrent: 1,
    timezone: "Europe/Bucharest",
  };
  const ledger = {
    version: 1,
    repository: require("../factory/policy.cjs").REPOSITORY,
    days: {},
    tickets: {},
    grants: {},
    audit: [],
    active: null,
  };
  assert.equal(intake.canReplay(ledger, controls, "2026-11-17"), true);
  ledger.stop = {};
  assert.equal(intake.canReplay(ledger, controls, "2026-11-17"), false);
  delete ledger.stop;
  ledger.active = { ticket: 1, runId: "2", runAttempt: 1 };
  assert.equal(intake.canReplay(ledger, controls, "2026-11-17"), false);
  for (let i = 0; i < 8; i++) state.replays[String(i)] = { key: "other", day: "2026-11-17" };
  assert.throws(
    () => intake.reserveReplay(state, candidate.key, "2026-11-17", fx.context, fx.head),
    /limit/
  );
});
module.exports = { setup };
test("an exhausted first finding cannot starve a later functional finding", () => {
  const { state, candidate } = setup(true);
  const grant = "88888888-8888-4888-8888-888888888888";
  const second = f.candidateFromEvidence(
    fx.functionalEvidence("functional-directory", grant),
    0,
    { ...fx.artifact, name: `discovery-evidence-${grant}` },
    fx.proof(grant, "functional-directory")
  );
  pub.stageFinding(state, second);
  pub.claimPublication(
    state,
    second.key,
    "2026-11-17",
    fx.context,
    { enabled: true, automatic: true, discovery: true },
    false
  );
  state.records[second.key].publication.issue = 124;
  state.records[second.key].status = "published";
  intake.reserveReplay(state, candidate.key, "2026-11-17", fx.context, fx.head);
  intake.reserveReplay(
    state,
    candidate.key,
    "2026-11-17",
    { ...fx.context, runId: "201" },
    fx.head
  );
  assert.equal(
    intake.pendingReplay(state, { tickets: {} }, { day: "2026-11-17", head: fx.head }).candidate
      .key,
    second.key
  );
});
test("unmerged model patches are refused by the image builder, not executed during privileged image construction", async () => {
  await assert.rejects(
    () =>
      intake.buildBaseline({
        cwd: "unused",
        head: fx.head,
        root: "unused",
        files: [
          {
            path: "src/__tests__/hostile.test.ts",
            mode: "100644",
            content: "require('node:fs').writeFileSync('/trusted/oracles.cjs','forged')",
          },
        ],
      }),
    /overlay|unmerged|patch.*image/i
  );
});
