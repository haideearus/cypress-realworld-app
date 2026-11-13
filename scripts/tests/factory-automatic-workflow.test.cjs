const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const load = () =>
  yaml.load(
    fs.readFileSync(path.join(__dirname, "../../.github/workflows/factory-automatic.yml"), "utf8")
  );

test("automatic entry is main-only scheduled with a default read-only manual preview", () => {
  const workflow = load();
  assert.deepEqual(Object.keys(workflow.on).sort(), ["schedule", "workflow_dispatch"]);
  assert.equal(workflow.on.schedule[0].cron, "17,47 * * * *");
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.type, "boolean");
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true);
  assert.ok(workflow.jobs.pick.if.includes("refs/heads/main"));
  assert.ok(workflow.jobs.pick.if.includes("FACTORY_ENABLED"));
  assert.ok(workflow.jobs.pick.if.includes("FACTORY_AUTOMATION_ENABLED"));
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  for (const job of Object.values(workflow.jobs))
    if (job["runs-on"]) assert.equal(job["runs-on"], "ubuntu-latest");
});

test("automatic role cycles share the admission run and keep App secrets out of model workflows", () => {
  const jobs = load().jobs;
  for (let number = 1; number <= 5; number++) {
    const previous = number === 1 ? "pick" : `cycle${number - 1}`;
    const job = jobs[`cycle${number}`];
    assert.equal(job.needs, previous);
    assert.equal(job.uses, "./.github/workflows/factory-cycle.yml");
    assert.equal(job.with.automatic, true);
    assert.equal(job.with.slot, `cycle${number}`);
    for (const field of ["ticket", "grantId", "head"])
      assert.equal(job.with[field], "${{ needs." + previous + ".outputs." + field + " }}");
    assert.ok(job.if.includes(number === 1 ? "outputs.ready" : "outputs.retry"));
    assert.ok(job.if.includes("FACTORY_ENABLED"));
    assert.ok(job.if.includes("FACTORY_AUTOMATION_ENABLED"));
  }
  assert.equal(
    Object.values(jobs).some((job) => /factory-model/.test(job.uses || "")),
    false
  );
});

test("only trusted control checkouts receive App credentials; previews skip token minting", () => {
  const jobs = load().jobs;
  for (const name of ["pick", "merge"]) {
    const job = jobs[name];
    const checkout = job.steps.find((step) => (step.uses || "").startsWith("actions/checkout@"));
    assert.equal(checkout.with.ref, "${{ github.workflow_sha }}");
    assert.equal(checkout.with["persist-credentials"], false);
    const app = job.steps.find((step) => step.uses === "./.github/actions/factory-app-token");
    assert.ok(app);
    assert.equal(app.with["client-id"], "${{ vars.FACTORY_GITHUB_APP_CLIENT_ID }}");
    assert.equal(app.with["expected-slug"], "${{ vars.FACTORY_GITHUB_APP_SLUG }}");
    assert.equal(app.with["private-key"], "${{ secrets.FACTORY_GITHUB_APP_PRIVATE_KEY }}");
    const control = job.steps.find((step) => step.uses === "./.github/actions/factory-control");
    assert.equal(control.with.operation, `auto_${name}`);
    assert.ok(control.with.github_token.includes("steps.app.outputs.token"));
  }
  assert.ok(jobs.pick.steps.find((step) => step.id === "app").if.includes("inputs.dry_run"));
});

test("merge waits for all cycles and requires its independent enable flag", () => {
  const job = load().jobs.merge;
  assert.deepEqual(job.needs, ["pick", "cycle1", "cycle2", "cycle3", "cycle4", "cycle5"]);
  for (const flag of ["FACTORY_ENABLED", "FACTORY_AUTOMATION_ENABLED", "FACTORY_AUTOMERGE_ENABLED"])
    assert.ok(job.if.includes(flag));
  assert.ok(job.if.includes("inputs.dry_run"));
  assert.ok(job.if.includes("always()"));
  assert.notEqual(job.concurrency?.group, "factory-ledger");
  assert.equal(
    job.steps.some((step) => /deploy|render/i.test(step.run || "")),
    false
  );
});
