const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const read = (file) =>
  fs.readFileSync(path.join(__dirname, "../../.github/workflows", file), "utf8");
test("monitor is main-only, default preview, bounded and carries no provider credentials", () => {
  const text = read("factory-monitor.yml");
  const workflow = yaml.load(text);
  const job = workflow.jobs.monitor;
  assert.deepEqual(Object.keys(workflow.on).sort(), ["schedule", "workflow_dispatch"]);
  assert.equal(workflow.on.schedule[0].cron, "7,37 * * * *");
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true);
  assert.ok(job.if.includes("FACTORY_MONITOR_ENABLED == 'true'"));
  assert.ok(job.if.includes("refs/heads/main"));
  assert.ok(job.if.includes("github.run_attempt == 1"));
  assert.equal(job["timeout-minutes"], 8);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(job.permissions.issues, "write");
  assert.equal(job.permissions.contents, "write");
  assert.ok(!/claude-code-action|ANTHROPIC_API_KEY|OPENAI_API_KEY|deploy-hook/i.test(text));
  assert.deepEqual([...text.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]).sort(), [
    "FACTORY_MONITOR_PASSWORD",
    "FACTORY_MONITOR_USERNAME",
  ]);
  const checker = job.steps.find((step) => step.name === "Check synthetic-user API journey");
  assert.equal(checker.run, "node scripts/factory/app-checks.cjs");
  assert.equal(workflow.on.workflow_dispatch.inputs.app_checks.default, false);
  assert.deepEqual(Object.keys(job.env).sort(), [
    "FACTORY_APP_CHECKS_ENABLED",
    "FACTORY_FEED_CONTRACT_CHECK_ENABLED",
  ]);
  assert.equal(workflow.on.workflow_dispatch.inputs.feed_contract.default, false);
  assert.equal(job.permissions.actions, "read");
  assert.equal(job.permissions["pull-requests"], "read");
  assert.equal(job.concurrency.group, "factory-ledger");
  const evaluate = (key, vars, event, inputs) =>
    require("node:vm").runInNewContext(
      job.env[key].slice(3, -2),
      { vars, github: { event_name: event }, inputs },
      { timeout: 1000 }
    );
  for (const [event, dry, override, want] of [
    ["schedule", false, true, "false"],
    ["workflow_dispatch", false, true, "false"],
    ["workflow_dispatch", true, false, "false"],
    ["workflow_dispatch", true, true, "true"],
  ]) {
    const inputs = { dry_run: dry, app_checks: false, feed_contract: override };
    assert.equal(evaluate("FACTORY_FEED_CONTRACT_CHECK_ENABLED", {}, event, inputs), want);
    assert.equal(evaluate("FACTORY_APP_CHECKS_ENABLED", {}, event, inputs), want);
  }
  assert.equal(
    evaluate(
      "FACTORY_FEED_CONTRACT_CHECK_ENABLED",
      { FACTORY_FEED_CONTRACT_CHECK_ENABLED: "true" },
      "schedule",
      {}
    ),
    "true"
  );
  assert.equal(checker.if, "${{ env.FACTORY_APP_CHECKS_ENABLED == 'true' }}");
  assert.deepEqual(Object.keys(checker.env).sort(), [
    "FACTORY_MONITOR_PASSWORD",
    "FACTORY_MONITOR_USERNAME",
  ]);
  const publisher = job.steps.find(
    (step) => step.name === "Observe production and publish incident"
  );
  assert.ok(!Object.keys(publisher.env).some((key) => /USERNAME|PASSWORD/.test(key)));
  assert.equal(publisher.env.FACTORY_APP_CHECKS_ENABLED, undefined);
  const scan = job.steps.find((step) => step.name === "Scan credential-free app check report");
  assert.equal(scan.run, "node scripts/factory/app-checks-scan.cjs");
  assert.equal(scan.env, undefined);
  assert.ok(job.steps.indexOf(scan) > job.steps.indexOf(checker));
  assert.ok(job.steps.indexOf(scan) < job.steps.indexOf(publisher));
  assert.equal(
    job.steps.find((step) => step.uses?.startsWith("actions/checkout@")).with.ref,
    "${{ github.workflow_sha }}"
  );
  assert.equal(
    job.steps.find((step) => step.name === "Observe production and publish incident").run,
    "node scripts/factory/monitor.cjs"
  );
});
test("automatic preview has read permission for source monitor run verification", () => {
  const workflow = yaml.load(read("factory-automatic.yml"));
  assert.equal(workflow.jobs.pick.permissions.actions, "read");
});
