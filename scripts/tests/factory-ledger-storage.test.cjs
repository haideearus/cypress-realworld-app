const test = require("node:test");
const assert = require("node:assert/strict");
const { Ledger, ROOT } = require("../factory/github.cjs");
const { emptyState, REPOSITORY } = require("../factory/policy.cjs");

test("ledger writes compact JSON and reads the same history from either encoding", async () => {
  const state = emptyState(REPOSITORY);
  state.audit.push({ event: "fixture", message: "preserve these records" });
  const prior = "a".repeat(40);
  const next = "b".repeat(40);
  let content = JSON.stringify(state, null, 2) + "\n";
  const ledger = new Ledger({
    async request(method, path, data) {
      if (method === "GET" && path === `${ROOT}/git/ref/heads/factory/state`)
        return { object: { sha: prior } };
      if (method === "GET" && path === `${ROOT}/contents/state.json?ref=${prior}`)
        return {
          type: "file",
          encoding: "base64",
          content: Buffer.from(content).toString("base64"),
        };
      if (path === `${ROOT}/git/blobs`) {
        content = Buffer.from(data.content, "base64").toString("utf8");
        return { sha: "c".repeat(40) };
      }
      if (path === `${ROOT}/git/trees`) return { sha: "d".repeat(40) };
      assert.deepEqual(data.parents, [prior]);
      return { sha: next };
    },
  });
  assert.deepEqual((await ledger.read()).state, state);
  assert.equal(await ledger.commit(state, prior), next);
  assert.equal(content, JSON.stringify(state) + "\n");
  assert.deepEqual((await ledger.read()).state, state);
});

test("ledger warns near its hard write limit and denies oversized state before any write", async (t) => {
  const state = emptyState(REPOSITORY);
  state.audit.push({ event: "fixture", evidence: "x".repeat(810_000) });
  const warning = t.mock.method(console, "warn", () => {});
  const paths = [];
  const ledger = new Ledger({
    async request(_method, path) {
      paths.push(path);
      return { sha: "a".repeat(40) };
    },
  });
  await ledger.commit(state);
  assert.equal(warning.mock.callCount(), 1);
  assert.match(warning.mock.calls[0].arguments[0], /ledger.*capacity/i);
  state.audit[0].evidence = "x".repeat(1_000_001);
  await assert.rejects(ledger.commit(state), /safe size/);
  assert.equal(paths.length, 3);
});
