const test = require("node:test");
const assert = require("node:assert/strict");
const { runInNewContext } = require("node:vm");
const functional = require("../factory/discovery-functional.cjs");
const contract = require("../factory/discovery-contract.cjs");
const { probe } = require("../factory/discovery-oracles.cjs");
const { observationMatches, verifyReproducer } = require("../factory/discovery-evidence.cjs");
const { explorationSummary } = require("../factory/discovery-summary.cjs");
const { selectSweep } = require("../factory/discovery-run.cjs");
const { candidateFromEvidence } = require("../factory/discovery-finding-contract.cjs");
const { assessReplay } = require("../factory/discovery-intake.cjs");
const fixtures = require("./helpers/finding-fixtures.cjs");

const charter = "functional-notifications";
const oracle = (check) => ({
  kind: "notification-list",
  route: "/notifications",
  authenticated: true,
  query: { check },
});
const head = "a".repeat(40);
const seed = {
  users: [{ username: "synthetic-one", id: "synthetic-owner" }],
  notifications: [
    { id: "synthetic-unread", userId: "synthetic-owner", isRead: false },
    { id: "synthetic-read", userId: "synthetic-owner", isRead: true },
  ],
};
const syntheticSession = { user: { id: seed.users[0].id } };
const good = {
  id: "synthetic-unread",
  isRead: false,
  userFullName: "Synthetic User",
  transactionId: "synthetic-transaction",
  likeId: "synthetic-like",
};

test("the notification proposal only tests fixed cases against the synthetic read-only endpoint", () => {
  const input = oracle("unread");
  const source = functional.proposal(charter, input);
  assert.deepEqual(functional.verifyProposal(charter, source), input);
  assert.match(source, /new URL\(scenario.route, base\)/);
  assert.doesNotMatch(source, /url.search|URLSearchParams/);
  assert.throws(() => functional.verifyProposal(charter, source + "\n"), /changed/);
  for (const input of [
    oracle("arbitrary"),
    { ...oracle("unread"), query: { check: "unread", q: "a" } },
    { ...oracle("unread"), authenticated: false },
    { ...oracle("unread"), route: "/users/search" },
  ])
    assert.throws(() => functional.proposal(charter, input));
  assert.throws(() => functional.proposal("functional-directory", input));
  const finding = functional.describeFinding(charter, {
    test: "read.api.test.cjs",
    mode: "api",
    oracle: input,
  });
  const candidate = {
    ...finding,
    file: finding.test,
    source: { charter },
    testHash: contract.digest(source),
  };
  assert.equal(functional.eligibleCandidate(candidate), true);
  assert.equal(functional.eligibleCandidate({ ...candidate, testHash: "a".repeat(64) }), false);
});

test("the generated proposal executes a fixed read and detects the same ordinary regressions", async () => {
  const execute = async (check, body, session = syntheticSession) => {
    const calls = [];
    let run;
    runInNewContext(functional.proposal(charter, oracle(check)), {
      require(name) {
        if (name === "node:test")
          return (name, callback) => {
            run = callback;
          };
        if (name === "node:assert/strict") return assert;
        if (name === "../data/database-seed.json") return seed;
        assert.fail("unapproved generated import");
      },
      fetch(target, init) {
        const url = new URL(target);
        calls.push([url.href, init.method ?? "GET"]);
        if (url.pathname === "/login")
          return Response.json(session, { headers: { "set-cookie": "session=synthetic" } });
        return Response.json(body);
      },
      URL,
      AbortSignal,
    });
    try {
      await run();
    } finally {
      assert.deepEqual(calls, [
        ["http://127.0.0.1:3001/login", "POST"],
        ...(session.user?.id === seed.users[0].id
          ? [["http://127.0.0.1:3001/notifications", "GET"]]
          : []),
      ]);
    }
  };
  for (const check of ["envelope", "unread", "items"]) await execute(check, { results: [good] });
  for (const unexpected of [{}, { user: { id: "unexpected-user" } }])
    await assert.rejects(execute("envelope", { results: [good] }, unexpected), /session identity/);
  await assert.rejects(execute("envelope", { results: null }), /results list/);
  await assert.rejects(execute("unread", { results: [] }), /all seeded unread items/);
  await assert.rejects(
    execute("items", { results: [{ ...good, userFullName: "" }] }),
    /fields used by the UI/
  );
});

async function simulate(check, data, status = 200) {
  const calls = [];
  const observation = await probe(oracle(check), {
    seed,
    request: async (input, init) => {
      const url = new URL(input);
      calls.push([url.origin, url.pathname, url.search, init.method ?? "GET"]);
      if (url.pathname === "/login")
        return Response.json(syntheticSession, { headers: { "set-cookie": "session=synthetic" } });
      assert.equal(init.headers.cookie, "session=synthetic");
      return Response.json(data, { status });
    },
  });
  assert.deepEqual(calls, [
    ["http://app:3001", "/login", "", "POST"],
    ["http://app:3001", "/notifications", "", "GET"],
  ]);
  return observation;
}

test("trusted replay never reads notifications without identifying the synthetic login", async () => {
  for (const payload of [{}, { user: { id: "unexpected-user" } }]) {
    const calls = [];
    await assert.rejects(
      probe(oracle("envelope"), {
        seed,
        request: async (input) => {
          calls.push(new URL(input).pathname);
          return Response.json(payload, { headers: { "set-cookie": "session=synthetic" } });
        },
      }),
      /session identity/
    );
    assert.deepEqual(calls, ["/login"]);
  }
});

