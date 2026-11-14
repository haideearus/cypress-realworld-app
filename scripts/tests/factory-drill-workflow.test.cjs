const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

function workflow() {
  return yaml.load(
    fs.readFileSync(
      path.join(__dirname, "../../.github/workflows/factory-monitor-drill.yml"),
      "utf8"
    )
  );
}
const action = (job, name) => job.steps.filter((step) => step.uses?.startsWith(`actions/${name}@`));
const operation = (job, name) =>
  job.steps.find((step) => step.env?.FACTORY_DRILL_OPERATION === name);

test("drill dispatch defaults to preview with no schedule or arbitrary source, target or command inputs", () => {
  const flow = workflow();
  assert.deepEqual(Object.keys(flow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(flow.on.workflow_dispatch.inputs), ["dry_run"]);
  assert.deepEqual(
    (({ type, required, default: defaultValue }) => ({ type, required, defaultValue }))(
      flow.on.workflow_dispatch.inputs.dry_run
    ),
    { type: "boolean", required: true, defaultValue: true }
  );
  assert.deepEqual(flow.permissions, { contents: "read" });
  for (const guard of [
    "github.repository == 'haideearus/cypress-realworld-app'",
    "github.ref == 'refs/heads/main'",
    "github.run_attempt == 1",
    "github.actor == 'haideearus'",
    "github.triggering_actor == 'haideearus'",
  ])
    assert.ok(flow.jobs.window.if.includes(guard), `Missing dispatch guard: ${guard}`);
});

test("preview has no write permissions and live preparation waits 90 seconds before re-reading variables", () => {
  const { window, prepare } = workflow().jobs;
  assert.equal(window.permissions, undefined);
  assert.equal(window.secrets, undefined);
  const check = window.steps.find((step) => step.id === "window");
  assert.equal(check.run, "node scripts/factory/monitor-drill.cjs");
  assert.equal(check.env.FACTORY_DRILL_OPERATION, "${{ inputs.dry_run && 'preview' || 'window' }}");
  const pause = window.steps.find((step) => step.run === "sleep 90");
  assert.ok(pause, "The live dispatch must provide the shutdown window");
  assert.ok(window.steps.indexOf(pause) > window.steps.indexOf(check));
  assert.equal(pause.if, "${{ steps.window.outputs.ready == 'true' }}");
  assert.equal(prepare.needs, "window");
  assert.equal(prepare.if, "${{ needs.window.outputs.ready == 'true' }}");
  const admission = operation(prepare, "prepare");
  assert.ok(admission);
  assert.equal(admission.env.FACTORY_VARIABLES, "${{ toJSON(vars) }}");
  assert.equal(admission.run, "node scripts/factory/monitor-drill.cjs");
});

test("the rehearsal calls one reserved coding worker without review, retry, merge or deployment stages", () => {
  const flow = workflow();
  const reusable = Object.entries(flow.jobs).filter(([, job]) => job.uses);
  assert.equal(reusable.length, 1);
  const [name, coding] = reusable[0];
  assert.equal(name, "coding");
  assert.equal(coding.uses, "./.github/workflows/factory-model.yml");
  assert.equal(coding.needs, "prepare");
  assert.equal(coding.if, "${{ needs.prepare.outputs.ready == 'true' }}");
  assert.deepEqual(coding.with, {
    ticket: "${{ needs.prepare.outputs.ticket }}",
    grantId: "${{ needs.prepare.outputs.grantId }}",
    head: "${{ needs.prepare.outputs.head }}",
    slot: "drill",
    phase: "code",
  });
  assert.deepEqual(Object.keys(flow.jobs).sort(), [
    "coding",
    "finalize",
    "prepare",
    "verify",
    "window",
  ]);
  for (const job of Object.values(flow.jobs)) {
    assert.equal(job.strategy, undefined, "A matrix must not duplicate the reserved invocation");
    for (const step of job.steps || []) {
      if (step.uses)
        assert.match(
          step.uses,
          /^actions\/(checkout|setup-node|download-artifact|upload-artifact)@[a-f0-9]{40}$/
        );
      assert.doesNotMatch(
        step.run || "",
        /\b(gh|curl|wget)\b|factory-(cycle|merge|agents)|deploy|render/i
      );
    }
  }
});

test("only the coding call receives the existing subscription secret and no job receives production credentials", () => {
  const flow = workflow();
  assert.deepEqual(flow.jobs.coding.secrets, {
    CLAUDE_CODE_OAUTH_TOKEN: "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
  });
  assert.deepEqual(flow.jobs.coding.permissions, {
    contents: "read",
    issues: "read",
    "pull-requests": "read",
  });
  for (const [name, job] of Object.entries(flow.jobs)) {
    if (name !== "coding") assert.doesNotMatch(JSON.stringify(job), /secrets\./);
    assert.doesNotMatch(
      JSON.stringify(job),
      /ANTHROPIC_API_KEY|OPENAI_API_KEY|ANTHROPIC_AUTH_TOKEN|FACTORY_GITHUB_APP_PRIVATE_KEY|RENDER|DATABASE_URL|DEPLOY_HOOK/i
    );
    assert.equal(job.permissions?.["pull-requests"] === "write", false);
    assert.equal(job.permissions?.deployments, undefined);
    assert.equal(job.permissions?.["id-token"], undefined);
  }
});

test("verification has no write or model credentials and consumes the reserved bundle through the sandbox verifier", () => {
  const verify = workflow().jobs.verify;
  assert.deepEqual(verify.needs, ["prepare", "coding"]);
  assert.equal(verify.if, "${{ needs.coding.result == 'success' }}");
  assert.deepEqual(verify.permissions, { contents: "read" });
  assert.equal(verify.env, undefined);
  assert.equal(verify.secrets, undefined);
  for (const step of verify.steps)
    assert.doesNotMatch(JSON.stringify(step.env || {}), /token|secret|FACTORY_VARIABLES/i);
  assert.deepEqual(action(verify, "download-artifact")[0].with, {
    name: "code-${{ needs.prepare.outputs.grantId }}",
    path: "${{ runner.temp }}/drill-code",
  });
  const runs = verify.steps.filter((step) => step.run);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].env.FACTORY_DRILL_IDENTITY, "${{ needs.prepare.outputs.identity }}");
  assert.equal(runs[1].run, "node scripts/factory/drill-verify.cjs verify");
  assert.deepEqual(runs[1].env, {
    FACTORY_DRILL_INPUT: "${{ runner.temp }}/drill-input.json",
    FACTORY_DRILL_BUNDLE: "${{ runner.temp }}/drill-code/bundle.json",
    FACTORY_DRILL_REPORT: "${{ runner.temp }}/drill-verification.json",
  });
});

