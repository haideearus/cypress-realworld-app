const { fork } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const { origin, withProductionBrowser } = require("../test-production-browser.cjs");
const {
  ASSERTIONS,
  CHECKS,
  validateFunctionalResult,
} = require("./functional-discovery-contract.cjs");

const spec = "scripts/tests/factory-functional-discovery.cy.js";
const suite = "functional discovery";
const checks = Object.keys(ASSERTIONS);
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

function inspectAttempt(report) {
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

  let failure;
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
    if (failure || test.state !== "failed" || typeof test.displayError !== "string") return;

    // The Cypress module API exposes the error type in displayError and the attempt's state separately.
    const assertion =
      /^AssertionError: (?:Timed out retrying after \d+ms: )?Functional discovery \[([a-z-]+)\]: /.exec(
        test.displayError
      )?.[1];
    if (!ASSERTIONS[check].includes(assertion)) return;
    failure = { status: "failed", check, assertion };
  }

  const failed = failure ? 1 : 0;
  const passed = checks.length - failed;
  if (
    report.totalFailed !== failed ||
    run.stats.failures !== failed ||
    report.totalPassed !== passed ||
    run.stats.passes !== passed
  ) {
    return;
  }
  return failure || { status: "healthy", check: "", assertion: "" };
}

async function verifyFunctionalChecks(run) {
  const first = await run();
  if (first?.status === "healthy") return first;
  if (first?.status !== "failed") return inconclusive;

  const second = await run();
  if (
    second?.status === "failed" &&
    first.check === second.check &&
    first.assertion === second.assertion
  ) {
    return { status: "confirmed_failure", check: first.check, assertion: first.assertion };
  }
  return inconclusive;
}

function browserSummary({ status, check, assertion }) {
  validateFunctionalResult(status, check, assertion);
  const message = {
    healthy: "All approved browser checks passed.",
    confirmed_failure: "Two browser invocations confirmed the same failure.",
    inconclusive: "Coverage is inconclusive. None confirmed.",
  };
  return [
    "## Safe functional discovery",
    "",
    message[status],
    "",
    "### Browser scenarios",
    "",
    ...checks.map((id) => {
      const result =
        status === "inconclusive"
          ? "unconfirmed"
          : id === check
            ? `failed at \`${assertion}\``
            : "passed";
      return `- ${CHECKS[id]} — ${result}`;
    }),
    "",
    "### Skipped coverage",
    "",
    "- Account-changing writes, other browser journeys, external services and production.",
  ].join("\n");
}

async function runCypress() {
  const report = await require("cypress").run({
    browser: "electron",
    configFile: "scripts/cypress.production.config.cjs",
    spec,
    record: false,
    quiet: true,
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
  process.send(inspectAttempt(report) || inconclusive);
}

function freshCypressRun(env) {
  return new Promise((resolve) => {
    // The child sends only the classified result. All browser and backend logs stay out of CI output.
    const child = fork(__filename, ["--run-cypress"], {
      env,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      timeout: 120000,
    });
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
  let verdict = inconclusive;
  if (isDisposableDatabase(uri)) {
    const env = isolatedBrowserEnvironment(process.env);
    try {
      verdict = await withProductionBrowser({ uri, quiet: true, env }, () =>
        verifyFunctionalChecks(() => freshCypressRun(env))
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
      `status=${status}\ncheck=${check}\nassertion=${assertion}\n`
    );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, browserSummary(verdict) + "\n");
  process.stdout.write(line);
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
  isolatedBrowserEnvironment,
  verifyFunctionalChecks,
  browserSummary,
};
