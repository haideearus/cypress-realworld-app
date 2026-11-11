const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const root = path.resolve(__dirname, "../..");
function load(name) {
  return yaml.load(fs.readFileSync(path.join(root, ".github/workflows", name), "utf8"));
}
test("entry point admits only explicit manual operations and uses standard runners", () => {
  const flow = load("factory-agents.yml");
  assert.deepEqual(Object.keys(flow.on), ["workflow_dispatch"]);
  assert.deepEqual(flow.on.workflow_dispatch.inputs.operation.options, [
    "initialize",
    "run",
    "cancel",
  ]);
  assert.equal(flow.permissions.contents, "read");
  for (const job of Object.values(flow.jobs))
    if (job["runs-on"]) assert.equal(job["runs-on"], "ubuntu-latest");
});
test("model job token cannot publish and only the model step receives a subscription credential", () => {
  const flow = load("factory-model.yml");
  const job = flow.jobs.agent;
  assert.deepEqual(job.permissions, { contents: "read", issues: "read", "pull-requests": "read" });
  const steps = job.steps;
  const modelIndex = steps.findIndex((s) =>
    String(s.uses || "").startsWith("anthropics/claude-code-action@")
  );
  assert.ok(modelIndex > 0);
  assert.ok(steps.slice(0, modelIndex).some((s) => s.id === "prepare"));
  assert.equal(
    steps[modelIndex].with.claude_code_oauth_token,
    "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}"
  );
  for (const step of steps) {
    assert.equal(step.with?.anthropic_api_key, undefined);
    assert.equal(step.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    if (step !== steps[modelIndex])
      assert.ok(!JSON.stringify(step).includes("secrets.CLAUDE_CODE_OAUTH_TOKEN"));
  }
  assert.equal(typeof job["timeout-minutes"], "string");
  assert.ok(job.if.includes("FACTORY_ENABLED"));
});
test("review is a separate readonly-role job and publisher never executes model artifacts", () => {
  const flow = load("factory-cycle.yml");
  assert.equal(flow.jobs.coding.with.phase, "code");
  assert.equal(flow.jobs.review.with.phase, "review");
  assert.equal(flow.jobs.coding.permissions.contents, "read");
  assert.equal(flow.jobs.review.permissions.contents, "read");
  assert.equal(flow.jobs.publish.permissions.contents, "write");
  assert.equal(flow.jobs.publish.permissions["pull-requests"], "write");
  const publishing = flow.jobs.publish.steps
    .filter((s) => s.run)
    .map((s) => s.run)
    .join("\n");
  assert.equal(
    publishing,
    "",
    "publication only invokes the trusted controller action, never artifact scripts"
  );
  assert.ok(flow.jobs.review.needs.includes("reserve_review"));
});
test("third-party actions are immutable and model workflows contain no paid or production secrets", () => {
  for (const name of [
    "factory-agents.yml",
    "factory-cycle.yml",
    "factory-model.yml",
    "factory-review-gate.yml",
  ]) {
    const flow = load(name);
    for (const job of Object.values(flow.jobs))
      for (const step of job.steps || []) {
        if (step.uses && !step.uses.startsWith("./")) assert.match(step.uses, /@[a-f0-9]{40}$/);
        for (const secret of JSON.stringify(step).matchAll(/secrets\.([A-Z_]+)/g))
          assert.equal(secret[1], "CLAUDE_CODE_OAUTH_TOKEN");
      }
  }
});
test("gate runs from trusted default-branch source without a model credential or PR checkout", () => {
  const flow = load("factory-review-gate.yml");
  assert.ok(flow.on.pull_request_target);
  assert.equal(flow.jobs.gate.permissions.checks, "write");
  assert.equal(flow.jobs.gate.permissions.contents, "read");
  for (const step of flow.jobs.gate.steps) {
    assert.ok(!JSON.stringify(step).includes("secrets."));
    if (step.uses?.startsWith("actions/checkout@"))
      assert.equal(step.with.ref, "${{ github.workflow_sha }}");
  }
});
