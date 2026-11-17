const test = require("node:test");
const assert = require("node:assert/strict");
const f = require("./helpers/finding-fixtures.cjs");
const c = require("../factory/discovery-contract.cjs");
const contract = () => require("../factory/discovery-finding-contract.cjs");
const publication = () => require("../factory/discovery-publication.cjs");
function candidate(route = "/users", grant = f.grant, kind = "protected-route") {
  return contract().candidateFromEvidence(
    f.evidence(kind, route, grant),
    0,
    { ...f.artifact, name: `discovery-evidence-${grant}` },
    f.proof(grant)
  );
}
const enabled = { enabled: true, automatic: true, discovery: true, timezone: "Europe/Bucharest" };
test("a stop between intent and issue POST can resume without refund or duplicate POST", async () => {
  const store = f.memoryStore(contract().emptyFindings()),
    row = candidate(),
    p = publication();
  await store.update((s) => {
    p.stageFinding(s, row);
    return { state: s };
  });
  let stopped = false,
    posts = 0,
    issue;
  const api = {
    async request(method, url, body) {
      if (method === "GET" && url.includes("/issues?")) return [];
      assert.equal(method, "POST");
      posts++;
      issue = {
        number: 77,
        title: body.title,
        body: body.body,
        user: { login: "github-actions[bot]", id: 41898282, type: "Bot" },
      };
      return issue;
    },
  };
  const options = {
    api,
    store,
    ledger: {
      async read() {
        return { state: { stop: stopped ? {} : null } };
      },
    },
    config: enabled,
    context: f.context,
    key: row.key,
    verifySource: async () => true,
    now: new Date("2026-11-17T12:00:00Z"),
    scan: async () => {
      stopped = true;
    },
  };
  assert.equal((await p.publishFinding(options)).status, "held-stop");
  assert.equal(store.state.records[row.key].publication.writeStarted, false);
  stopped = false;
  assert.equal((await p.publishFinding({ ...options, scan: async () => {} })).status, "published");
  assert.equal(posts, 1);
  assert.equal(store.state.days["2026-11-17"].length, 1);
});
test("exhausted reconciliation lookup holds the retained intent instead of issuing again", async () => {
  const store = f.memoryStore(contract().emptyFindings()),
    row = candidate(),
    p = publication();
  await store.update((s) => {
    p.stageFinding(s, row);
    const r = p.claimPublication(s, row.key, "2026-11-17", f.context, enabled, false);
    r.publication.writeStarted = true;
    return { state: s };
  });
  let gets = 0;
  const api = {
    async request(method) {
      assert.equal(method, "GET");
      gets++;
      return Array.from({ length: 100 }, () => ({ number: 1, title: "unrelated" }));
    },
  };
  await assert.rejects(
    () =>
      p.publishFinding({
        api,
        store,
        key: row.key,
        context: f.context,
        config: enabled,
        ledger: {
          async read() {
            return { state: { stop: null } };
          },
        },
        verifySource: async () => true,
      }),
    /bound/
  );
  assert.equal(gets, 5);
  assert.equal(store.state.days["2026-11-17"].length, 1);
});
test("only individual twice-verified findings qualify; report completion never establishes a bug", () => {
  const row = candidate();
  assert.equal(
    row.fingerprint,
    publication().fingerprintFinding({
      component: "/users",
      symptom: "unauthenticated-access",
      contract: "protected-route",
    })
  );
  for (const alter of [
    (b) => (b.findings[0].status = "held"),
    (b) => (b.fixture = true),
    (b) => (b.findings[0].proposedReplays[1].code = 0),
    (b) => (b.findings[0].replays[1].observation.signature = "invented"),
    (b) => (b.findings[0].original.test = "tampered"),
  ]) {
    const b = f.evidence();
    alter(b);
    assert.throws(
      () => contract().candidateFromEvidence(b, 0, f.artifact, f.proof()),
      /Invalid|verified|evidence|repro|changed/i
    );
  }
});
test("publication caps count irreversible intents: four/day, two/source, midnight does not refund", () => {
  const p = publication(),
    s = contract().emptyFindings();
  for (let i = 0; i < 4; i++) {
    const row = candidate(
      ["/users", "/transactions", "/bankAccounts", "/notifications"][i],
      i < 2 ? f.grant : "88888888-8888-4888-8888-888888888888"
    );
    p.stageFinding(s, row);
    p.claimPublication(s, row.key, "2026-11-17", f.context, enabled, false);
  }
  const fifth = candidate(
    "/users",
    "99999999-9999-4999-8999-999999999999",
    "unexpected-server-error"
  );
  p.stageFinding(s, fifth);
  assert.equal(
    p.claimPublication(s, fifth.key, "2026-11-17", f.context, enabled, false).status,
    "held-quota"
  );
  assert.equal(s.days["2026-11-17"].length, 4);
  assert.equal(
    p.claimPublication(s, fifth.key, "2026-11-18", f.context, enabled, false).status,
    "publishing-intent"
  );
  assert.equal(s.days["2026-11-17"].length, 4);
  const extra = candidate("/notifications", f.grant);
  assert.throws(() => p.stageFinding(s, extra), /source.*limit/i);
});
test("fingerprints span commits; duplicates retain evidence and never rewrite frozen issue criteria", () => {
  const p = publication(),
    s = contract().emptyFindings(),
    one = candidate();
  p.stageFinding(s, one);
  s.records[one.key].status = "published";
  s.records[one.key].publication = {
    day: "2026-11-17",
    context: f.context,
    issue: 77,
    title: "fixed title",
    body: "fixed body",
    criteriaHash: c.digest(["fixed title", "fixed body"]),
  };
  const second = candidate("/users", "88888888-8888-4888-8888-888888888888");
  second.source.head = "b".repeat(40);
  second.source.workflowSha = second.source.head;
  second.source.key = c.sweepKey(second.source.head, second.source.charter, second.source.day);
  second.key = c.digest([second.source.grantId, second.findingHash]);
  const r = p.stageFinding(s, second);
  assert.equal(r.status, "duplicate");
  assert.equal(r.record, one.key);
  assert.equal(s.records[one.key].publication.body, "fixed body");
  assert.equal(s.records[one.key].duplicates.length, 1);
  s.records[one.key].status = "observed-resolved";
  const third = candidate("/users", "99999999-9999-4999-8999-999999999999");
  assert.equal(p.stageFinding(s, third).status, "verified");
  assert.equal(Object.keys(s.records).length, 2);
});
test("lost issue response is reconciled without a second POST; owner stop blocks new writes", async () => {
  const p = publication(),
    store = f.memoryStore(contract().emptyFindings()),
    row = candidate();
  await store.update((s) => {
    p.stageFinding(s, row);
    return { state: s };
  });
  let posts = 0,
    issue;
  const api = {
    async request(method, url, body) {
      if (method === "GET" && url.includes("/issues?")) return issue ? [issue] : [];
      if (method === "POST" && url.endsWith("/issues")) {
        posts++;
        issue = {
          number: 77,
          title: body.title,
          body: body.body,
          labels: body.labels.map((name) => ({ name })),
          state: "open",
          user: { login: "github-actions[bot]", id: 41898282, type: "Bot" },
        };
        throw Error("lost response");
      }
      throw Error("Unexpected request");
    },
    async pages() {
      return issue ? [issue] : [];
    },
  };
  const options = {
    api,
    store,
    ledger: {
      async read() {
        return { state: { stop: null } };
      },
    },
    config: enabled,
    context: f.context,
    verifySource: async () => true,
    scan: async () => {},
    now: new Date("2026-11-17T12:00:00Z"),
  };
  await assert.rejects(p.publishFinding({ ...options, key: row.key }), /lost response/);
  assert.equal(store.state.days["2026-11-17"].length, 1);
  const result = await p.publishFinding({ ...options, key: row.key });
  assert.equal(result.issue, 77);
  assert.equal(posts, 1);
  assert.equal(store.state.records[row.key].status, "published");
  const fresh = candidate("/bankAccounts");
  await store.update((s) => {
    p.stageFinding(s, fresh);
    return { state: s };
  });
  const held = await p.publishFinding({
    ...options,
    key: fresh.key,
    ledger: {
      async read() {
        return { state: { stop: { active: true } } };
      },
    },
  });
  assert.equal(held.status, "held-stop");
  assert.equal(posts, 1);
});
