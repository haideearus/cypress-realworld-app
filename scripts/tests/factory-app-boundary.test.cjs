const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const yaml = require("js-yaml");

const root = path.resolve(__dirname, "../..");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
function load(relative) {
  const file = path.join(root, relative);
  assert.ok(fs.existsSync(file), `${relative} must exist`);
  return yaml.load(fs.readFileSync(file, "utf8"));
}
const appAction = () => load(".github/actions/factory-app-token/action.yml");
const cycle = () => load(".github/workflows/factory-cycle.yml");

function runStep(step, env, cwd = root) {
  return spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step.run], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
  });
}
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "factory-app-boundary-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("App installation token is pinned, repository scoped, least privileged, and revoked", () => {
  const action = appAction();
  const mint = action.runs.steps.find((step) => step.id === "mint");
  assert.equal(
    mint.uses,
    "actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510"
  );
  assert.deepEqual(mint.with, {
    "client-id": "${{ inputs.client-id }}",
    "private-key": "${{ inputs.private-key }}",
    owner: "haideearus",
    repositories: "cypress-realworld-app",
    "permission-contents": "write",
    "permission-pull-requests": "write",
    "permission-actions": "write",
    "permission-checks": "read",
    "permission-issues": "read",
    "skip-token-revoke": false,
  });
  assert.equal(action.outputs.token.value, "${{ steps.validate.outputs.token }}");
  for (const name of ["client-id", "private-key", "expected-slug"])
    assert.equal(action.inputs[name].required, true);
});

test("missing App configuration fails before token mint without exposing supplied credentials", (t) => {
  const action = appAction();
  const guard = action.runs.steps.find((step) => step.id === "credentials");
  assert.ok(guard, "credential validation must precede installation token minting");
  assert.ok(
    action.runs.steps.indexOf(guard) < action.runs.steps.findIndex((step) => step.id === "mint")
  );
  const directory = temporary(t);
  for (const missing of [
    "FACTORY_APP_CLIENT_ID",
    "FACTORY_APP_PRIVATE_KEY",
    "FACTORY_EXPECTED_APP_SLUG",
  ]) {
    const env = {
      FACTORY_APP_CLIENT_ID: "Iv1.synthetic-client",
      FACTORY_APP_PRIVATE_KEY: "synthetic-private-key-do-not-log",
      FACTORY_EXPECTED_APP_SLUG: "factory-maintainer",
      GITHUB_OUTPUT: path.join(directory, "output"),
      [missing]: "",
    };
    const result = runStep(guard, env);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /configuration/i);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-key-do-not-log/);
    assert.equal(fs.existsSync(env.GITHUB_OUTPUT), false);
  }
});

