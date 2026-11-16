const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { probeUserJourney } = require("../factory/app-checks-probe.cjs");
const reports = require("../factory/app-checks-contract.cjs");
const { proofFromIncident, validateMonitorProof } = require("../factory/monitor-proof.cjs");
const APP = "https://haide-software-factory.onrender.com";
const cookie = "connect.sid=s%3Asynthetic.signature";
const identity = { id: "synthetic", username: "monitor" };
const page = { page: 1, limit: 5, totalPages: 1, hasNextPages: false };
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
function fixture(contract, releases = ["c".repeat(40), "c".repeat(40)]) {
  let loggedOut = false;
  let releaseIndex = 0;
  const calls = [];
  return {
    calls,
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      assert.equal(new URL(url).origin, APP);
      if (url.endsWith("/healthz"))
        return json({ status: "ok", release: releases[releaseIndex++] });
      if (url.endsWith("/login"))
        return json({ user: identity }, 200, { "set-cookie": cookie + "; Secure; HttpOnly" });
      if (url.endsWith("/checkAuth"))
        return loggedOut ? json({ error: "Unauthorized" }, 401) : json({ user: identity });
      if (url.endsWith("limit=5"))
        return json({ results: [{ id: "synthetic-record" }], pageData: page });
      if (url.endsWith("limit=0")) return typeof contract === "function" ? contract() : contract;
      if (url.endsWith("/logout")) {
        loggedOut = true;
        return new Response(null, { status: 302, headers: { location: "/" } });
      }
      throw Error("Unexpected route");
    },
  };
}
const probe = (f, extra = {}) =>
  probeUserJourney({
    username: "monitor",
    password: "synthetic-password",
    attempts: 1,
    ...f,
    ...extra,
  });
