const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const filename = path.resolve(__dirname, "../../.github/workflows/factory-discovery-recovery.yml");
const pins = {
  checkout: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  node: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  upload: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
};
function load() {
  assert.ok(fs.existsSync(filename), "missing saved privacy discovery recovery workflow");
  return yaml.load(fs.readFileSync(filename, "utf8"));
}
function control(job, phase) {
  const step = job.steps.find((item) => item.env?.FACTORY_OPERATION === phase);
  assert.ok(step, `missing trusted ${phase} controller`);
  return step;
}

test("saved recovery admits only manual preview, run or reconciliation and defaults to no writes", () => {
  const flow = load();
  assert.equal(flow.name, "Saved privacy discovery recovery");
  assert.deepEqual(Object.keys(flow.on), ["workflow_dispatch"]);
  const inputs = flow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), ["operation", "dry_run"]);
  assert.equal(inputs.operation.type, "choice");
  assert.deepEqual(inputs.operation.options, ["preview", "run", "reconcile"]);
  assert.equal(inputs.operation.default, "preview");
  assert.equal(inputs.dry_run.type, "boolean");
  assert.equal(inputs.dry_run.default, true);
  assert.deepEqual(flow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(flow.jobs), ["select", "replay", "finalize"]);
  assert.match(flow.jobs.select.if, /github\.repository == 'haideearus\/cypress-realworld-app'/);
  assert.match(flow.jobs.select.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(flow.jobs.select.if, /github\.run_attempt == 1/);
});

test("every action is pinned and every job executes trusted workflow source with bounded time", () => {
  const flow = load();
  for (const [name, job] of Object.entries(flow.jobs)) {
    assert.equal(job["runs-on"], "ubuntu-latest");
    assert.equal(job["timeout-minutes"], name === "replay" ? 45 : 5);
    const checkout = job.steps.filter((step) => step.uses === pins.checkout);
    assert.equal(checkout.length, 1);
    assert.equal(checkout[0].with.ref, "${{ github.workflow_sha }}");
    assert.equal(checkout[0].with["persist-credentials"], false);
    if (name === "replay") assert.equal(checkout[0].with["fetch-depth"], 0);
    const node = job.steps.filter((step) => step.uses === pins.node);
    assert.equal(node.length, 1);
    assert.equal(node[0].with["node-version"], "22.20.0");
    for (const step of job.steps) {
      if (!step.uses) continue;
      assert.ok(Object.values(pins).includes(step.uses), `unexpected action ${step.uses}`);
      assert.match(step.uses, /@[a-f0-9]{40}$/);
    }
  }
});

test("only selection and finalization can write ledger state and share uncancelled serialization", () => {
  const { jobs } = load();
  for (const name of ["select", "finalize"]) {
    assert.deepEqual(jobs[name].permissions, {
      actions: "read",
      contents: "write",
      issues: "read",
    });
    assert.deepEqual(jobs[name].concurrency, {
      group: "factory-ledger",
      "cancel-in-progress": false,
    });
  }
  assert.deepEqual(jobs.replay.permissions, { actions: "read", contents: "read", issues: "read" });
  assert.equal(jobs.replay.concurrency, undefined);
});

test("selection passes owner verification, stopped controls and dry-run inputs to the trusted CLI", () => {
  const flow = load();
  const select = control(flow.jobs.select, "select");
  assert.equal(select.id, "control");
  assert.equal(select.name, "Verify source and reserve or reconcile recovery");
  assert.equal(select.run, "node scripts/factory/discovery-recovery-run.cjs");
  assert.deepEqual(select.env, {
    GH_TOKEN: "${{ github.token }}",
    FACTORY_VARIABLES: "${{ toJSON(vars) }}",
    FACTORY_INPUTS: "${{ toJSON(inputs) }}",
    FACTORY_OPERATION: "select",
  });
  assert.deepEqual(flow.jobs.select.outputs, {
    ready: "${{ steps.control.outputs.ready }}",
    receiptId: "${{ steps.control.outputs.receiptId }}",
    artifactName: "${{ steps.control.outputs.artifactName }}",
  });
  // Recovery consumes an existing saved session while discovery is stopped.
  // Config and actor checks belong to the CLI, rather than a discovery-ON gate.
  for (const job of Object.values(flow.jobs))
    assert.doesNotMatch(
      job.if || "",
      /vars\.|FACTORY_DISCOVERY_ENABLED|FACTORY_AUTOMATION_ENABLED|FACTORY_AUTO_MERGE/
    );
});

