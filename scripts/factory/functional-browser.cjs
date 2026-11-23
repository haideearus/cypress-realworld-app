const { randomUUID } = require("node:crypto");
const { fork } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const { origin, withProductionBrowser } = require("../test-production-browser.cjs");
const {
  ASSERTIONS,
  CHECKS,
  functionalChecks,
  validAssertion,
  validateFunctionalResult,
} = require("./functional-discovery-contract.cjs");

const spec = "scripts/tests/factory-functional-discovery.cy.js";
const suite = "functional discovery";
const inconclusive = { status: "inconclusive", check: "", assertion: "" };
const browserEnvironment = new Set([
  "APPDATA",
  "CI",
  "COMSPEC",
  "DISPLAY",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LANGUAGE",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
]);

function isolatedBrowserEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => browserEnvironment.has(name.toUpperCase()))
  );
}

function isDisposableDatabase(uri) {
  try {
    const url = new URL(uri);
    return (
      ["postgresql:", "postgres:"].includes(url.protocol) &&
      url.hostname === "127.0.0.1" &&
      /^\/[A-Za-z0-9_]+_test$/.test(url.pathname) &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

async function withFreshWeeklyDatabase(uri, run, Client = require("pg").Client) {
  if (!isDisposableDatabase(uri)) throw Error("Disposable loopback database required");
  const name = `factory_weekly_${randomUUID().replaceAll("-", "")}_test`;
  const database = new URL(uri);
  database.pathname = "/" + name;
  const client = new Client({
    connectionString: uri,
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
  });
  let created = false;
  try {
    await client.connect();
    await client.query(`CREATE DATABASE "${name}"`);
    created = true;
    return await run(database.href);
  } finally {
    try {
      if (created) await client.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    } finally {
      await client.end();
    }
  }
}

function inspectAttempt(report, extended = false) {
  const checks = functionalChecks(extended);
  if (
    !report ||
    report.status === "failed" ||
    report.browserName !== "electron" ||
    report.totalTests !== checks.length ||
    report.totalPending !== 0 ||
    report.totalSkipped !== 0 ||
    !Array.isArray(report.runs) ||
    report.runs.length !== 1
  ) {
    return;
  }

  const [run] = report.runs;
  if (
    run?.error !== null ||
    typeof run.spec?.relative !== "string" ||
    run.spec.relative.replaceAll("\\", "/") !== spec ||
    run.stats?.tests !== checks.length ||
    run.stats.pending !== 0 ||
    run.stats.skipped !== 0 ||
    !Array.isArray(run.tests) ||
    run.tests.length !== checks.length
  ) {
    return;
  }

  const failures = {};
  const seen = new Set();
  for (const test of run.tests) {
    if (!Array.isArray(test?.title) || test.title.length !== 2) return;
    const [group, check] = test.title;
    if (group !== suite || !checks.includes(check) || seen.has(check)) return;
    seen.add(check);

    if (!Array.isArray(test.attempts) || test.attempts.length !== 1) return;
    const [attempt] = test.attempts;
    if (attempt?.state !== test.state) return;
    if (test.state === "passed" && test.displayError === null) continue;
    if (test.state !== "failed" || typeof test.displayError !== "string") return;

    // The Cypress module API exposes the error type in displayError and the attempt's state separately.
    const assertion =
      /^AssertionError: (?:Timed out retrying after \d+ms: )?Functional discovery \[([a-z-]+)\]: /.exec(
        test.displayError
      )?.[1];
    if (!ASSERTIONS[check].includes(assertion)) return;
    failures[check] = assertion;
  }

  const failed = Object.keys(failures).length;
  const passed = checks.length - failed;
  if (
    report.totalFailed !== failed ||
    run.stats.failures !== failed ||
    report.totalPassed !== passed ||
    run.stats.passes !== passed
  ) {
    return;
  }
  return failed ? { status: "failed", failures } : { status: "healthy", check: "", assertion: "" };
}

async function verifyFunctionalChecks(run, extended = false, target) {
  const checks = functionalChecks(extended);
  if (target && (!checks.includes(target.check) || !validAssertion(target.check, target.assertion)))
    return inconclusive;
  const first = await run();
  if (first?.status === "healthy") return first;
  if (first?.status !== "failed" || !first.failures) return inconclusive;
  if (target && first.failures[target.check] !== target.assertion) return inconclusive;

  const second = await run();
  if (second?.status !== "failed" || !second.failures) return inconclusive;

  const check = (target ? [target.check] : checks).find(
    (id) => first.failures[id] && first.failures[id] === second.failures[id]
  );
  if (!check) return inconclusive;

  return {
    status: "confirmed_failure",
    check,
    assertion: first.failures[check],
    passedChecks: checks.filter((id) => !first.failures[id] && !second.failures[id]),
  };
}

function browserSummary({ status, check, assertion, passedChecks = [] }, extended = false) {
  const checks = functionalChecks(extended);
  validateFunctionalResult(status, check, assertion);
  const message = {
    healthy: "All approved browser checks passed.",
    confirmed_failure: "Two browser invocations confirmed the failure selected for publication.",
    inconclusive: "Coverage is inconclusive. None confirmed.",
  };
  return [
    extended ? "## Weekly full browser regression" : "## Safe functional discovery",
    "",
    message[status],
    "",
    "### Browser scenarios",
    "",
    ...checks.map((id) => {
      const result =
        id === check
          ? `failed at \`${assertion}\``
          : status === "healthy" || (status === "confirmed_failure" && passedChecks.includes(id))
            ? "passed"
            : "unconfirmed";
      return `- ${CHECKS[id]} — ${result}`;
    }),
    "",
    "### Skipped coverage",
    "",
    extended
      ? "- Writes outside the listed synthetic journeys, external services and production."
      : "- Writes outside the synthetic Settings and onboarding fixtures, the weekly journeys, external services and production.",
  ].join("\n");
}

async function runCypress() {
  const extended = process.argv[3] === "extended";
  const report = await require("cypress").run({
    browser: "electron",
    configFile: "scripts/cypress.production.config.cjs",
    spec,
    record: false,
    quiet: true,
    expose: { factoryFunctionalExtended: extended },
    env: { factoryAvatarFixtureOrigin: process.argv[4] || "" },
    config: {
      baseUrl: origin,
      specPattern: spec,
      supportFile: false,
      screenshotOnRunFailure: false,
      trashAssetsBeforeRuns: false,
      video: false,
      retries: 0,
      testIsolation: true,
    },
  });
  process.send(inspectAttempt(report, extended) || inconclusive);
}

function freshCypressRun(env, extended, avatarFixtureOrigin) {
  return new Promise((resolve) => {
    // The child sends only the classified result. All browser and backend logs stay out of CI output.
    const child = fork(
      __filename,
      ["--run-cypress", extended ? "extended" : "standard", avatarFixtureOrigin || ""],
      {
        env,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        timeout: extended ? 240000 : 120000,
      }
    );
    let result;
    child.once("message", (message) => {
      result = message;
    });
    child.once("error", () => resolve());
    child.once("close", (code) => resolve(code === 0 ? result : undefined));
  });
}

async function main() {
  const uri = process.env.TEST_DATABASE_URL;
  const extended = process.env.FACTORY_FUNCTIONAL_EXTENDED === "true";
  const expectedCheck = process.env.FACTORY_FUNCTIONAL_EXPECTED_CHECK;
  const expectedAssertion = process.env.FACTORY_FUNCTIONAL_EXPECTED_ASSERTION;
  const target =
    expectedCheck || expectedAssertion
      ? { check: expectedCheck, assertion: expectedAssertion }
      : undefined;
  let verdict = inconclusive;
  if (isDisposableDatabase(uri)) {
    const env = { ...isolatedBrowserEnvironment(process.env), CYPRESS_CRASH_REPORTS: "0" };
    try {
      verdict =
        extended || target
          ? await verifyFunctionalChecks(
              () =>
                withFreshWeeklyDatabase(uri, (testUri) =>
                  withProductionBrowser(
                    { uri: testUri, quiet: true, env, avatarFixture: extended },
                    ({ avatarFixtureOrigin }) => freshCypressRun(env, extended, avatarFixtureOrigin)
                  )
                ),
              extended,
              target
            )
          : await withProductionBrowser({ uri, quiet: true, env }, () =>
              verifyFunctionalChecks(() => freshCypressRun(env, false))
            );
    } catch {
      // Setup, crashes, and infrastructure failures are inconclusive.
    }
  }
  const { status, check, assertion } = verdict;
  const line = `Functional browser discovery result is ${status}${check ? ` for ${check}` : ""}.\n`;
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `status=${status}\ncheck=${check}\nassertion=${assertion}\npassedChecks=${JSON.stringify(verdict.passedChecks || [])}\n`
    );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, browserSummary(verdict, extended) + "\n");
  process.stdout.write(line);
  if (
    verdict.status === "inconclusive" &&
    process.env.FACTORY_FUNCTIONAL_REQUIRE_COMPLETE === "true"
  )
    process.exitCode = 1;
}

if (require.main === module) {
  const task = process.argv[2] === "--run-cypress" && process.send ? runCypress : main;
  void task().catch(() => {
    process.exitCode = 1;
  });
}

module.exports = {
  inspectAttempt,
  isDisposableDatabase,
  withFreshWeeklyDatabase,
  isolatedBrowserEnvironment,
  verifyFunctionalChecks,
  browserSummary,
};
