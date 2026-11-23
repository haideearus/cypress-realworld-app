const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateEvidence,
  filterPlan,
  PILOT,
  modelArgs,
} = require("../factory/feature-planner.cjs");
const c = require("../factory/feature-contract.cjs");

const head = "a".repeat(40);
const file = (value) => ({
  type: "file",
  encoding: "base64",
  content: Buffer.from(value).toString("base64"),
});
const api = {
  request: async (method, path) => {
    assert.equal(method, "GET");
    if (path.includes("/contents/")) {
      assert.ok(path.endsWith("?ref=" + head));
      return file(PILOT.evidence.quote);
    }
    return {
      user: { id: 7, login: "contributor", type: "User" },
      title: PILOT.evidence.quote,
      body: "",
    };
  },
};

test("a production proposal binds evidence to the tested source or maintainer issue", async () => {
  assert.equal(await validateEvidence(api, PILOT.evidence, head), true);
  assert.equal(
    await validateEvidence(
      api,
      { ...PILOT.evidence, quote: "This invented code did not run here" },
      head
    ),
    false
  );
  assert.equal(
    await validateEvidence(api, { kind: "issue", number: 7, quote: PILOT.evidence.quote }, head),
    false
  );
});

test("live plans suppress titles already open or durably published", async () => {
  assert.deepEqual(await filterPlan(api, [PILOT], c.emptyRegistry(), [PILOT.title], head), []);
  const registry = { records: { [c.proposalKey(PILOT)]: { proposal: PILOT } } };
  assert.deepEqual(await filterPlan(api, [PILOT], registry, [], head), []);
  assert.deepEqual(await filterPlan(api, [PILOT], c.emptyRegistry(), [], head), [PILOT]);
});

test("planner arguments permit structured output and zero tools", () => {
  const args = modelArgs({ turns: 20 });
  assert.match(args, /--tools=/);
  assert.match(args, /--max-turns 1/);
  assert.match(args, /--json-schema/);
  assert.match(args, /--strict-mcp-config/);
});
test("the same-week pilot leaves room for a major and four more minors", () => {
  const { availablePlan } = require("../factory/feature-planner.cjs");
  const minor = (index) => {
    const title = "Clarify application form " + index;
    return { ...PILOT, title, steps: [{ ...PILOT.steps[0], title }] };
  };
  const major = { ...PILOT, size: "major", title: "Add a more usable request workflow" };
  const plan = [major, ...Array.from({ length: 5 }, (_, i) => minor(i))];
  const record = { proposal: PILOT, week: "2026-11-23" };
  const result = availablePlan(plan, { records: { existing: record } }, record.week);
  assert.equal(result.filter((proposal) => proposal.size === "major").length, 1);
  assert.equal(result.filter((proposal) => proposal.size === "minor").length, 4);
});