test("replay requires a durable reservation and runs the preserved trusted helper without credentials for a model", () => {
  const job = load().jobs.replay;
  assert.equal(job.needs, "select");
  assert.equal(job.if, "${{ needs.select.outputs.ready == 'true' }}");
  const preserveIndex = job.steps.findIndex((step) => String(step.run || "").includes("cpSync"));
  const scannerIndex = job.steps.findIndex(
    (step) => step.run === 'node "$RUNNER_TEMP/factory-control/scanner-install.cjs"'
  );
  const replayIndex = job.steps.findIndex((step) => step.id === "replay");
  assert.ok(preserveIndex >= 0 && scannerIndex > preserveIndex && replayIndex > scannerIndex);
  assert.equal(
    job.steps[preserveIndex].run,
    "node -e \"require('node:fs').cpSync('scripts/factory',process.env.RUNNER_TEMP+'/factory-control',{recursive:true})\""
  );
  const replay = control(job, "replay");
  assert.equal(replay.id, "replay");
  assert.equal(replay.name, "Replay saved privacy candidates without a model");
  assert.equal(replay.run, 'node "$RUNNER_TEMP/factory-control/discovery-recovery-run.cjs"');
  assert.deepEqual(replay.env, {
    GH_TOKEN: "${{ github.token }}",
    FACTORY_VARIABLES: "${{ toJSON(vars) }}",
    FACTORY_INPUTS: "${{ toJSON(needs.select.outputs) }}",
    FACTORY_OPERATION: "replay",
    FACTORY_RECOVERY_OUTPUT: "${{ runner.temp }}/recovery-output",
  });
});

test("replay uploads only the fixed evidence JSON under the receipt-bound artifact name", () => {
  const { jobs } = load();
  const uploads = Object.values(jobs)
    .flatMap((job) => job.steps)
    .filter((step) => step.uses === pins.upload);
  assert.equal(uploads.length, 1);
  assert.equal(jobs.replay.steps.at(-1), uploads[0]);
  assert.equal(uploads[0].if, undefined, "a failed replay must not upload incomplete evidence");
  assert.deepEqual(uploads[0].with, {
    name: "${{ needs.select.outputs.artifactName }}",
    path: "${{ runner.temp }}/recovery-output/evidence.json",
    "if-no-files-found": "error",
    "retention-days": 14,
  });
});

test("finalization retains consumed quota after replay failure and only finishes a ready receipt", () => {
  const job = load().jobs.finalize;
  assert.deepEqual(job.needs, ["select", "replay"]);
  assert.equal(
    job.if,
    "${{ always() && needs.select.outputs.receiptId != '' && needs.select.outputs.ready == 'true' }}"
  );
  const finish = control(job, "finish");
  assert.equal(finish.id, "control");
  assert.equal(finish.name, "Retain recovered proof or a visible hold");
  assert.equal(finish.run, "node scripts/factory/discovery-recovery-run.cjs");
  assert.deepEqual(finish.env, {
    GH_TOKEN: "${{ github.token }}",
    FACTORY_VARIABLES: "${{ toJSON(vars) }}",
    FACTORY_INPUTS: "${{ toJSON(needs.select.outputs) }}",
    FACTORY_OPERATION: "finish",
    FACTORY_REPLAY_SUCCESS: "${{ needs.replay.result == 'success' }}",
  });
});

test("saved recovery exposes no model, production or app credentials and cannot dispatch producers", () => {
  const flow = load();
  const serialized = JSON.stringify(flow);
  assert.doesNotMatch(
    serialized,
    /secrets\.|ANTHROPIC|OPENAI|CLAUDE|anthropics\/|claude-code|api\.openai|\/dispatches|gh workflow|gh api|workflow_run|workflow_call/i
  );
  assert.doesNotMatch(
    serialized,
    /settings|variables\/|\/actions\/permissions|factory-discovery\.yml/
  );
  assert.equal(flow.secrets, undefined);
  for (const job of Object.values(flow.jobs)) {
    assert.equal(job.secrets, undefined);
    assert.equal(job.uses, undefined);
    for (const step of job.steps) {
      assert.equal(step.secrets, undefined);
      if (!step.env) continue;
      for (const name of Object.keys(step.env))
        assert.ok(
          name === "GH_TOKEN" || name.startsWith("FACTORY_"),
          `unexpected credential ${name}`
        );
    }
  }
});
