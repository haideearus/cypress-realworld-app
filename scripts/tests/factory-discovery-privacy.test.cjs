const test = require("node:test");
const assert = require("node:assert/strict");
const o = require("../factory/discovery-oracles.cjs");
const e = require("../factory/discovery-evidence.cjs");
const intake = require("../factory/discovery-intake.cjs");
const f = require("../factory/discovery-finding-contract.cjs");
const c = require("../factory/discovery-contract.cjs");
const fx = require("./helpers/finding-fixtures.cjs");

const contracts = [
  { kind: "bank-account-isolation", route: "/bankAccounts/:other" },
  { kind: "private-transaction-isolation", route: "/transactions/:private" },
].map((v) => ({ ...v, authenticated: true, query: {} }));
const seed = {
  users: ["owner", "receiver", "stranger"].map((id) => ({ id, username: id })),
  bankaccounts: [
    {
      id: "bank1",
      userId: "owner",
      bankName: "Synthetic Bank",
      accountNumber: "123456789",
      routingNumber: "987654321",
      isDeleted: false,
    },
  ],
  transactions: [
    { id: "public1", senderId: "owner", receiverId: "receiver", privacyLevel: "public" },
    {
      id: "private1",
      senderId: "owner",
      receiverId: "receiver",
      privacyLevel: "private",
      amount: 500,
      description: "Synthetic private record",
    },
  ],
};

// Explicit HTTP boundary substitute: the production probe still builds all URLs,
// identities, controls and observations itself. No external requests are made.
function transport(oracle, options = {}) {
  const calls = [];
  let revoked = false;
  const request = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", cookie: init.headers?.cookie });
    assert.equal(new URL(url).origin, "http://app:3001");
    assert.equal(init.redirect, "manual");
    const route = new URL(url).pathname;
    const reply = (body, status = 200, headers) =>
      new Response(JSON.stringify(body), { status, headers });
    if (route === "/login") {
      const user = seed.users.find((u) => u.username === JSON.parse(init.body).username);
      return reply({ user: { id: options.loginIdentity || user.id } }, options.loginStatus || 200, {
        ...(options.noCookie ? {} : { "set-cookie": `sid=${user.id}; HttpOnly` }),
      });
    }
    const id = init.headers?.cookie?.split("=")[1];
    assert.ok(seed.users.some((u) => u.id === id));
    if (route === "/checkAuth")
      return reply(
        { user: { id: options.sessionIdentity || id } },
        revoked ? 401 : options.sessionStatus || 200
      );
    const bank = oracle.kind === "bank-account-isolation";
    assert.equal(route, bank ? "/bankAccounts/bank1" : "/transactions/private1");
    const key = bank ? "account" : "transaction";
    const resource = bank ? seed.bankaccounts[0] : seed.transactions[1];
    const outsider = bank ? id !== "owner" : !["owner", "receiver"].includes(id);
    if (!outsider)
      return reply(
        {
          [key]: options.wrongControl
            ? { ...resource, id: "unrelated" }
            : options.redactControl
              ? {
                  id: resource.id,
                  userId: resource.userId,
                  senderId: resource.senderId,
                  receiverId: resource.receiverId,
                  privacyLevel: resource.privacyLevel,
                }
              : resource,
        },
        options.controlStatus || 200
      );
    const status = options.status || 200;
    revoked = options.logoutOnRead === true;
    if (options.raw !== undefined) return new Response(options.raw, { status });
    return reply(
      options.body ||
        (status === 200
          ? { [key]: options.wrongRecord ? { ...resource, id: "other" } : resource }
          : { error: "denied" }),
      status
    );
  };
  return { request, calls };
}
async function run(oracle, options = {}, fixture = seed) {
  const http = transport(oracle, options);
  const observation = await o.probe(oracle, { request: http.request, seed: fixture });
  return { observation, networkIsolated: true, calls: http.calls };
}
function bundleFor(oracle, results) {
  const b = fx.evidence();
  const row = b.findings[0];
  row.finding.oracle = structuredClone(oracle);
  row.oracle = structuredClone(oracle);
  row.replays = results.map(({ calls, ...value }) => value);
  row.fingerprint = c.digest([oracle.kind, oracle.route, results[0].observation.symptom]);
  return b;
}

