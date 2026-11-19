const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBroker } = require("../factory/discovery-broker.cjs");
const { selectSweep } = require("../factory/discovery-run.cjs");
const intake = require("../factory/discovery-intake.cjs");
const { emptyFindings } = require("../factory/discovery-finding-contract.cjs");
const functional = require("../factory/discovery-functional.cjs");
const { digest } = require("../factory/discovery-contract.cjs");
const findings = require("../factory/discovery-finding-contract.cjs");
const publication = require("../factory/discovery-publication.cjs");
const fx = require("./helpers/finding-fixtures.cjs");

test("new discovery selects only functional charters", () => {
  const chosen = selectSweep({
    state: { version: 2, days: {}, grants: {}, tickets: {}, activeTickets: {} },
    registry: { sources: {} },
    head: "a".repeat(40),
    day: "2026-11-19",
    config: { enabled: true, discovery: true, daily: 20, timezone: "Europe/Bucharest" },
  });
  assert.ok(["functional-feed", "functional-directory"].includes(chosen.charter));
});

test("the discovery broker rejects model-supplied executable text", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "functional-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const broker = createBroker({
    root,
    source: root,
    output: path.join(root, "output"),
    manifest: {},
    identity: { head: "a".repeat(40), grantId: "test" },
    charter: "functional-feed",
    execute: async () => assert.fail("no unapproved test may run"),
  });
  await assert.rejects(
    broker.call("write_test", { file: "probe.api.test.cjs", content: "// arbitrary source" })
  );
});

test("normal intake leaves older nonfunctional candidates in history", () => {
  const legacy = {
    status: "published",
    publication: { issue: 97 },
    candidate: { key: "old", source: { grantId: "legacy", charter: "journeys" } },
  };
  const registry = { ...emptyFindings(), records: { old: legacy } };
  assert.equal(
    intake.pendingReplay(registry, { tickets: {} }, { day: "2026-11-19", head: "a".repeat(40) }),
    null
  );
  assert.equal(registry.records.old, legacy);
});

test("only bounded same-account functional inputs produce executable proposals", () => {
  const feed = {
    kind: "feed-pagination",
    route: "/transactions/public",
    authenticated: true,
    query: { page: 3, limit: 5 },
  };
  const charter = "functional-feed";
  const proposal = functional.proposal(charter, feed);
  assert.deepEqual(functional.verifyProposal(charter, proposal), feed);
  for (const input of [
    { ...feed, authenticated: false },
    { ...feed, route: "/other" },
    { ...feed, query: { page: 0, limit: 5 } },
    { ...feed, query: { page: 3, limit: 26 } },
    { ...feed, query: { page: 3, limit: 5, extra: "reject" } },
  ])
    assert.throws(() => functional.proposal(charter, input));
  assert.throws(() => functional.proposal("journeys", feed), /charter/);
  assert.throws(() => functional.verifyProposal(charter, proposal + "// changed"), /changed/);
  const directory = {
    kind: "unexpected-server-error",
    route: "/users/search",
    authenticated: true,
    query: { q: "Test User" },
  };
  assert.deepEqual(
    functional.verifyProposal(
      "functional-directory",
      functional.proposal("functional-directory", directory)
    ),
    directory
  );
  assert.throws(() => functional.proposal(charter, directory));
  assert.throws(() =>
    functional.proposal("functional-directory", { ...directory, query: { q: "A/B" } })
  );
});

test("a functional finding must match the latest failing scenario and canonical proposal hash", () => {
  const charter = "functional-feed";
  const oracle = {
    kind: "feed-pagination",
    route: "/transactions/public",
    authenticated: true,
    query: { page: 2, limit: 5 },
  };
  const finding = functional.describeFinding(charter, {
    test: "sample.api.test.cjs",
    mode: "api",
    oracle,
    title: "model title",
    summary: "model summary",
  });
  const source = functional.proposal(charter, oracle);
  const batch = { number: 1, file: finding.test, mode: "api", test: source, result: { code: 1 } };
  const report = { findings: [finding] };
  functional.verifyFindings(charter, report, [batch]);
  assert.throws(
    () =>
      functional.verifyFindings(charter, report, [
        batch,
        {
          ...batch,
          number: 2,
          result: { code: 0 },
        },
      ]),
    /failing functional proposal/
  );
  const candidate = {
    ...finding,
    source: { charter },
    file: finding.test,
    testHash: digest(source),
  };
  assert.ok(functional.eligibleCandidate(candidate));
  assert.equal(functional.eligibleCandidate({ ...candidate, testHash: "a".repeat(64) }), false);
  assert.equal(functional.eligibleCandidate({ ...candidate, title: "model title" }), false);
  assert.equal(functional.eligibleCandidate({ ...candidate, source: { charter: "feed" } }), false);
});

test("a new functional finding never reopens or attaches to an archived fingerprint", () => {
  const archive = findings.candidateFromEvidence(
    fx.functionalEvidence(),
    0,
    fx.artifact,
    fx.proof(fx.grant, "feed")
  );
  const grant = "88888888-8888-4888-8888-888888888888";
  const live = findings.candidateFromEvidence(
    fx.functionalEvidence("functional-feed", grant),
    0,
    { ...fx.artifact, name: `discovery-evidence-${grant}` },
    fx.proof(grant, "functional-feed")
  );
  assert.equal(archive.fingerprint, live.fingerprint);
  const state = emptyFindings();
  publication.stageFinding(state, archive);
  const historicalRecord = structuredClone(state.records[archive.key]);
  const result = publication.stageFinding(state, live, { eligible: functional.eligibleCandidate });
  assert.equal(result.record, live.key);
  assert.equal(state.records[live.key].generation, 2);
  assert.deepEqual(state.records[archive.key], historicalRecord);
});
