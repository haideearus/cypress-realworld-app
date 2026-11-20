const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  yaml = require("js-yaml");
test("owner acknowledgment workflow is manual, preview by default and credential separated", () => {
  const file = path.join(__dirname, "../../.github/workflows/factory-monitor-acknowledge.yml");
  assert.equal(fs.existsSync(file), true, "manual acknowledgment workflow must exist");
  const text = fs.readFileSync(file, "utf8"),
    w = yaml.load(text),
    j = w.jobs.acknowledge;
  assert.deepEqual(Object.keys(w.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(w.on.workflow_dispatch.inputs).sort(), [
    "blocked_repair",
    "dry_run",
    "issue",
  ]);
  assert.equal(w.on.workflow_dispatch.inputs.blocked_repair.default, false);
  assert.equal(w.on.workflow_dispatch.inputs.dry_run.default, true);
  assert.equal(j["timeout-minutes"], 8);
  assert.equal(j["runs-on"], "ubuntu-latest");
  assert.equal(w.concurrency.group, "factory-production-monitor");
  assert.equal(j.concurrency.group, "factory-ledger");
  assert.equal(w.concurrency["cancel-in-progress"], false);
  assert.equal(j.concurrency["cancel-in-progress"], false);
  for (const value of [
    "refs/heads/main",
    "github.run_attempt == 1",
    "github.actor == 'haideearus'",
    "github.triggering_actor == 'haideearus'",
    "FACTORY_ENABLED == 'false'",
    "FACTORY_AUTOMATION_ENABLED == 'false'",
    "FACTORY_AUTOMERGE_ENABLED == 'false'",
  ])
    assert.ok(j.if.includes(value));
  assert.deepEqual(j.permissions, {
    contents: "write",
    issues: "write",
    actions: "read",
    "pull-requests": "read",
  });
  assert.deepEqual([...text.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]).sort(), [
    "FACTORY_MONITOR_PASSWORD",
    "FACTORY_MONITOR_USERNAME",
  ]);
  assert.ok(
    !/claude-code-action|secrets\.(?:CLAUDE|ANTHROPIC|OPENAI|RENDER|FACTORY_GITHUB_APP)/i.test(text)
  );
  const [checker, scan, publisher] = [
    "Check recovery with synthetic account",
    "Scan credential-free recovery report",
    "Preview or acknowledge recovered incident",
  ].map((name) => j.steps.find((s) => s.name === name));
  assert.ok(checker && scan && publisher);
  assert.deepEqual(Object.keys(checker.env).sort(), [
    "ACK_BLOCKED_REPAIR",
    "FACTORY_MONITOR_PASSWORD",
    "FACTORY_MONITOR_USERNAME",
  ]);
  assert.ok(!Object.keys(publisher.env).some((k) => /USERNAME|PASSWORD/.test(k)));
  assert.equal(publisher.env.ACK_BLOCKED_REPAIR, checker.env.ACK_BLOCKED_REPAIR);
  assert.equal(scan.run, "node scripts/factory/app-checks-scan.cjs");
  assert.ok(j.steps.indexOf(scan) > j.steps.indexOf(checker));
  assert.ok(j.steps.indexOf(scan) < j.steps.indexOf(publisher));
  assert.equal(publisher.env.ACK_DRY_RUN, "${{ toJSON(inputs.dry_run) }}");
  assert.equal(publisher.env.ACK_ISSUE, "${{ inputs.issue }}");
  assert.equal(
    j.steps.find((s) => s.uses?.startsWith("actions/checkout@")).with.ref,
    "${{ github.workflow_sha }}"
  );
  assert.ok(
    !j.steps.some((s) => s.run?.includes("${{")),
    "inputs must enter via environment, never shell interpolation"
  );
});