test("all trusted helpers are checked out from the reviewed workflow SHA without persisted credentials", () => {
  for (const [name, job] of Object.entries(workflow().jobs)) {
    if (job.uses) continue;
    const checkouts = action(job, "checkout");
    assert.equal(checkouts.length, 1, `${name} must have one trusted source checkout`);
    assert.deepEqual(checkouts[0].with, {
      ref: "${{ github.workflow_sha }}",
      "persist-credentials": false,
      "sparse-checkout": "scripts/factory",
    });
    assert.ok(job.steps.indexOf(checkouts[0]) < job.steps.findIndex((step) => step.run));
    assert.equal(job["runs-on"], "ubuntu-24.04");
  }
});

test("rehearsal runs remain bounded and ledger writes serialize without cancelling an active reservation", () => {
  const flow = workflow();
  assert.deepEqual(flow.concurrency, {
    group: "factory-monitor-rehearsal",
    "cancel-in-progress": false,
  });
  for (const name of ["prepare", "finalize"])
    assert.deepEqual(flow.jobs[name].concurrency, {
      group: "factory-ledger",
      "cancel-in-progress": false,
    });
  for (const job of Object.values(flow.jobs)) {
    if (job.uses) continue;
    assert.ok(Number.isInteger(job["timeout-minutes"]));
    assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 10);
  }
  assert.equal(flow.jobs.verify.concurrency, undefined);
  assert.equal(flow.jobs.coding.concurrency, undefined);
});

test("finalization waits for model and verifier completion and reads only their grant-bound evidence", () => {
  const { prepare, verify, finalize } = workflow().jobs;
  assert.deepEqual(finalize.needs, ["prepare", "coding", "verify"]);
  assert.equal(
    finalize.if,
    "${{ always() && !cancelled() && needs.prepare.outputs.ready == 'true' }}"
  );
  assert.deepEqual(finalize.permissions, { contents: "write", issues: "write", actions: "read" });
  const download = action(finalize, "download-artifact");
  assert.equal(download.length, 2);
  for (const step of download) assert.equal(step.if, "${{ needs.verify.result == 'success' }}");
  assert.deepEqual(
    download.map((step) => step.with),
    [
      { name: "code-${{ needs.prepare.outputs.grantId }}", path: "${{ runner.temp }}/drill-code" },
      {
        name: "drill-verification-${{ needs.prepare.outputs.grantId }}",
        path: "${{ runner.temp }}/drill-verified",
      },
    ]
  );
  const finish = operation(finalize, "finalize");
  assert.equal(finish.env.FACTORY_DRILL_PREPARED, "${{ needs.prepare.outputs.prepared }}");
  assert.equal(
    finish.env.FACTORY_DRILL_REPORT,
    "${{ runner.temp }}/drill-verified/drill-verification.json"
  );
  assert.equal(finish.env.FACTORY_DRILL_BUNDLE, "${{ runner.temp }}/drill-code/bundle.json");
  assert.deepEqual(action(verify, "upload-artifact")[0].with, {
    name: "drill-verification-${{ needs.prepare.outputs.grantId }}",
    path: "${{ runner.temp }}/drill-verification.json",
    "if-no-files-found": "warn",
    "retention-days": 14,
  });
  for (const [job, artifact, file] of [
    [prepare, "drill-preparation", "drill-preparation.json"],
    [finalize, "drill-result", "drill-result.json"],
  ]) {
    const upload = action(job, "upload-artifact");
    assert.equal(upload.length, 1);
    assert.equal(upload[0].with.name, artifact);
    assert.equal(upload[0].with.path, `\${{ runner.temp }}/${file}`);
    assert.equal(upload[0].with["retention-days"], 14);
  }
});