test("unverified or missing installation tokens cannot become publisher outputs", (t) => {
  const validate = appAction().runs.steps.find((step) => step.id === "validate");
  assert.ok(validate, "only the validated token can be exposed");
  const directory = temporary(t);
  for (const [actual, expected, token] of [
    ["other-app", "factory-maintainer", "ghs_synthetic-installation-token"],
    ["factory-maintainer", "factory-maintainer", ""],
    ["", "factory-maintainer", "ghs_synthetic-installation-token"],
    ["factory-maintainer", "", "ghs_synthetic-installation-token"],
    ["factory-maintainer", "factory-maintainer", "ghs_synthetic\ntoken=injection"],
  ]) {
    const output = path.join(directory, "output");
    const result = runStep(validate, {
      FACTORY_APP_SLUG: actual,
      FACTORY_EXPECTED_APP_SLUG: expected,
      FACTORY_APP_TOKEN: token,
      GITHUB_OUTPUT: output,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(fs.existsSync(output), false, "rejected credentials must not yield outputs");
    assert.doesNotMatch(result.stdout + result.stderr, /ghs_synthetic/);
  }
});

test("verified installation token is masked before emission and is never printed as ordinary log text", (t) => {
  const validate = appAction().runs.steps.find((step) => step.id === "validate");
  const output = path.join(temporary(t), "output");
  const token = "ghs_synthetic-installation-token";
  const result = runStep(validate, {
    FACTORY_APP_SLUG: "factory-maintainer",
    FACTORY_EXPECTED_APP_SLUG: "factory-maintainer",
    FACTORY_APP_TOKEN: token,
    GITHUB_OUTPUT: output,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `::add-mask::${token}`);
  assert.equal(result.stderr, "");
  assert.equal(fs.readFileSync(output, "utf8"), `token=${token}\n`);
});

test("controller action routes automatic operations without changing the manual entry point or token environment", (t) => {
  const action = load(".github/actions/factory-control/action.yml");
  assert.ok(action.inputs.github_token, "trusted control requires an explicit token override");
  assert.equal(action.inputs.github_token.required, false);
  assert.equal(action.inputs.github_token.default, "${{ github.token }}");
  const command = action.runs.steps.find((step) => step.id === "run");
  assert.deepEqual(command.env, {
    GH_TOKEN: "${{ inputs.github_token }}",
    FACTORY_VARIABLES: "${{ inputs.variables_json }}",
    FACTORY_OPERATION: "${{ inputs.operation }}",
    FACTORY_INPUTS: "${{ inputs.parameters }}",
    FACTORY_BUNDLE_PATH: "${{ inputs.bundle_path }}",
  });
  const directory = temporary(t);
  fs.mkdirSync(path.join(directory, "scripts/factory"), { recursive: true });
  for (const file of ["controller.cjs", "automation.cjs"])
    fs.writeFileSync(
      path.join(directory, "scripts/factory", file),
      `require("node:fs").writeFileSync(process.env.GITHUB_OUTPUT, JSON.stringify({ handler: ${JSON.stringify(file)}, operation: process.env.FACTORY_OPERATION, token: process.env.GH_TOKEN }));`
    );
  for (const [operation, handler] of [
    ["auto_pick", "automation.cjs"],
    ["auto_merge", "automation.cjs"],
    ["publish", "controller.cjs"],
    ["validate", "controller.cjs"],
    ["automatic", "controller.cjs"],
  ]) {
    const output = path.join(directory, "output");
    const result = runStep(
      command,
      {
        FACTORY_OPERATION: operation,
        GH_TOKEN: "synthetic-explicit-installation-token",
        GITHUB_OUTPUT: output,
      },
      directory
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), {
      handler,
      operation,
      token: "synthetic-explicit-installation-token",
    });
  }
});

test("cycle callers opt into App publication while existing manual callers need no App secret", () => {
  const flow = cycle();
  assert.deepEqual(flow.on.workflow_call.inputs.automatic, {
    type: "boolean",
    required: false,
    default: false,
  });
  assert.deepEqual(flow.on.workflow_call.secrets.FACTORY_GITHUB_APP_PRIVATE_KEY, {
    required: false,
  });
  const publish = flow.jobs.publish;
  const app = publish.steps.find((step) => step.uses === "./.github/actions/factory-app-token");
  assert.ok(app, "only opt-in trusted publication may mint an App token");
  assert.equal(app.if, "${{ inputs.automatic }}");
  assert.deepEqual(app.with, {
    "client-id": "${{ vars.FACTORY_GITHUB_APP_CLIENT_ID }}",
    "private-key": "${{ secrets.FACTORY_GITHUB_APP_PRIVATE_KEY }}",
    "expected-slug": "${{ vars.FACTORY_GITHUB_APP_SLUG }}",
  });
  const control = publish.steps.find((step) => step.id === "control");
  assert.equal(control.with.operation, "publish");
  assert.equal(
    control.with.github_token,
    "${{ inputs.automatic == false && github.token || steps.app.outputs.token }}",
    "automatic publication cannot fall back to the non-triggering workflow token"
  );
  assert.ok(publish.steps.indexOf(app) < publish.steps.indexOf(control));
  assert.equal(
    publish.steps.find((step) => step.uses?.startsWith("actions/checkout@")).with.ref,
    "${{ github.workflow_sha }}"
  );
});

test("App secrets and write tokens stay outside all model, review, and PR-code execution jobs", () => {
  const flow = cycle();
  assert.deepEqual(Object.keys(flow.jobs.coding.secrets), ["CLAUDE_CODE_OAUTH_TOKEN"]);
  assert.deepEqual(Object.keys(flow.jobs.review.secrets), ["CLAUDE_CODE_OAUTH_TOKEN"]);
  for (const [name, job] of Object.entries(flow.jobs)) {
    if (name === "publish") continue;
    assert.doesNotMatch(
      JSON.stringify(job),
      /FACTORY_GITHUB_APP|factory-app-token|steps\.app\.outputs/
    );
  }
  const model = load(".github/workflows/factory-model.yml");
  assert.doesNotMatch(JSON.stringify(model), /FACTORY_GITHUB_APP|factory-app-token/);
});
