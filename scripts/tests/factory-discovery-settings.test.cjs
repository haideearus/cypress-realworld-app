const test = require("node:test");
const assert = require("node:assert/strict");
const { runInNewContext } = require("node:vm");
const functional = require("../factory/discovery-functional.cjs");
const { digest } = require("../factory/discovery-contract.cjs");
const { probe } = require("../factory/discovery-oracles.cjs");
const { observationMatches, verifyReproducer } = require("../factory/discovery-evidence.cjs");
const { explorationSummary } = require("../factory/discovery-summary.cjs");
const { candidateFromEvidence } = require("../factory/discovery-finding-contract.cjs");
const { assessReplay } = require("../factory/discovery-intake.cjs");
const fixtures = require("./helpers/finding-fixtures.cjs");

const charter = "functional-settings";
const oracle = (check) => ({
  kind: "settings-profile",
  route: "/checkAuth",
  authenticated: true,
  query: { check },
});
const user = {
  id: "settings-synthetic-user",
  username: "synthetic-settings",
  firstName: "Synthetic",
  lastName: "Settings",
  email: "settings-factory@example.test",
  phoneNumber: "1234567890",
  defaultPrivacyLevel: "contacts",
};
const seed = { users: [user] };
const auth = { user: { id: user.id } };
const requestLog = (calls, input, init) => {
  const url = new URL(input);
  calls.push({
    path: url.pathname,
    origin: url.origin,
    query: url.search,
    method: init?.method ?? "GET",
    cookie: init?.headers?.cookie,
  });
};
const expectedLogin = (origin) => ({
  origin,
  path: "/login",
  query: "",
  method: "POST",
  cookie: undefined,
});
const expectedRead = (origin) => ({
  origin,
  path: "/checkAuth",
  query: "",
  method: "GET",
  cookie: "session=synthetic",
});

function execute(check, body, session = auth) {
  const calls = [];
  let run;
  runInNewContext(functional.proposal(charter, oracle(check)), {
    require(name) {
      if (name === "node:test")
        return (_, callback) => {
          run = callback;
        };
      if (name === "node:assert/strict") return assert;
      if (name === "../data/database-seed.json") return seed;
      assert.fail("unapproved generated import");
    },
    fetch(input, init) {
      requestLog(calls, input, init);
      return new URL(input).pathname === "/login"
        ? Response.json(session, { headers: { "set-cookie": "session=synthetic" } })
        : Response.json(body);
    },
    URL,
    AbortSignal,
    console: { log() {} },
  });
  return { run, calls };
}

test("the Settings proposal rejects unapproved paths, scenarios, and inputs", () => {
  const normal = oracle("details");
  const source = functional.proposal(charter, normal);
  assert.deepEqual(functional.verifyProposal(charter, source), normal);
  assert.throws(() => functional.verifyProposal(charter, source + "\n"), /changed/);
  for (const value of [
    oracle("unknown"),
    { ...normal, authenticated: false },
    { ...normal, route: "/notifications" },
    { ...normal, query: { check: "details", id: "other-user" } },
    { ...normal, kind: "unexpected-server-error", query: {} },
  ])
    assert.throws(() => functional.proposal(charter, value));
  assert.throws(() => functional.proposal("functional-notifications", normal));
});

test("generated Settings scenarios rehydrate one known user over a single fixed GET", async () => {
  const local = "http://127.0.0.1:3001";
  for (const check of ["identity", "details", "preference"]) {
    const { run, calls } = execute(check, { user });
    await run();
    assert.deepEqual(calls, [expectedLogin(local), expectedRead(local)]);
  }
  const incorrectLogin = execute("identity", { user }, { user: { id: "different-fixture" } });
  await assert.rejects(incorrectLogin.run(), /session identity/);
  assert.deepEqual(incorrectLogin.calls, [expectedLogin(local)]);
  await assert.rejects(
    execute("details", { user: { ...user, firstName: "" } }).run(),
    /Settings form/
  );
  await assert.rejects(
    execute("preference", { user: { ...user, defaultPrivacyLevel: "public" } }).run(),
    /saved default/
  );
});

async function replay(input, body, { status = 200, login = auth, calls = [] } = {}) {
  return probe(input, {
    seed,
    request: async (target, init) => {
      requestLog(calls, target, init);
      return new URL(target).pathname === "/login"
        ? Response.json(login, { headers: { "set-cookie": "session=synthetic" } })
        : status === 204
          ? new Response(null, { status })
          : Response.json(body, { status });
    },
  });
}

