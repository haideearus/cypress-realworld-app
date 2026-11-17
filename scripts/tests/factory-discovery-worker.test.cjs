const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const yaml = require("js-yaml");
const { argsFor } = require("../factory/discovery-worker.cjs");
test("discovery model has no builtin shell/filesystem/network tool and only its pinned broker", () => {
  const args = argsFor({ turns: 200 }, "/tmp/discovery/mcp.json");
  assert.ok(args.includes("--tools="));
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes('--setting-sources ""'));
  assert.ok(args.includes("mcp__discovery__run_batch"));
  assert.ok(!args.includes("mcp__*"));
  assert.throws(() => argsFor({ turns: 200 }, "/tmp/evil;curl"), /Unsafe/);
});
test("workflow previews by default and confines OAuth to one reserved step; replay cannot get it", () => {
  const flow = yaml.load(fs.readFileSync(".github/workflows/factory-discovery.yml", "utf8"));
  assert.equal(flow.on.workflow_dispatch.inputs.dry_run.default, true);
  assert.equal(flow.on.workflow_dispatch.inputs.operation.default, "preview");
  assert.ok(flow.jobs.discover.if.includes("outputs.ready == 'true'"));
  const oauthSteps = Object.values(flow.jobs)
    .flatMap((j) => j.steps || [])
    .filter((s) => JSON.stringify(s).includes("secrets.CLAUDE_CODE_OAUTH_TOKEN"));
  assert.equal(oauthSteps.length, 1);
  assert.equal(oauthSteps[0].name, "Run the one reserved Claude discovery session");
  assert.equal(flow.jobs.discover.permissions.contents, "read");
  assert.equal(flow.jobs.replay.permissions.contents, "read");
  assert.equal(flow.jobs.select.concurrency.group, "factory-ledger");
  assert.equal(flow.jobs.finalize.concurrency.group, "factory-ledger");
  assert.equal(
    flow.jobs.discover.steps.find((s) => s.id === "model")["timeout-minutes"],
    "${{ fromJSON(vars.FACTORY_RUN_TIMEOUT_MINUTES || '15') }}"
  );
});
