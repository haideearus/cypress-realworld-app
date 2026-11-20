const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ASSERTIONS } = require("../factory/functional-discovery-contract.cjs");

const checks = Object.keys(ASSERTIONS);

function report(failures = {}) {
  const tests = checks.map((check) => {
    const error = failures[check];
    const state = error ? "failed" : "passed";
    return {
      title: ["functional discovery", check],
      state,
      displayError: error
        ? `${error.name}: ${error.message}\n    at Context.eval (fixture.js)`
        : null,
      attempts: [{ state }],
    };
  });
  const count = Object.keys(failures).length;
  const stats = {
    tests: checks.length,
    passes: checks.length - count,
    failures: count,
    pending: 0,
    skipped: 0,
  };
  return {
    browserName: "electron",
    totalTests: stats.tests,
    totalPassed: stats.passes,
    totalFailed: count,
    totalPending: 0,
    totalSkipped: 0,
    runs: [
      {
        error: null,
        spec: { relative: "scripts/tests/factory-functional-discovery.cy.js" },
        stats,
        tests,
      },
    ],
  };
}

test("missing sign-in field labels can qualify as a verified browser assertion", async () => {
  const failure = report({ "sign-in-accessibility": assertion("sign-in-password-label") });
  assert.deepEqual(await verify(failure, failure), {
    status: "confirmed_failure",
    check: "sign-in-accessibility",
    assertion: "sign-in-password-label",
    passedChecks: checks.filter((id) => id !== "sign-in-accessibility"),
  });
});

test("inconclusive browser summary shows unconfirmed coverage with no pass claim", () => {
  const { browserSummary } = require("../factory/functional-browser.cjs");
  assert.equal(typeof browserSummary, "function", "browser checks need an Actions summary");
  const summary = browserSummary({ status: "inconclusive", check: "", assertion: "" });
  assert.match(summary, /none confirmed/i);
  assert.match(summary, /Browser sign-in/i);
  assert.match(summary, /sign-in field labels/i);
  assert.match(summary, /Skipped coverage[\s\S]*writes[\s\S]*production/i);
  assert.doesNotMatch(summary, /passed/i);
});

const inconclusive = { status: "inconclusive", check: "", assertion: "" };
const healthy = { status: "healthy", check: "", assertion: "" };

function assertion(id, detail = "expected a visible element") {
  return { name: "AssertionError", message: `Functional discovery [${id}]: ${detail}` };
}

async function verify(...reports) {
  const { inspectAttempt, verifyFunctionalChecks } = require("../factory/functional-browser.cjs");
  const verdict = await verifyFunctionalChecks(async () => {
    assert.notEqual(reports.length, 0, "too many browser invocations");
    return inspectAttempt(reports.shift());
  });
  assert.equal(reports.length, 0, "too few browser invocations");
  return verdict;
}

test("all passing checks produce a healthy verdict without a retry", async () => {
  assert.deepEqual(await verify(report()), healthy);
});

test("two invocations reporting the same typed assertion confirm its fixed check ID", async () => {
  assert.deepEqual(
    await verify(
      report({ "form-validation": assertion("settings-email-required") }),
      report({
        "form-validation": {
          name: "AssertionError",
          message:
            "Timed out retrying after 4000ms: Functional discovery [settings-email-required]: different rendered text",
        },
      })
    ),
    {
      status: "confirmed_failure",
      check: "form-validation",
      assertion: "settings-email-required",
      passedChecks: checks.filter((id) => id !== "form-validation"),
    }
  );
});

test("the onboarding classifier accepts its own repeated, named failure", async () => {
  const failure = report({ "bank-account-onboarding": assertion("onboarding-save-rejected") });
  assert.deepEqual(await verify(failure, failure), {
    status: "confirmed_failure",
    check: "bank-account-onboarding",
    assertion: "onboarding-save-rejected",
    passedChecks: checks.filter((id) => id !== "bank-account-onboarding"),
  });
});

test("multiple repeated failures select one assertion in catalog order", async () => {
  const first = report({
    settings: assertion("settings-profile"),
    "form-validation": assertion("settings-email-required"),
  });
  const second = report({
    settings: assertion("settings-profile"),
    "form-validation": assertion("settings-email-required"),
  });
  first.runs[0].tests.reverse();
  const result = await verify(first, second);
  assert.equal(result.status, "confirmed_failure");
  assert.equal(result.check, "settings");
  assert.equal(result.assertion, "settings-profile");

  const { browserSummary } = require("../factory/functional-browser.cjs");
  const summary = browserSummary(result);
  assert.match(summary, /Opening Settings — failed at `settings-profile`/);
  assert.match(summary, /Settings form validation — unconfirmed/);
  assert.match(summary, /Browser sign-in — passed/);
});

