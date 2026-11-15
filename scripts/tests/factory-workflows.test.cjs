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
    "recover",
    "review",
    "cancel",
  ]);
  assert.equal(flow.permissions.contents, "read");
  assert.ok(flow.jobs.admit.if.includes("inputs.operation == 'recover'"));
  assert.equal(flow.jobs.admit.steps.at(-1).with.operation, "admit");
  for (const job of Object.values(flow.jobs))
    if (job["runs-on"]) assert.equal(job["runs-on"], "ubuntu-latest");
});

test("five serial cycles execute only the preceding cycle's reserved retry", () => {
  const flow = load("factory-agents.yml");
  assert.deepEqual(
    Object.keys(flow.jobs).filter((name) => /^cycle\d+$/.test(name)),
    ["cycle1", "cycle2", "cycle3", "cycle4", "cycle5"]
  );
  for (let number = 2; number <= 5; number++) {
    const name = `cycle${number}`;
    const previous = `cycle${number - 1}`;
    const job = flow.jobs[name];
    assert.equal(job.needs, previous);
    assert.equal(
      job.if,
      "${{ needs." + previous + ".outputs.retry == 'true' && vars.FACTORY_ENABLED == 'true' }}"
    );
    assert.equal(job.uses, "./.github/workflows/factory-cycle.yml");
    assert.equal(job.with.slot, name);
    for (const field of ["ticket", "grantId", "head"])
      assert.equal(job.with[field], "${{ needs." + previous + ".outputs." + field + " }}");
    assert.deepEqual(job.permissions, flow.jobs.cycle1.permissions);
    assert.deepEqual(job.secrets, flow.jobs.cycle1.secrets);
  }
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
    "factory-review-status.yml",
  ]) {
    const flow = load(name);
    for (const [jobName, job] of Object.entries(flow.jobs))
      for (const step of job.steps || []) {
        if (step.uses && !step.uses.startsWith("./")) assert.match(step.uses, /@[a-f0-9]{40}$/);
        for (const secret of JSON.stringify(step).matchAll(/secrets\.([A-Z_]+)/g)) {
          if (
            name === "factory-cycle.yml" &&
            jobName === "publish" &&
            step.uses === "./.github/actions/factory-app-token"
          )
            assert.equal(secret[1], "FACTORY_GITHUB_APP_PRIVATE_KEY");
          else assert.equal(secret[1], "CLAUDE_CODE_OAUTH_TOKEN");
        }
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
    "${{ failure() && steps.model.outcome == 'failure' && steps.diagnostics.outcome == 'success' && steps.diagnostics_scan.outcome == 'success' }}"
  );
  assert.equal(upload.with.path, "${{ runner.temp }}/factory-permission-denials.json");
  assert.equal(upload.with["retention-days"], 7);
  assert.equal(upload["continue-on-error"], true);
});

test("secret scanning gates source, model context and every uploaded model bundle", () => {
  const ci = load("factory-ci.yml").jobs.verify.steps;
  const source = ci.findIndex((step) => step.run === "node scripts/factory/secret-scan.cjs source");
  assert.ok(
    source >= 0 && source < ci.findIndex((step) => step.run === "yarn install --frozen-lockfile")
  );
  assert.equal(
    ci.find((step) => step.env?.FACTORY_SECRET_SCAN_INTEGRATION).env
      .FACTORY_SECRET_SCAN_INTEGRATION,
    "true"
  );
  const steps = load("factory-model.yml").jobs.agent.steps;
  const model = steps.findIndex((step) => step.id === "model");
  for (const suffix of ["source", 'file "$GITHUB_WORKSPACE/.factory-input/context.json"'])
    assert.ok(
      steps
        .slice(0, model)
        .some(
          (step) => step.run === `node "$RUNNER_TEMP/factory-control/secret-scan.cjs" ${suffix}`
        )
    );
  const upload = steps.findIndex(
    (step) => step.with?.name === "${{ inputs.phase }}-${{ inputs.grantId }}"
  );
  assert.equal(
    steps[upload - 1].run,
    'node "$RUNNER_TEMP/factory-control/secret-scan.cjs" file "$RUNNER_TEMP/factory-artifact/bundle.json"'
  );
  assert.equal(steps[upload - 1].if, undefined);
  assert.notEqual(steps[upload - 1]["continue-on-error"], true);
  assert.ok(
    steps
      .find((step) => step.with?.name?.startsWith("diagnostic-"))
      .if.includes("steps.diagnostics_scan.outcome == 'success'")
  );
});

test("dependency facts use trusted parsers and a fail-closed scanned exact-file audit upload before the model", () => {
  const job = load("factory-model.yml").jobs.agent;
  const steps = job.steps;
  const trusted = steps.findIndex(
    (s) => s.uses?.startsWith("actions/checkout@") && s.with?.ref === "${{ github.workflow_sha }}"
  );
  const install = steps.findIndex(
    (s) => s["working-directory"] === "scripts/factory/dependency-tools"
  );
  const preserve = steps.findIndex((s) => s.run?.includes("cpSync('scripts/factory'"));
  const candidate = steps.findIndex(
    (s) => s.uses?.startsWith("actions/checkout@") && s.with?.ref === "${{ inputs.head }}"
  );
  const prepare = steps.findIndex((s) => s.id === "prepare");
  const contextScan = steps.findIndex(
    (s) =>
      s.run ===
      'node "$RUNNER_TEMP/factory-control/secret-scan.cjs" file "$GITHUB_WORKSPACE/.factory-input/context.json"'
  );
  const factsScan = steps.findIndex(
    (s) =>
      s.run ===
      'node "$RUNNER_TEMP/factory-control/secret-scan.cjs" file "$GITHUB_WORKSPACE/.factory-input/dependency-facts.json"'
  );
  const upload = steps.findIndex((s) => s.with?.name === "dependency-facts-${{ inputs.grantId }}");
  const model = steps.findIndex((s) => s.id === "model");
  const order = [
    trusted,
    install,
    preserve,
    candidate,
    prepare,
    contextScan,
    factsScan,
    upload,
    model,
  ];
  assert.ok(
    order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])),
    "trusted parser install and scanned audit upload must precede candidate execution/model access"
  );
  const dependencyOnly = "${{ inputs.phase == 'review' && inputs.slot == 'dependency' }}";
  for (const position of [install, factsScan, upload]) {
    assert.equal(steps[position].if, dependencyOnly);
    assert.notEqual(steps[position]["continue-on-error"], true);
    assert.doesNotMatch(JSON.stringify(steps[position]), /secrets\.|GH_TOKEN|github\.token/);
  }
  assert.equal(steps[install].run, "npm ci --ignore-scripts --no-audit --fund=false");
  assert.equal(
    steps[upload].uses,
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"
  );
  assert.equal(
    steps[upload].with.path,
    "${{ github.workspace }}/.factory-input/dependency-facts.json"
  );
  // upload-artifact excludes dot-directory contents by default, even this exact file.
  assert.equal(steps[upload].with["include-hidden-files"], true);
  assert.equal(steps[upload].with["if-no-files-found"], "error");
  assert.equal(steps[upload].with["retention-days"], 7);
});
