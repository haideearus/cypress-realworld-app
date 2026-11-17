const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const yaml = require("js-yaml");
const read = (name) =>
  yaml.load(fs.readFileSync(path.resolve(__dirname, "../../.github/workflows", name), "utf8"));
test("finding intake defaults to preview and every job is model-credential-free", () => {
  const flow = read("factory-discovery-intake.yml");
  assert.equal(flow.on.workflow_dispatch.inputs.dry_run.default, true);
  assert.equal(flow.on.workflow_dispatch.inputs.operation.default, "preview");
  assert.match(flow.jobs.select.if, /FACTORY_DISCOVERY_ENABLED/);
  assert.match(flow.jobs.select.if, /github.run_attempt == 1/);
  assert.doesNotMatch(JSON.stringify(flow), /secrets\.|anthropics\/|ANTHROPIC_API_KEY/);
  assert.equal(flow.jobs.publish.concurrency.group, "factory-ledger");
  assert.equal(flow.jobs.replay.permissions.contents, "read");
  assert.equal(flow.jobs.replay.permissions.issues, "read");
  assert.equal(flow.jobs.replay["timeout-minutes"], 32);
  for (const job of Object.values(flow.jobs))
    for (const step of job.steps || [])
      if (step.uses?.startsWith("actions/checkout@")) {
        assert.equal(step.with.ref, "${{ github.workflow_sha }}");
        assert.equal(step.with["persist-credentials"], false);
      }
});
test("repair RED precedes model and GREEN binds collected files; provenance cannot be selected with an input", () => {
  const flow = read("factory-model.yml"),
    steps = flow.jobs.agent.steps;
  const index = (name) => steps.findIndex((s) => s.name === name);
  assert.ok(
    index("Prove finding RED without model credentials") <
      index("Run the one reserved Claude subscription session")
  );
  assert.ok(
    index("Prove finding GREEN without model credentials") >
      index("Validate and collect only the role output")
  );
  assert.ok(
    index("Prove finding GREEN without model credentials") <
      index("Reject secret-bearing role output before upload")
  );
  assert.equal(flow.on.workflow_call.inputs.finding, undefined);
  assert.match(steps.find((s) => s.id === "finding").run, /discovery-repair/);
  assert.ok(Object.values(flow.jobs.agent.permissions).every((x) => x === "read"));
  assert.ok(
    read("factory-wake.yml").on.workflow_run.workflows.includes("Verified discovery finding intake")
  );
  assert.ok(
    read("factory-activity.yml").on.workflow_run.workflows.includes(
      "Verified discovery finding intake"
    )
  );
});
test("report completion remains distinct from each individually verified failure", () => {
  const flow = read("factory-discovery.yml");
  assert.equal(flow.jobs.replay.outputs.verified, undefined);
  assert.match(
    flow.jobs.finalize.steps.at(-1).env.FACTORY_DISCOVERY_ASSESSMENT_COMPLETE,
    /assessmentComplete/
  );
});
