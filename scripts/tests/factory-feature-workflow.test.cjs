const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("preview has its own read-only job and no planner or publication credential", () => {
  const workflow = fs
    .readFileSync(".github/workflows/factory-features.yml", "utf8")
    .replace(/\r\n/g, "\n");
  const preview = workflow.split("\n  preview:\n")[1].split("\n  select:\n")[0];
  assert.match(preview, /FACTORY_OPERATION: preview/);
  assert.doesNotMatch(preview, /secrets\.|: write|anthropics\//);
  const model = workflow.split("\n  plan:\n")[1].split("\n  finish:\n")[0];
  assert.match(model, /needs.select.outputs.ready == 'true'/);
  assert.match(model, /steps.prepare.outputs.ready == 'true'/);
  assert.match(model, /claude_code_oauth_token:.*secrets.CLAUDE_CODE_OAUTH_TOKEN/);
  assert.doesNotMatch(model, /: write|ANTHROPIC_API_KEY:.*secrets/);
  assert.match(workflow, /timezone: Europe\/Bucharest/);
  assert.match(workflow, /github.run_attempt == 1/);
  assert.match(workflow, /vars.FACTORY_FEATURE_MODE == 'pilot'/);
  assert.match(workflow, /vars.FACTORY_FEATURE_MODE == 'live'/);
  assert.equal((workflow.match(/group: factory-ledger/g) || []).length, 2);
});
