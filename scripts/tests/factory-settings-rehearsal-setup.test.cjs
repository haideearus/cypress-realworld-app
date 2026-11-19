const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repo = path.resolve(__dirname, "../..");
const script = path.join(repo, "scripts/rehearsal/prepare-settings.cjs");
const seedPath = "src/components/UserSettingsForm.tsx";
const rehearsalRepo = "haideearus/cypress-realworld-app-settings-rehearsal";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("preparation exports the healthy app and a separate one-line seed, with no live workflows", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "settings-preparation-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const output = path.join(temp, "rehearsal");
  const { prepareSettings } = require(script);
  prepareSettings(repo, git(repo, "rev-parse", "HEAD").trim(), output);
  const app = path.join(output, "app");
  const read = (file) => fs.readFileSync(path.join(app, file), "utf8");
  const workflows = fs.readdirSync(path.join(app, ".github/workflows"));
  assert.deepEqual(workflows.sort(), [
    "factory-agents.yml",
    "factory-automatic.yml",
    "factory-ci.yml",
    "factory-cycle.yml",
    "factory-functional-discovery.yml",
    "factory-model.yml",
    "factory-pr-review.yml",
    "factory-review-gate.yml",
    "factory-review-status.yml",
    "factory-wake.yml",
  ]);
  assert.equal(fs.existsSync(path.join(app, ".git")), false);
  assert.equal(fs.existsSync(path.join(app, "render.yaml")), false);
  assert.equal(fs.existsSync(path.join(app, ".github/dependabot.yml")), false);
  assert.equal(require(path.join(app, "scripts/factory/policy.cjs")).REPOSITORY, rehearsalRepo);
  assert.equal(
    require(path.join(app, "scripts/factory/github.cjs")).ROOT,
    `/repos/${rehearsalRepo}`
  );
  const { GitHub } = require(path.join(app, "scripts/factory/github.cjs"));
  const api = new GitHub({
    token: "fixture-only",
    fetch: () => assert.fail("unexpected transport"),
  });
  await assert.rejects(
    api.request("POST", "/repos/haideearus/cypress-realworld-app/issues", { title: "fixture" }),
    /inside the factory repository/
  );
  assert.match(
    read(".github/actions/factory-app-token/action.yml"),
    /repositories: cypress-realworld-app-settings-rehearsal\r?\n/
  );
  assert.match(read(".github/workflows/factory-wake.yml"), /Safe functional discovery/);
  assert.match(
    read(".github/workflows/factory-functional-discovery.yml"),
    /outputs\.assertion == 'settings-email-invalid'/
  );
  for (const workflow of workflows) {
    const content = read(`.github/workflows/${workflow}`);
    assert.doesNotMatch(content, /^  schedule:\s*$/m);
    assert.doesNotMatch(content, /onrender\.com|RENDER_DEPLOY|anthropic_api_key:/);
  }
  const expected = read(seedPath);
  assert.match(expected, /\.email\("Must contain a valid email address"\)/);
  git(app, "init", "--quiet");
  git(app, "apply", path.join(output, "settings-validation-seed.patch"));
  assert.equal(
    read(seedPath),
    expected.replace('email("Must contain a valid email address")', 'email("Invalid email")')
  );
  assert.throws(
    () => prepareSettings(repo, git(repo, "rev-parse", "HEAD").trim(), output),
    /already exists/
  );
});
