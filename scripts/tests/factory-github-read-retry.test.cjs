const test = require("node:test");
const assert = require("node:assert/strict");
const { GitHub, ROOT } = require("../factory/github.cjs");

function client(statuses, retryReads = true, retryInternalReads = false) {
  const calls = [];
  const api = new GitHub({
    token: "fixture-only",
    retryReads,
    retryInternalReads,
    sleep: async () => {},
    fetch: async (_url, options) => {
      calls.push(options.method);
      const status = statuses[calls.length - 1];
      assert.ok(status, "Unexpected retry");
      return new Response(JSON.stringify({ fixture: true }), { status });
    },
  });
  return { api, calls };
}

test("provenance GET recovers from 502 and 503 and returns the verified response", async () => {
  const { api, calls } = client([502, 503, 200]);
  assert.deepEqual(await api.request("GET", ROOT + "/issues/96"), { fixture: true });
  assert.deepEqual(calls, ["GET", "GET", "GET"]);
});

test("review reservation can opt in to retrying HTTP 500 for reads only", async () => {
  const retrying = client([500, 200], true, true);
  assert.deepEqual(await retrying.api.request("GET", ROOT + "/issues/96"), { fixture: true });
  assert.deepEqual(retrying.calls, ["GET", "GET"]);
  for (const [method, optIn] of [
    ["GET", false],
    ["POST", true],
    ["PUT", true],
  ]) {
    const single = client([500], true, optIn);
    await assert.rejects(single.api.request(method, ROOT + "/issues/96"), { status: 500 });
    assert.deepEqual(single.calls, [method]);
  }
});

test("persistent gateway errors exhaust a bounded retry and retain their HTTP status", async () => {
  const { api, calls } = client([502, 503, 504]);
  await assert.rejects(api.request("GET", ROOT + "/issues/96"), { status: 504 });
  assert.equal(calls.length, 3);
});

test("default callers, denials, rate limits and mutations keep single-attempt behavior", async () => {
  for (const [method, status, retry] of [
    ["GET", 502, false],
    ["GET", 401, true],
    ["GET", 403, true],
    ["GET", 404, true],
    ["GET", 429, true],
    ["POST", 502, true],
    ["PATCH", 503, true],
    ["PUT", 504, true],
  ]) {
    const { api, calls } = client([status], retry);
    await assert.rejects(api.request(method, ROOT + "/issues/96"), { status });
    assert.deepEqual(calls, [method]);
  }
});

test("invalid successful JSON and transport failures still fail after one request", async () => {
  for (const respond of [
    () => new Response("invalid-json", { status: 200 }),
    () => {
      throw new TypeError("fixture transport failed");
    },
  ]) {
    let calls = 0;
    const api = new GitHub({
      token: "fixture-only",
      retryReads: true,
      fetch: async () => {
        calls++;
        return respond();
      },
    });
    await assert.rejects(api.request("GET", ROOT + "/issues/96"));
    assert.equal(calls, 1);
  }
});

test("conditional polling requires a cached representation for the same run", async () => {
  const requests = [];
  const replies = [
    Response.json({ id: 501, status: "queued" }, { headers: { etag: '"run-501"' } }),
    new Response(null, { status: 304 }),
    new Response(null, { status: 304 }),
  ];
  const api = new GitHub({
    token: "fixture-only",
    fetch: async (_url, options) => {
      requests.push(new Headers(options.headers).get("If-None-Match"));
      return replies.shift();
    },
  });
  const pollCache = {};
  const read = (id) => api.request("GET", ROOT + "/actions/runs/" + id, undefined, { pollCache });
  assert.deepEqual(await read(501), { id: 501, status: "queued" });
  await assert.rejects(read(502), { status: 304 });
  assert.deepEqual(await read(501), { id: 501, status: "queued" });
  assert.deepEqual(requests, [null, null, '"run-501"']);
  await assert.rejects(
    api.request("GET", ROOT + "/issues/501", undefined, { pollCache }),
    /only supported/
  );
});
