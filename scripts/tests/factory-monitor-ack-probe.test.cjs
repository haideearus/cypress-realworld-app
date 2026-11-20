const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { fixture, at, sha } = require("./helpers/monitor-ack-fixture.cjs");
const file = path.join(__dirname, "../factory/monitor-ack-probe.cjs");
const checker = fs.existsSync(file) ? require(file) : {};
const contract = require("../factory/monitor-ack-contract.cjs");
const username = "synthetic-monitor",
  password = "fixture-password-not-a-real-secret";
function transport(change = () => undefined) {
  const calls = [];
  let loggedOut = false;
  const json = (data, status = 200, headers = {}) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  return {
    calls,
    fetch: async (url, o) => {
      const route = new URL(url).pathname + new URL(url).search;
      calls.push({ route, options: o });
      const replacement = change(route, o, calls.length);
      if (replacement !== undefined) return replacement;
      if (route === "/healthz") return json({ status: "ok", release: sha });
      if (route === "/api/login") {
        loggedOut = false;
        return json({ user: { id: "u", username } }, 200, {
          "set-cookie": "connect.sid=fixture; Secure; HttpOnly; SameSite=Lax",
        });
      }
      if (route === "/api/checkAuth")
        return loggedOut
          ? json({ error: "unauthorized" }, 401)
          : json({ user: { id: "u", username } });
      if (route === "/api/transactions/public?page=1&limit=5")
        return json({
          results: [{ id: "t" }],
          pageData: { page: 1, limit: 5, totalPages: 1, hasNextPages: false },
        });
      if (route === "/api/logout") {
        loggedOut = true;
        return new Response(null, { status: 302, headers: { location: "/" } });
      }
      throw Error("Unexpected probe route");
    },
  };
}
async function probe(t, extra = {}) {
  assert.equal(
    typeof checker.probeAckJourney,
    "function",
    "dedicated acknowledgment checker must exist"
  );
  return checker.probeAckJourney({
    username,
    password,
    fetch: t.fetch,
    sleep: async () => {},
    ...extra,
  });
}
test("fresh standard-only journey brackets checks with cookie-free release observations", async () => {
  const t = transport(),
    result = await probe(t);
  assert.equal(result.healthy, true);
  assert.deepEqual(result.releases, { before: sha, after: sha });
  assert.equal(t.calls.length, 7);
  assert.equal(t.calls[0].route, "/healthz");
  assert.equal(t.calls.at(-1).route, "/healthz");
  assert.ok(t.calls.filter((c) => c.route === "/healthz").every((c) => !c.options.headers.Cookie));
  assert.ok(!t.calls.some((c) => c.route.includes("limit=0")));
  assert.equal(result.feedContract, undefined);
  assert.ok(!JSON.stringify(result).includes(username));
  assert.ok(!JSON.stringify(result).includes(password));
});
test("blocked-repair mode runs the incident's pagination contract on the same stable release", async () => {
  const t = transport((route) =>
    route.endsWith("limit=0")
      ? new Response('{"error":"invalid limit"}', {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      : undefined
  );
  const outcome = await probe(t, { blockedRepair: true });
  assert.equal(outcome.healthy, true);
  assert.equal(outcome.feedContract, "ok");
  assert.equal(t.calls.filter(({ route }) => route.endsWith("limit=0")).length, 1);
  assert.equal(t.calls.length, 8);
  assert.deepEqual(outcome.releases, { before: sha, after: sha });
  const f = fixture();
  const r = contract.makeAckReport(outcome, f.context, at, true);
  assert.throws(() => contract.validateAckReport(r, f.context, at));
  assert.throws(() => contract.validateAckReport(f.report, f.context, at, true));
});
test("changing or unavailable releases and failed checks never produce healthy acknowledgment", async () => {
  for (const mutate of [
    (route, o, n) =>
      route === "/healthz" && n % 7 === 0
        ? new Response(JSON.stringify({ status: "ok", release: "b".repeat(40) }), {
            headers: { "content-type": "application/json" },
          })
        : undefined,
    (route) => (route === "/healthz" ? new Response("down", { status: 503 }) : undefined),
    (route) => (route === "/api/login" ? new Response("down", { status: 503 }) : undefined),
  ]) {
    const t = transport(mutate),
      r = await probe(t);
    assert.equal(r.healthy, false);
    assert.ok(r.attempts <= 3);
    assert.ok(t.calls.length <= 21);
  }
});
test("acknowledgment evidence cannot substitute for ordinary app reports", () => {
  const f = fixture();
  assert.throws(() =>
    require("../factory/app-checks-contract.cjs").validateReport(f.report, f.context, at)
  );
  const ordinary = { ...f.report };
  delete ordinary.kind;
  assert.throws(() => contract.validateAckReport(ordinary, f.context, at));
  for (const mutate of [
    (r) => (r.runAttempt = 2),
    (r) => (r.at = "2026-11-15T00:00:00.000Z"),
    (r) => (r.result.releases.after = null),
    (r) => (r.result.username = username),
  ]) {
    const r = structuredClone(f.report);
    mutate(r);
    assert.throws(() => contract.validateAckReport(r, f.context, at));
  }
});
test("bounded regular report round-trip rejects changed context and hardlinks", () => {
  const f = fixture(),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ack-report-"));
  const env = { RUNNER_TEMP: dir, GITHUB_RUN_ID: "900", GITHUB_RUN_ATTEMPT: "1" };
  try {
    contract.writeAckReport(env, f.report, f.context);
    assert.deepEqual(contract.readAckReport(env, f.context, at), f.report);
    assert.throws(() => contract.readAckReport(env, { ...f.context, runId: "901" }, at));
    const p = require("../factory/app-checks-contract.cjs").reportPath(env);
    fs.linkSync(p, path.join(dir, "linked"));
    assert.throws(() => contract.readAckReport(env, f.context, at));
  } finally {
    for (const p of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, p));
    fs.rmdirSync(dir);
  }
});