for (const oracle of contracts) {
  test(`${oracle.kind}: exact catalog entry only; no model IDs, URLs or query expectations`, () => {
    assert.deepEqual(o.validateOracle(oracle), oracle);
    for (const patch of [
      { authenticated: false },
      { query: { page: 1 } },
      { query: { q: "owner" } },
      { route: "http://live.example/account" },
      { route: contracts.find((x) => x.kind !== oracle.kind).route },
      { recordId: "bank1" },
    ])
      assert.throws(() => o.validateOracle({ ...oracle, ...patch }), /Unsupported/);
  });

  test(`${oracle.kind}: confirms legitimate reads and distinct sessions before a stable disclosure`, async () => {
    const first = await run(oracle),
      second = await run(oracle);
    const expected =
      oracle.kind === "bank-account-isolation"
        ? "other-bank-account-access"
        : "private-transaction-access";
    assert.equal(first.observation.symptom, expected);
    assert.equal(first.observation.signature, second.observation.signature);
    const sessions = first.calls.filter((r) => r.url.endsWith("/checkAuth"));
    assert.equal(sessions.length, oracle.kind === "bank-account-isolation" ? 4 : 6);
    assert.equal(new Set(sessions.map((r) => r.cookie)).size, sessions.length / 2);
    assert.ok(first.calls.every((r) => r.method === "GET" || r.url.endsWith("/login")));
    const b = bundleFor(oracle, [first, second]);
    const candidate = f.candidateFromEvidence(b, 0, fx.artifact, fx.proof());
    assert.equal(
      intake.assessReplay(candidate, b.findings[0].proposedReplays, [first, second]),
      "ready"
    );
    const verified = await e.verifyReproducer({
      head: fx.head,
      grantId: fx.grant,
      finding: b.report.findings[0],
      baselinePassed: true,
      replay: async () => run(oracle),
    });
    assert.equal(verified.status, "verified");
    for (const status of [401, 403, 404]) {
      const green = [await run(oracle, { status }), await run(oracle, { status })];
      assert.equal(intake.healthy(green[0], oracle), true);
      assert.equal(
        intake.assessReplay(
          candidate,
          [
            { code: 0, networkIsolated: true },
            { code: 0, networkIsolated: true },
          ],
          green
        ),
        "observed-resolved"
      );
    }
  });

  test(`${oracle.kind}: broken setup, lost sessions and failed owner controls never prove a fix`, async () => {
    for (const options of [
      { loginStatus: 401 },
      { noCookie: true },
      { loginIdentity: "someone-else" },
      { sessionStatus: 401 },
      { sessionIdentity: "someone-else" },
      { controlStatus: 403 },
      { controlStatus: 500 },
      { wrongControl: true },
      { redactControl: true },
      { status: 401, logoutOnRead: true },
    ])
      await assert.rejects(() => run(oracle, options), /setup|control|identity|session|fixture/i);
    const noFixture = structuredClone(seed);
    if (oracle.kind === "bank-account-isolation") noFixture.bankaccounts[0].isDeleted = true;
    else noFixture.transactions[1].privacyLevel = "contacts";
    await assert.rejects(() => run(oracle, {}, noFixture), /fixture/i);
  });

  test(`${oracle.kind}: malformed success, outage and payload-bearing denial remain held`, async () => {
    for (const options of [
      { status: 500 },
      { status: 302 },
      { status: 200, wrongRecord: true },
      { status: 200, body: {} },
      {
        status: 403,
        body: {
          account: { accountNumber: "synthetic" },
          transaction: { description: "synthetic" },
        },
      },
      { status: 403, body: { ...seed.bankaccounts[0], ...seed.transactions[1] } },
      { status: 403, body: { data: seed.transactions[1], error: "Forbidden" } },
      { status: 401, body: { error: "Forbidden", accountNumber: "synthetic" } },
      { status: 404, body: { error: JSON.stringify(seed.transactions[1]) } },
      { status: 403, raw: "unexpected private record text" },
      { status: 404, body: [] },
      { status: 403, body: {} },
    ]) {
      const result = await run(oracle, options);
      assert.equal(e.observationMatches(result.observation, oracle), false);
      assert.equal(intake.healthy(result, oracle), false);
    }
    assert.throws(() => o.observe(oracle, 403, {}), /control|fixture|observation/i);
  });
}

test("historical null-oracle reports remain held instead of gaining fabricated proof", async () => {
  const b = fx.evidence();
  b.report.findings[0].oracle = null;
  b.findings[0].status = "held";
  let replays = 0;
  const result = await e.verifyReproducer({
    head: fx.head,
    grantId: fx.grant,
    finding: b.report.findings[0],
    baselinePassed: true,
    replay: async () => {
      replays++;
    },
  });
  assert.deepEqual(result, { status: "held", reason: "unsupported-oracle" });
  assert.equal(replays, 0);
  assert.throws(() => f.candidateFromEvidence(b, 0, fx.artifact, fx.proof()), /verified/);
});

test("privacy findings cannot share their proposal file; historical null-oracle reports still can", () => {
  const b = fx.evidence();
  b.report.findings[0].oracle = structuredClone(contracts[0]);
  b.report.findings.push({ ...b.report.findings[0], oracle: structuredClone(contracts[1]) });
  assert.throws(
    () => e.validateCandidateReport(b.report, { head: fx.head, grantId: fx.grant }),
    /separate|shared/i
  );
  b.report.findings.forEach((finding) => {
    finding.oracle = null;
  });
  assert.equal(
    e.validateCandidateReport(b.report, { head: fx.head, grantId: fx.grant }).findings.length,
    2
  );
});
