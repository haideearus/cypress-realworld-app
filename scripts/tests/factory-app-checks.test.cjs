const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const at = "2026-11-15T02:00:00.000Z";
const context = {
  repository: "haideearus/cypress-realworld-app",
  ref: "refs/heads/main",
  workflowRef:
    "haideearus/cypress-realworld-app/.github/workflows/factory-monitor.yml@refs/heads/main",
  workflowSha: "a".repeat(40),
  sha: "a".repeat(40),
  runId: "900",
  runAttempt: 1,
  eventName: "workflow_dispatch",
  actor: "haideearus",
  triggeringActor: "haideearus",
};
const healthy = {
  healthy: true,
  checks: { login: "ok", session: "ok", feed: "ok", logout: "ok" },
  attempts: 1,
};
function environment(directory) {
  return {
    RUNNER_TEMP: directory,
    FACTORY_APP_CHECKS_ENABLED: "true",
    FACTORY_MONITOR_USERNAME: "fixture-monitor",
    FACTORY_MONITOR_PASSWORD: "fixture-private-password",
    GITHUB_REPOSITORY: context.repository,
    GITHUB_REF: context.ref,
    GITHUB_WORKFLOW_REF: context.workflowRef,
    GITHUB_WORKFLOW_SHA: context.workflowSha,
    GITHUB_SHA: context.sha,
    GITHUB_RUN_ID: context.runId,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_EVENT_NAME: context.eventName,
    GITHUB_ACTOR: context.actor,
    GITHUB_TRIGGERING_ACTOR: context.triggeringActor,
  };
}
function temporary(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-app-report-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}
test("reports are enum-only, exact current-run/source records with bounded freshness", async () => {
  const { makeReport, validateReport } = require("../factory/app-checks-contract.cjs");
  const report = makeReport(healthy, context, at);
  assert.deepEqual(validateReport(report, context, at), healthy);
  for (const mutate of [
    (r) => (r.runId = "901"),
    (r) => r.runAttempt++,
    (r) => (r.repository = "other/repo"),
    (r) => (r.workflowSha = "b".repeat(40)),
    (r) => (r.at = "2026-11-15T01:49:59.999Z"),
    (r) => (r.at = "2026-11-15T02:00:05.001Z"),
    (r) => r.version++,
    (r) => (r.cookie = "private"),
    (r) => (r.result.message = "remote instruction"),
    (r) => (r.result.healthy = false),
    (r) => (r.result.checks.feed = "skipped"),
    (r) => (r.result.attempts = 4),
  ]) {
    const next = structuredClone(report);
    mutate(next);
    assert.throws(() => validateReport(next, context, at), /report|check/i);
  }
  assert.deepEqual(
    validateReport({ ...report, at: "2026-11-15T01:50:00.000Z" }, context, at),
    healthy
  );
});
test("report files are exclusive, bounded and cannot be symlinks or hardlinks", () =>
  temporary(async (dir) => {
    const c = require("../factory/app-checks-contract.cjs");
    const env = environment(dir),
      report = c.makeReport(healthy, context, at);
    c.writeReport(env, report);
    assert.deepEqual(c.readReport(env, context, at), healthy);
    assert.throws(() => c.writeReport(env, report));
    const file = c.reportPath(env);
    fs.writeFileSync(file, "x".repeat(8193));
    assert.throws(() => c.readReport(env, context, at), /report/i);
    fs.unlinkSync(file);
    const other = path.join(dir, "other.json");
    fs.writeFileSync(other, JSON.stringify(report));
    fs.linkSync(other, file);
    assert.throws(() => c.readReport(env, context, at), /report/i);
    fs.unlinkSync(file);
    try {
      fs.symlinkSync(other, file);
    } catch (e) {
      if (e.code === "EPERM") return;
      throw e;
    }
    assert.throws(() => c.readReport(env, context, at), /report/i);
  }));
test("report paths cannot be overridden or escape the trusted runner directory", () => {
  const { reportPath } = require("../factory/app-checks-contract.cjs");
  for (const change of [
    { RUNNER_TEMP: "relative" },
    { GITHUB_RUN_ID: "../outside" },
    { GITHUB_RUN_ATTEMPT: "2" },
  ])
    assert.throws(() => reportPath({ ...environment(os.tmpdir()), ...change }), /report/i);
});
test("disabled checker does not read credentials, probe or write a report", () =>
  temporary(async (dir) => {
    const { main } = require("../factory/app-checks.cjs");
    for (const flag of [undefined, "false", ""]) {
      const env = { ...environment(dir), FACTORY_APP_CHECKS_ENABLED: flag };
      Object.defineProperty(env, "FACTORY_MONITOR_PASSWORD", {
        get() {
          throw Error("credential read");
        },
      });
      const result = await main(env, {
        log: () => {},
        probe: () => {
          throw Error("probe invoked");
        },
      });
      assert.equal(result.outcome, "disabled");
      assert.deepEqual(fs.readdirSync(dir), []);
    }
  }));
test("enabled checker writes a current-run report but never prints credentials or response content", () =>
  temporary(async (dir) => {
    const { main } = require("../factory/app-checks.cjs");
    const { readReport } = require("../factory/app-checks-contract.cjs");
    const env = environment(dir),
      output = [];
    const result = await main(env, {
      now: () => at,
      log: (value) => output.push(value),
      probe: async (opts) => {
        assert.equal(opts.username, env.FACTORY_MONITOR_USERNAME);
        assert.equal(opts.password, env.FACTORY_MONITOR_PASSWORD);
        return healthy;
      },
    });
    assert.equal(result.outcome, "checked");
    assert.deepEqual(readReport(env, context, at), healthy);
    const stored = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8");
    for (const text of [stored, JSON.stringify(output), JSON.stringify(result)]) {
      assert.ok(!text.includes(env.FACTORY_MONITOR_USERNAME));
      assert.ok(!text.includes(env.FACTORY_MONITOR_PASSWORD));
    }
  }));