test("only unchanged assertion IDs are eligible when browser attempts disagree", async () => {
  const result = await verify(
    report({
      settings: assertion("settings-profile"),
      "form-validation": assertion("settings-email-invalid"),
    }),
    report({
      settings: assertion("settings-form"),
      "form-validation": assertion("settings-email-invalid"),
      "sign-in-accessibility": assertion("sign-in-password-label"),
    })
  );
  assert.equal(result.status, "confirmed_failure");
  assert.equal(result.check, "form-validation");
  assert.equal(result.assertion, "settings-email-invalid");

  const { browserSummary } = require("../factory/functional-browser.cjs");
  const summary = browserSummary(result);
  assert.match(summary, /Opening Settings — unconfirmed/);
  assert.match(summary, /Sign-in field labels — unconfirmed/);
});

test("a repeated assertion cannot be confirmed by a malformed or partial browser retry", async () => {
  const known = assertion("settings-email-required");
  const valid = report({ "form-validation": known });
  const partial = report({ "form-validation": known });
  partial.runs[0].tests.pop();

  assert.deepEqual(await verify(valid, partial), inconclusive);
  assert.deepEqual(
    await verify(valid, report({ "form-validation": known, settings: assertion("unknown-check") })),
    inconclusive
  );
});

test("a passing confirmation or two different assertions in the same check is inconclusive", async () => {
  const failure = report({ "form-validation": assertion("settings-email-required") });
  assert.deepEqual(await verify(failure, report()), inconclusive);
  assert.deepEqual(
    await verify(failure, report({ "form-validation": assertion("settings-email-invalid") })),
    inconclusive
  );
});

test("unrecognized, untyped, misplaced and mixed failures are inconclusive", async () => {
  const known = assertion("settings-email-required");
  for (const badReport of [
    report({ "form-validation": assertion("unrecognized") }),
    report({ "form-validation": { ...known, name: "TypeError" } }),
    report({ "form-validation": { ...known, message: `Application error: ${known.message}` } }),
    report({ settings: known }),
    report({ "form-validation": known, settings: assertion("unknown-check") }),
  ]) {
    assert.deepEqual(await verify(badReport), inconclusive);
  }
});

test("boot errors, partial results, skipped tests, and another spec cannot report health", async () => {
  const partial = report();
  partial.runs[0].tests.pop();
  const skipped = report();
  skipped.runs[0].tests[0].state = "skipped";
  const other = report();
  other.runs[0].spec.relative = "scripts/tests/production-browser.cy.js";
  const unexpected = report();
  unexpected.runs[0].tests[0].title[1] = "other-check";
  const browserError = report();
  browserError.runs[0].error = "browser crashed";
  const inconsistent = report();
  inconsistent.runs[0].stats.passes = 4;
  for (const badReport of [
    undefined,
    { status: "failed", failures: 1 },
    partial,
    skipped,
    other,
    unexpected,
    browserError,
    inconsistent,
  ]) {
    assert.deepEqual(await verify(badReport), inconclusive);
  }
});

test("only an explicit PostgreSQL loopback disposable database URL is accepted", () => {
  const { isDisposableDatabase } = require("../factory/functional-browser.cjs");
  assert.equal(isDisposableDatabase("postgresql://fixture:fixture@127.0.0.1:5432/rwa_test"), true);
  for (const uri of [
    undefined,
    "postgresql://fixture@database.example.com/rwa_test",
    "postgresql://fixture@127.0.0.1/rwa_prod",
    "https://127.0.0.1/rwa_test",
    "postgresql://fixture@127.0.0.1/rwa_test?host=production.example.com",
    "postgresql://fixture@127.0.0.1/rwa_test?database=rwa_prod",
  ]) {
    assert.equal(isDisposableDatabase(uri), false);
  }
});

test("ordinary worker patches cannot replace the checked-in browser spec", () => {
  const { validPath } = require("../factory/artifacts.cjs");
  assert.equal(validPath("scripts/tests/factory-functional-discovery.cy.js"), false);
});

test("the app and browser child environment excludes Actions file commands and credentials", () => {
  const { isolatedBrowserEnvironment } = require("../factory/functional-browser.cjs");
  assert.deepEqual(
    isolatedBrowserEnvironment({
      Path: "fixture-system-path",
      SYSTEMROOT: "fixture-system-root",
      HOME: "fixture-home",
      DISPLAY: ":1",
      GITHUB_OUTPUT: "runner-output",
      GITHUB_ENV: "runner-environment",
      GITHUB_STEP_SUMMARY: "runner-summary",
      GITHUB_PATH: "runner-path",
      GITHUB_STATE: "runner-state",
      GH_TOKEN: "fixture-token",
      DATABASE_URL: "fixture-database",
      TEST_DATABASE_URL: "disposable-database",
      CYPRESS_RUN_BINARY: "untrusted-binary",
      HTTP_PROXY: "fixture-proxy",
      NODE_OPTIONS: "--require arbitrary-module",
    }),
    {
      Path: "fixture-system-path",
      SYSTEMROOT: "fixture-system-root",
      HOME: "fixture-home",
      DISPLAY: ":1",
    }
  );
});