test("trusted Settings replay preserves isolated fixture evidence without retaining profile fields", async () => {
  const local = "http://app:3001";
  const calls = [];
  const setupFailure = replay(oracle("identity"), { user }, { login: {}, calls });
  await assert.rejects(setupFailure, /session identity/);
  assert.deepEqual(calls, [expectedLogin(local)]);
  for (const [check, response, status, symptom] of [
    ["identity", { user }, 200, "none"],
    ["identity", {}, 401, "settings-session"],
    ["identity", { user }, 201, "settings-session"],
    ["identity", null, 204, "settings-session"],
    ["identity", {}, 302, "none"],
    ["identity", { user: { ...user, username: "wrong" } }, 200, "settings-identity"],
    ["details", { user: { ...user, email: null } }, 200, "settings-details"],
    [
      "preference",
      { user: { ...user, defaultPrivacyLevel: "private" } },
      200,
      "settings-preference",
    ],
  ]) {
    const calls = [];
    const observed = await replay(oracle(check), response, { status, calls });
    assert.equal(observed.symptom, symptom);
    assert.deepEqual(calls, [expectedLogin(local), expectedRead(local)]);
    const projected = JSON.parse(observed.response);
    assert.equal(
      Object.values(projected).every((value) => typeof value === "boolean"),
      true
    );
    assert.doesNotMatch(observed.response, /settings-factory|1234567890|Synthetic Settings/);
    assert.equal(observationMatches({ ...observed, response: "{}" }, oracle(check)), false);
  }
});

test("the Settings finding waits for repeated matching proof and remains eligible for intake", async () => {
  const input = oracle("details");
  const bundle = fixtures.evidence("unexpected-server-error", "/users/search");
  const [row] = bundle.findings;
  const finding = functional.describeFinding(charter, { ...row.finding, oracle: input });
  const proposal = functional.proposal(charter, input);
  const failed = {
    networkIsolated: true,
    observation: await replay(input, { user: { ...user, email: null } }),
  };
  const healthy = { networkIsolated: true, observation: await replay(input, { user }) };
  const checkProof = (results) =>
    verifyReproducer({
      head: bundle.head,
      grantId: bundle.grantId,
      baselinePassed: true,
      finding,
      replay: async () => results.shift(),
    });
  assert.equal((await checkProof([failed, healthy])).status, "held");
  const verification = await checkProof([failed, failed]);
  assert.equal(verification.status, "verified");
  Object.assign(row, { finding, oracle: input, fingerprint: verification.fingerprint });
  Object.assign(row.original, { test: proposal, testHash: digest(proposal) });
  row.replays.forEach((result) => (result.observation = failed.observation));
  bundle.report.findings = [finding];
  const candidate = candidateFromEvidence(
    bundle,
    0,
    fixtures.artifact,
    fixtures.proof(fixtures.grant, charter)
  );
  assert.equal(functional.eligibleCandidate(candidate), true);
  assert.equal(assessReplay(candidate, row.proposedReplays, row.replays), "ready");
  assert.equal(
    assessReplay(
      candidate,
      row.proposedReplays.map((item) => ({ ...item, code: 0 })),
      [healthy, healthy]
    ),
    "observed-resolved"
  );
});

test("Settings coverage counts completed endpoint checks and excludes failed sign-in", () => {
  const result = (log) => ({
    code: 1,
    networkIsolated: true,
    log,
    logHash: digest(log),
    exitState: { status: "exited", exitCode: 1, oomKilled: false },
  });
  const summary = explorationSummary({
    charter,
    bundle: {
      batches: [
        {
          test: functional.proposal(charter, oracle("identity")),
          result: result("not ok 1 - approved functional scenario"),
        },
        {
          test: functional.proposal(charter, oracle("details")),
          result: result(
            "# Settings profile endpoint responded\nnot ok 1 - approved functional scenario"
          ),
        },
        {
          test: functional.proposal(charter, oracle("preference")),
          result: { code: 0, networkIsolated: true },
        },
      ],
    },
    assessment: { findings: [] },
  });
  assert.match(summary, /2 distinct cases.*partial/i);
  assert.match(summary, /Settings profile.*form fields/i);
  assert.match(summary, /Settings profile.*saved default/i);
  assert.match(summary, /Skipped coverage[\s\S]*Notifications list/i);
});

test("a Settings finding must come from a batch that reached the profile endpoint", () => {
  const input = oracle("details");
  const finding = functional.describeFinding(charter, {
    mode: "api",
    test: "settings.api.test.cjs",
    oracle: input,
  });
  const report = { findings: [finding] };
  const batch = {
    mode: "api",
    file: finding.test,
    number: 1,
    test: functional.proposal(charter, input),
    result: { code: 1, log: "not ok 1 - approved functional scenario" },
  };
  assert.throws(() => functional.verifyFindings(charter, report, [batch]), /executed failing/);
  batch.result.log = "# Settings profile endpoint responded\r\n" + batch.result.log;
  assert.doesNotThrow(() => functional.verifyFindings(charter, report, [batch]));
});