test("wrong context, missing credentials and unrelated privileges refuse before network or report writes", () =>
  temporary(async (dir) => {
    const { main } = require("../factory/app-checks.cjs");
    for (const change of [
      { FACTORY_APP_CHECKS_ENABLED: "yes" },
      { GITHUB_REF: "refs/heads/other" },
      { GITHUB_RUN_ATTEMPT: "2" },
      { FACTORY_MONITOR_PASSWORD: "" },
      { FACTORY_MONITOR_USERNAME: "" },
      { GITHUB_TOKEN: "fixture" },
      { GH_TOKEN: "fixture" },
      { CLAUDE_CODE_OAUTH_TOKEN: "fixture" },
      { ANTHROPIC_API_KEY: "fixture" },
      { FACTORY_GITHUB_APP_PRIVATE_KEY: "fixture" },
      { RENDER_DEPLOY_HOOK_URL: "fixture" },
    ]) {
      let called = false;
      await assert.rejects(
        () =>
          main(
            { ...environment(dir), ...change },
            {
              log: () => {},
              probe: () => {
                called = true;
              },
            }
          ),
        /configuration|failed/i
      );
      assert.equal(called, false);
      assert.deepEqual(fs.readdirSync(dir), []);
    }
  }));
test("exceptions and injected report fields are sanitized before output or publication", () =>
  temporary(async (dir) => {
    const { main } = require("../factory/app-checks.cjs");
    const env = environment(dir),
      output = [];
    for (const probe of [
      async () => {
        throw Error(env.FACTORY_MONITOR_PASSWORD);
      },
      async () => ({ ...healthy, message: env.FACTORY_MONITOR_PASSWORD }),
    ]) {
      await assert.rejects(
        () => main(env, { now: () => at, log: (value) => output.push(value), probe }),
        (error) => {
          assert.ok(!error.message.includes(env.FACTORY_MONITOR_PASSWORD));
          return true;
        }
      );
      assert.deepEqual(fs.readdirSync(dir), []);
    }
    assert.deepEqual(output, []);
  }));
test("publisher validates reports before network and never accepts account credentials", () =>
  temporary(async (dir) => {
    const { main } = require("../factory/monitor.cjs");
    const previousFetch = globalThis.fetch,
      previousExit = process.exitCode;
    let network = 0;
    globalThis.fetch = async () => {
      network++;
      throw Error("Network must not run");
    };
    try {
      const base = {
        ...environment(dir),
        GITHUB_TOKEN: "fixture-token",
        FACTORY_MONITOR_ENABLED: "true",
        MONITOR_DRY_RUN: "true",
      };
      delete base.FACTORY_MONITOR_USERNAME;
      delete base.FACTORY_MONITOR_PASSWORD;
      assert.equal((await main(base)).outcome, "monitor_failed", "enabled checks require a report");
      for (const key of ["FACTORY_MONITOR_USERNAME", "FACTORY_MONITOR_PASSWORD"])
        assert.equal(
          (await main({ ...base, FACTORY_APP_CHECKS_ENABLED: "false", [key]: "fixture-private" }))
            .outcome,
          "monitor_failed"
        );
      assert.equal(network, 0);
      assert.equal(
        (await main({ ...base, FACTORY_MONITOR_ENABLED: "false", MONITOR_DRY_RUN: "false" }))
          .outcome,
        "disabled"
      );
      assert.equal(network, 0);
    } finally {
      globalThis.fetch = previousFetch;
      process.exitCode = previousExit;
    }
  }));
test("publisher preview combines a validated same-run report with public availability checks", () =>
  temporary(async (dir) => {
    const { main } = require("../factory/monitor.cjs");
    const c = require("../factory/app-checks-contract.cjs");
    const env = {
      ...environment(dir),
      GITHUB_TOKEN: "fixture-token",
      FACTORY_MONITOR_ENABLED: "true",
      MONITOR_DRY_RUN: "true",
    };
    delete env.FACTORY_MONITOR_USERNAME;
    delete env.FACTORY_MONITOR_PASSWORD;
    const failed = { ...healthy, healthy: false, checks: { ...healthy.checks, feed: "failed" } };
    c.writeReport(env, c.makeReport(failed, context));
    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push(String(url));
      assert.equal(options.method, "GET");
      assert.ok(String(url).startsWith("https://haide-software-factory.onrender.com"));
      return url.endsWith("/healthz")
        ? new Response(JSON.stringify({ status: "ok", release: "b".repeat(40) }), {
            headers: { "content-type": "application/json" },
          })
        : url.endsWith("/readyz")
          ? new Response('{"status":"ok"}', { headers: { "content-type": "application/json" } })
          : new Response('<div id="root"></div>', { headers: { "content-type": "text/html" } });
    };
    try {
      const result = await main(env);
      assert.equal(result.outcome, "preview");
      assert.equal(result.observation.healthy, false);
      assert.deepEqual(result.observation.appChecks, failed);
      assert.equal(calls.length, 3);
    } finally {
      globalThis.fetch = previousFetch;
    }
  }));
