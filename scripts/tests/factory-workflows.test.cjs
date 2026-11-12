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
    "review",
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
    "factory-pr-review.yml",
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
test("owner PR review is explicitly dispatched and reuses the restricted readonly review role", () => {
  const entry = load("factory-agents.yml");
  assert.ok(entry.jobs.admit_pr.if.includes("inputs.operation == 'review'"));
  assert.ok(entry.jobs.review_existing.if.includes("FACTORY_ENABLED"));
  const flow = load("factory-pr-review.yml");
  assert.deepEqual(Object.keys(flow.on), ["workflow_call"]);
  assert.equal(flow.jobs.review.with.phase, "review");
  assert.equal(flow.jobs.review.permissions.contents, "read");
  assert.ok(flow.jobs.review.if.includes("needs.ci.outputs.passed == 'true'"));
  assert.equal(flow.jobs.publish, undefined);
  assert.equal(flow.jobs.assess.steps.at(-1).with.operation, "assess_pr");
});
test("CI dispatch correlation is exposed without holding the cancellation queue while polling", () => {
  const ci = load("factory-ci.yml");
  assert.equal(ci.on.workflow_dispatch.inputs.factory_request_id.type, "string");
  assert.ok(ci["run-name"].includes("inputs.factory_request_id"));
  for (const name of ["factory-cycle.yml", "factory-pr-review.yml"]) {
    const job = load(name).jobs.ci;
    assert.equal(job.permissions.contents, "write");
    assert.equal(job.permissions.actions, "write");
    assert.equal(job.concurrency, undefined);
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
test("composite controller gets repository configuration through its declared input", () => {
  const file = fs.readFileSync(
    path.join(root, ".github/actions/factory-control/action.yml"),
    "utf8"
  );
  const action = yaml.load(file);
  assert.doesNotMatch(
    file,
    /\$\{\{[^}]*\bvars\b/,
    "GitHub's composite action manifest does not expose the workflow vars context"
  );
  assert.equal(action.inputs.variables_json.required, true);
  const command = action.runs.steps.find((step) => step.id === "run");
  assert.equal(command.env.FACTORY_VARIABLES, "${{ inputs.variables_json }}");
  for (const name of [
    "factory-agents.yml",
    "factory-cycle.yml",
    "factory-pr-review.yml",
    "factory-review-gate.yml",
  ]) {
    for (const job of Object.values(load(name).jobs)) {
      for (const step of job.steps || []) {
        if (step.uses === "./.github/actions/factory-control") {
          assert.equal(
            step.with.variables_json,
            "${{ toJSON(vars) }}",
            `${name} must pass workflow-scoped variables`
          );
        }
      }
    }
  }
});
test("required CI actually executes the composite action with disabled synthetic configuration", () => {
  const flow = load("factory-ci.yml");
  const smoke = flow.jobs.verify.steps.find(
    (step) => step.uses === "./.github/actions/factory-control"
  );
  assert.ok(smoke, "local YAML assertions alone did not catch the runner manifest error");
  assert.equal(smoke.with.operation, "validate");
  const config = require("../factory/policy.cjs").readConfig(JSON.parse(smoke.with.variables_json));
  assert.equal(config.enabled, false);
  assert.equal(flow.permissions.contents, "read");
  assert.ok(!JSON.stringify(smoke).includes("secrets."));
});
test("failed model sessions retain only a separate sanitized diagnostic without changing failure or permissions", () => {
  const job = load("factory-model.yml").jobs.agent;
  const model = job.steps.find((step) => step.id === "model");
  const diagnostic = job.steps.find((step) => step.id === "diagnostics");
  assert.ok(diagnostic, "model failures currently discard permission-denial details");
  assert.equal(diagnostic.if, "${{ failure() && steps.model.outcome == 'failure' }}");
  assert.equal(diagnostic["continue-on-error"], true);
  assert.equal(diagnostic.run, 'node "$RUNNER_TEMP/factory-control/diagnostics.cjs"');
  assert.ok(!JSON.stringify(diagnostic).includes("secrets."));
  assert.notEqual(model["continue-on-error"], true);
  assert.equal(model.with.show_full_output, "false");
  const upload = job.steps.find(
    (step) => step.with?.name === "diagnostic-${{ inputs.phase }}-${{ inputs.grantId }}"
  );
  assert.ok(upload);
  assert.equal(
    upload.if,
    "${{ failure() && steps.model.outcome == 'failure' && steps.diagnostics.outcome == 'success' }}"
  );
  assert.equal(upload.with.path, "${{ runner.temp }}/factory-permission-denials.json");
  assert.equal(upload.with["retention-days"], 7);
  assert.equal(upload["continue-on-error"], true);
});