test("optional feed contract rejects the actual null page-count response and still logs out", async () => {
  const f = fixture(() =>
    json({ results: [], pageData: { page: 1, limit: 0, totalPages: null, hasNextPages: true } })
  );
  const r = await probe(f, { feedContract: true });
  assert.equal(r.healthy, false);
  assert.equal(r.checks.feed, "ok");
  assert.equal(r.feedContract, "failed");
  assert.equal(r.checks.logout, "ok");
  assert.equal(f.calls.length, 8);
  assert.ok(!JSON.stringify(r).includes(cookie));
});
test("contract accepts bounded documented JSON rejection or coherent positive normalization", async () => {
  for (const response of [
    () => json({ errors: [{ param: "limit", msg: "must be positive" }] }, 422),
    () => json({ error: "invalid page size" }, 400),
    () =>
      json({ results: [], pageData: { page: 1, limit: 10, totalPages: 0, hasNextPages: false } }),
    () =>
      json({
        results: [{ id: "record" }],
        pageData: { page: 1, limit: 10, totalPages: 1, hasNextPages: false },
      }),
  ]) {
    const r = await probe(fixture(response), { feedContract: true });
    assert.equal(r.healthy, true);
    assert.equal(r.feedContract, "ok");
  }
});
test("default-off adds no request; invalid modes refuse before credentials or network", async () => {
  const f = fixture(() => {
    throw Error("disabled request");
  });
  const r = await probe(f);
  assert.equal(r.healthy, true);
  assert.equal(r.feedContract, undefined);
  assert.equal(f.calls.length, 5);
  await assert.rejects(() => probe(f, { feedContract: "true" }), /bounds|mode|contract/i);
  assert.equal(f.calls.length, 5);
});
test("contract refuses authorization/provider errors, invalid bodies and inconsistent pagination", async () => {
  for (const response of [
    () => json({ error: "unauthorized" }, 401),
    () => json({ error: "forbidden" }, 403),
    () => json({ error: "unavailable" }, 503),
    () => json({}, 422),
    () =>
      new Response("<html>private</html>", {
        status: 400,
        headers: { "content-type": "text/html" },
      }),
    () =>
      json({ results: [], pageData: { page: 1, limit: 0, totalPages: 0, hasNextPages: false } }),
    () =>
      json({ results: [], pageData: { page: 1, limit: 51, totalPages: 0, hasNextPages: false } }),
    () =>
      json({
        results: [{ id: "x" }],
        pageData: { page: 1, limit: 5, totalPages: 2, hasNextPages: false },
      }),
    () => new Response(null, { status: 302, headers: { location: "https://attacker.invalid" } }),
    () => {
      throw Error("private remote data");
    },
  ]) {
    const r = await probe(fixture(response), { feedContract: true });
    assert.equal(r.healthy, false);
    assert.equal(r.feedContract, "failed");
    assert.equal(r.checks.logout, "ok");
    assert.ok(!JSON.stringify(r).includes("private"));
  }
});
test("contract mode is bound to version-two reports; legacy reports cannot substitute for it", () => {
  const context = {
    repository: "haideearus/cypress-realworld-app",
    runId: "900",
    runAttempt: 1,
    workflowSha: "a".repeat(40),
  };
  const at = "2026-11-16T00:00:00.000Z";
  const result = {
    healthy: true,
    checks: { login: "ok", session: "ok", feed: "ok", logout: "ok" },
    attempts: 1,
    feedContract: "ok",
    releases: { before: "c".repeat(40), after: "c".repeat(40) },
  };
  const report = reports.makeReport(result, context, at);
  assert.equal(report.version, 2);
  assert.deepEqual(reports.validateReport(report, context, at), result);
  assert.throws(() => reports.validateReport({ ...report, version: 1 }, context, at));
  const standard = structuredClone(result);
  delete standard.feedContract;
  delete standard.releases;
  assert.throws(() => reports.validateReport({ ...report, result: standard }, context, at));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-contract-"));
  const env = {
    RUNNER_TEMP: dir,
    GITHUB_RUN_ID: "900",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REPOSITORY: context.repository,
    GITHUB_WORKFLOW_SHA: context.workflowSha,
    FACTORY_FEED_CONTRACT_CHECK_ENABLED: "true",
  };
  try {
    reports.writeReport(env, report);
    assert.deepEqual(reports.readReport(env, context, at), result);
    assert.throws(() =>
      reports.readReport({ ...env, FACTORY_FEED_CONTRACT_CHECK_ENABLED: "false" }, context, at)
    );
    fs.writeFileSync(
      reports.reportPath(env),
      JSON.stringify(reports.makeReport(standard, context, at))
    );
    assert.throws(() => reports.readReport(env, context, at));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("immutable monitor proof binds feed-contract scope without changing legacy proofs", () => {
  const incident = {
    id: "12345678-1234-4123-8123-123456789012",
    issue: 64,
    criteriaHash: "a".repeat(64),
    source: { runId: "900", runAttempt: 1, workflowSha: "b".repeat(40) },
    probeMode: "feed-contract",
  };
  const proof = proofFromIncident(incident);
  assert.equal(proof.version, 2);
  assert.equal(proof.probeMode, "feed-contract");
  assert.equal(validateMonitorProof(proof), true);
  assert.equal(validateMonitorProof({ ...proof, probeMode: "standard" }), false);
  assert.equal(validateMonitorProof({ ...proof, version: 1 }), false);
  delete incident.probeMode;
  assert.equal(proofFromIncident(incident).version, 1);
});
test("contract incidents retain required scope when later standard probes appear healthy", async () => {
  const { monitor } = require("../factory/monitor.cjs");
  const { emptyMonitorState, validateMonitorState } = require("../factory/monitor-state.cjs");
  let state = emptyMonitorState(),
    commit = null,
    issue;
  const store = {
    read: async () => ({ state: structuredClone(state), commit }),
    save: async (next, parent) => {
      assert.equal(parent, commit);
      validateMonitorState(next);
      state = structuredClone(next);
      commit = "a".repeat(40);
      return commit;
    },
  };
  const api = {
    request: async (method, p, body) => {
      if (method === "POST" && p.endsWith("/issues")) {
        issue = {
          ...body,
          number: 64,
          state: "open",
          user: { login: "github-actions[bot]", type: "Bot" },
        };
        return issue;
      }
      if (method === "GET" && p.endsWith("/issues/64")) return issue;
      throw Error("No repair proof or other API request is allowed");
    },
  };
  const context = {
    repository: "haideearus/cypress-realworld-app",
    ref: "refs/heads/main",
    workflowRef:
      "haideearus/cypress-realworld-app/.github/workflows/factory-monitor.yml@refs/heads/main",
    workflowSha: "b".repeat(40),
    sha: "b".repeat(40),
    runId: "900",
    runAttempt: 1,
    eventName: "schedule",
    actor: "haideearus",
    triggeringActor: "haideearus",
  };
  const basic = {
    healthy: true,
    checks: { health: "ok", readiness: "ok", frontend: "ok" },
    attempts: 1,
    release: "c".repeat(40),
  };
  const standard = {
    healthy: true,
    checks: { login: "ok", session: "ok", feed: "ok", logout: "ok" },
    attempts: 1,
  };
  const args = { api, store, context, enabled: true, dryRun: false, probe: async () => basic };
  await monitor({
    ...args,
    appChecks: {
      ...standard,
      healthy: false,
      feedContract: "failed",
      releases: { before: "c".repeat(40), after: "c".repeat(40) },
    },
  });
  const id = state.active;
  assert.equal(state.incidents[id].probeMode, "feed-contract");
  assert.match(issue.body, /limit=0/);
  const r = await monitor({ ...args, appChecks: standard });
  assert.equal(r.outcome, "required_probe_missing");
  assert.equal(state.active, id);
  assert.equal(state.incidents[id].recovered, false);
});
test("release-bound contract journey retains setup/publication reserve inside the eight-minute bound", () => {
  const { phaseBudgets } = require("../factory/app-checks-budget.cjs");
  const b = phaseBudgets({ feedContract: true });
  assert.equal(b.journey, 206000);
  assert.ok(b.setup >= 26000);
  assert.ok(Object.values(b).reduce((a, n) => a + n, 0) <= 480000);
});
test("a rollout between release probes cannot produce a healthy contract journey", async () => {
  const f = fixture(
    () => json({ error: "invalid page size" }, 422),
    ["a".repeat(40), "b".repeat(40)]
  );
  const r = await probe(f, { feedContract: true });
  assert.equal(r.feedContract, "ok");
  assert.equal(r.healthy, false);
  assert.deepEqual(r.releases, { before: "a".repeat(40), after: "b".repeat(40) });
  assert.equal(r.checks.logout, "ok");
  assert.ok(f.calls.filter((c) => c.url.endsWith("/healthz")).every((c) => !c.opts.headers.Cookie));
});
