const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = "7b7482f165c618b6b7188e2726e82242a62c5dcc";
const LIVE = "haideearus/cypress-realworld-app";
const SANDBOX = `${LIVE}-settings-rehearsal`;
const LIVE_APP_URL = "https://haide-software-factory.onrender.com";
const SANDBOX_APP_URL = "https://settings-rehearsal.invalid";
const WORKFLOWS = new Set([
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
const TESTS = [
  "automatic-pickup",
  "automatic-security",
  "functional-browser",
  "functional-discovery",
  "gate-status",
  "merge",
  "ci-quota",
  "wake",
];
const FORM = "src/components/UserSettingsForm.tsx";

function replaceOnce(text, from, to) {
  const index = text.indexOf(from);
  if (index < 0 || text.indexOf(from, index + from.length) >= 0)
    throw Error(`Pinned source has an unexpected occurrence count for ${from}`);
  return text.slice(0, index) + to + text.slice(index + from.length);
}

function modify(app, file, update) {
  const target = path.join(app, file);
  fs.writeFileSync(target, update(fs.readFileSync(target, "utf8")));
}

function isolateWorkflows(app) {
  const directory = path.join(app, ".github/workflows");
  for (const file of fs.readdirSync(directory)) {
    if (!WORKFLOWS.has(file)) fs.unlinkSync(path.join(directory, file));
  }
  for (const file of WORKFLOWS) {
    modify(app, `.github/workflows/${file}`, (source) => {
      const scoped = source
        .replaceAll(`${LIVE}'`, `${SANDBOX}'`)
        .replaceAll(LIVE_APP_URL, SANDBOX_APP_URL);
      // The rehearsal has one owner dispatch and a resulting event wake. No cron.
      return scoped.replace(/^  schedule:\r?\n    - cron:[^\r\n]+\r?\n/m, "");
    });
  }
  // Preview reports all outcomes. Only this assertion can open an issue in the rehearsal.
  modify(app, ".github/workflows/factory-functional-discovery.yml", (source) =>
    replaceOnce(
      source,
      "    if: ${{ needs.browser.result == 'success' }}",
      `    if: >-
      \${{ needs.browser.result == 'success' &&
          (inputs.dry_run || needs.browser.outputs.status == 'healthy' ||
           (needs.browser.outputs.status == 'confirmed_failure' &&
            needs.browser.outputs.check == 'form-validation' &&
            needs.browser.outputs.assertion == 'settings-email-invalid')) }}`
    )
  );
  modify(app, ".github/actions/factory-app-token/action.yml", (source) =>
    replaceOnce(
      source,
      "repositories: cypress-realworld-app",
      `repositories: ${SANDBOX.split("/")[1]}`
    )
  );
}

function seedPatch(source) {
  const original = '.email("Must contain a valid email address")';
  const changed = replaceOnce(source, original, '.email("Invalid email")');
  const lines = source.split("\n");
  const line = lines.findIndex((text) => text.includes(original));
  return [
    `diff --git a/${FORM} b/${FORM}`,
    `--- a/${FORM}`,
    `+++ b/${FORM}`,
    `@@ -${line},3 +${line},3 @@`,
    ` ${lines[line - 1]}`,
    `-${lines[line]}`,
    `+${changed.split("\n")[line]}`,
    ` ${lines[line + 1]}`,
    "",
  ].join("\n");
}

function prepareSettings(repo, commit, destination) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error("Use the complete source commit SHA");
  const parent = fs.realpathSync(path.dirname(destination));
  const output = path.join(parent, path.basename(destination));
  const relative = path.relative(fs.realpathSync(repo), output);
  if (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    throw Error("Put the rehearsal bundle outside the source checkout");
  if (fs.existsSync(output)) throw Error("The rehearsal bundle already exists");

  const tree = execFileSync("git", ["ls-tree", "-r", commit], { cwd: repo, encoding: "utf8" });
  if (/^(120000|160000) /m.test(tree)) throw Error("Source contains a symlink or Git submodule");
  fs.mkdirSync(output);
  const app = path.join(output, "app");
  fs.mkdirSync(app);
  const archive = path.join(output, "source.tar");
  try {
    execFileSync("git", ["archive", "--format=tar", "-o", archive, commit], { cwd: repo });
    execFileSync("tar", ["-xf", archive, "-C", app]);
  } finally {
    if (fs.existsSync(archive)) fs.unlinkSync(archive);
  }

  isolateWorkflows(app);
  fs.unlinkSync(path.join(app, "render.yaml"));
  fs.unlinkSync(path.join(app, ".github/dependabot.yml"));
  modify(app, "scripts/factory/policy.cjs", (source) =>
    replaceOnce(replaceOnce(source, `"${LIVE}"`, `"${SANDBOX}"`), LIVE_APP_URL, SANDBOX_APP_URL)
  );
  modify(app, "scripts/factory/wake-contract.cjs", (source) =>
    replaceOnce(source, `"${LIVE}"`, `"${SANDBOX}"`)
  );
  for (const file of [
    ...TESTS.map((name) => `factory-${name}.test.cjs`),
    "helpers/factory-fixtures.cjs",
    "helpers/event-fixtures.cjs",
  ]) {
    modify(app, `scripts/tests/${file}`, (source) =>
      source.replaceAll(LIVE, SANDBOX).replaceAll(LIVE_APP_URL, SANDBOX_APP_URL)
    );
  }
  modify(app, "package.json", (source) =>
    replaceOnce(
      source,
      "node --test scripts/tests/factory-*.test.cjs",
      `node --test ${TESTS.map((name) => `scripts/tests/factory-${name}.test.cjs`).join(" ")}`
    )
  );
  modify(app, "AGENTS.md", (source) => source.replaceAll(LIVE, SANDBOX));
  modify(app, ".github/PULL_REQUEST_TEMPLATE.md", (source) => source.replaceAll(LIVE, SANDBOX));
  fs.writeFileSync(
    path.join(output, "settings-validation-seed.patch"),
    seedPatch(fs.readFileSync(path.join(app, FORM), "utf8"))
  );
  fs.writeFileSync(
    path.join(output, "rehearsal.json"),
    JSON.stringify({ source: commit, repository: SANDBOX }, null, 2) + "\n"
  );
}

if (require.main === module) {
  const [destination, ...extra] = process.argv.slice(2);
  if (!destination || extra.length)
    throw Error("Usage: node scripts/rehearsal/prepare-settings.cjs <new-folder>");
  prepareSettings(path.resolve(__dirname, "../.."), SOURCE, path.resolve(destination));
}

module.exports = { prepareSettings };