test("trusted replay checks envelope, known unread rows, and item types without reporting raw rows", async () => {
  for (const check of ["envelope", "unread", "items"]) {
    const healthy = await simulate(check, { results: [good] });
    assert.equal(healthy.symptom, "none");
    assert.doesNotMatch(healthy.response, /Synthetic User|synthetic-unread/);
  }
  const broken = await simulate("envelope", { items: [] });
  assert.equal(broken.symptom, "notifications-envelope");
  assert.equal((await simulate("unread", { results: [] })).symptom, "notifications-unread");
  assert.equal(
    (await simulate("unread", { results: [{ ...good, isRead: true }] })).symptom,
    "notifications-unread"
  );
  const badItem = { ...good, likeId: undefined, status: "incorrect-status" };
  const wrongType = await simulate("items", { results: [badItem] });
  assert.equal(wrongType.symptom, "notifications-items");
  assert.equal((await simulate("items", { results: [good, good] })).symptom, "notifications-items");
  assert.equal((await simulate("envelope", {}, 500)).symptom, "server-error");
  assert.equal(observationMatches({ ...wrongType, response: "{}" }, oracle("items")), false);
  assert.equal(observationMatches(wrongType, oracle("unread")), false);
  const inputs = [];
  const verified = await verifyReproducer({
    head,
    grantId: "test-grant",
    baselinePassed: true,
    finding: { oracle: oracle("items") },
    replay: async (replayOracle) => {
      inputs.push(replayOracle);
      return {
        networkIsolated: true,
        observation: await simulate(replayOracle.query.check, { results: [badItem] }),
      };
    },
  });
  assert.equal(verified.status, "verified");
  assert.deepEqual(inputs, [oracle("items"), oracle("items")]);
});

test("matching notification proof remains eligible for current-main repair intake", async () => {
  const bundle = fixtures.evidence("unexpected-server-error", "/notifications");
  const [row] = bundle.findings;
  const input = oracle("unread");
  const finding = functional.describeFinding(charter, { ...row.finding, oracle: input });
  const proposal = functional.proposal(charter, input);
  const failed = await simulate("unread", { results: [] });
  Object.assign(row, {
    finding,
    oracle: input,
    fingerprint: contract.digest([input.kind, input.route, failed.symptom]),
  });
  Object.assign(row.original, { test: proposal, testHash: contract.digest(proposal) });
  row.replays.forEach((replay) => (replay.observation = failed));
  bundle.report.findings = [finding];
  functional.verifyFindings(charter, bundle.report, [row.original]);
  const candidate = candidateFromEvidence(
    bundle,
    0,
    fixtures.artifact,
    fixtures.proof(fixtures.grant, charter)
  );
  assert.equal(functional.eligibleCandidate(candidate), true);
  assert.equal(assessReplay(candidate, row.proposedReplays, row.replays), "ready");
  const healthy = await simulate("unread", { results: [good] });
  const passed = row.proposedReplays.map((r) => ({ ...r, code: 0 }));
  const passingObservations = row.replays.map((r) => ({ ...r, observation: healthy }));
  assert.equal(assessReplay(candidate, passed, passingObservations), "observed-resolved");
});

test("coverage reports the three specific notification checks and both skipped charters", () => {
  const summary = (checks) =>
    explorationSummary({
      charter,
      bundle: {
        batches: checks.map((check) => ({
          test: functional.proposal(charter, oracle(check)),
          result: { code: 0, networkIsolated: true },
        })),
      },
      assessment: { findings: [] },
    });
  assert.match(summary(["unread", "unread", "items"]), /2 distinct cases.*partial/i);
  const complete = summary(["envelope", "unread", "items"]);
  assert.match(complete, /3 distinct cases.*target met/i);
  assert.match(complete, /Notifications.*envelope/i);
  assert.match(complete, /Notifications.*unread/i);
  assert.match(complete, /Notifications.*item/i);
  assert.match(complete, /Skipped coverage[\s\S]*public feed pagination[\s\S]*directory search/i);
});

test("failed notification setup cannot inflate coverage", () => {
  const render = (log) =>
    explorationSummary({
      charter,
      bundle: {
        batches: [
          {
            test: functional.proposal(charter, oracle("envelope")),
            result: {
              code: 1,
              networkIsolated: true,
              log,
              logHash: contract.digest(log),
              exitState: { status: "exited", exitCode: 1, oomKilled: false },
            },
          },
        ],
      },
      assessment: { findings: [] },
    });
  const failed = "not ok 1 - approved functional scenario";
  assert.match(render(failed + "\n  error: synthetic sign-in"), /0 distinct cases.*partial/i);
  assert.match(
    render(`# ${functional.NOTIFICATION_RESPONSE}\n${failed}`),
    /1 distinct case.*partial/i
  );
});

test("daily rotation gives skipped charters a turn and never repeats the same day's charter", () => {
  const input = {
    state: {
      version: 2,
      days: {},
      grants: {
        prior: { phase: "discover", ticket: 12, at: "2026-11-18T14:00:00Z" },
        settings: { phase: "discover", ticket: 14, at: "2026-11-18T10:00:00Z" },
        today: { phase: "discover", ticket: 13, at: "2026-11-19T12:00:00Z" },
      },
      tickets: {
        12: { discovery: { charter: "functional-directory" } },
        13: { discovery: { charter: "functional-feed" } },
        14: { discovery: { charter: "functional-settings" } },
      },
      activeTickets: {},
    },
    registry: { sources: {} },
    head,
    day: "2026-11-19",
    config: { enabled: true, discovery: true, daily: 20, timezone: "Europe/Bucharest" },
  };
  assert.deepEqual(selectSweep(input), { ready: true, charter });
  const unavailable = {
    ...input,
    registry: {
      sources: Object.fromEntries(
        ["functional-directory", "functional-settings", charter].map((id) => [
          contract.sweepKey(head, id, input.day),
          { status: "created" },
        ])
      ),
    },
  };
  assert.equal(selectSweep(unavailable).ready, false);
});
