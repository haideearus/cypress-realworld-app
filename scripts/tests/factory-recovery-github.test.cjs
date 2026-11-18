const test = require("node:test");
const assert = require("node:assert/strict");
const { GitHub, ROOT } = require("../factory/github.cjs");
let RecoveryGitHub = GitHub;
try {
  ({ RecoveryGitHub } = require("../factory/recovery-github.cjs"));
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}
const secret = "testsecret";
const path = `${ROOT}/issues`;
function response(status, headers = {}, body = { message: secret }) {
  return new Response(JSON.stringify(body), { status, headers });
}
function client(responses) {
  let clock = Date.parse("2026-11-18T12:00:00Z");
  const calls = [],
    waits = [];
  const api = new RecoveryGitHub({
    token: secret,
    fetch: async (url, options) => {
      calls.push({ url, options });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      assert.ok(next, "unexpected extra request");
      return next;
    },
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  return { api, calls, waits };
}
async function failure(api, method = "GET") {
  let caught;
  await assert.rejects(
    api.request(method, path, method === "GET" ? undefined : { secret }),
    (error) => {
      caught = error;
      assert.ok(!error.message.includes(secret));
      assert.ok(!error.stack.includes(secret));
      assert.ok(!JSON.stringify(error).includes(secret));
      return true;
    }
  );
  return caught;
}
test("transient explicit rate limits retry GET and preserve the GitHub API", async () => {
  const { api, calls, waits } = client([
    response(429, { "retry-after": "2" }),
    response(200, {}, [{ number: 11 }]),
  ]);
  assert.ok(api instanceof GitHub);
  assert.deepEqual(await api.pages(path), [{ number: 11 }]);
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [2000]);
  assert.equal(calls[1].options.method, "GET");
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${secret}`);
});
test("ordinary forbidden and bare 429 errors never retry", async () => {
  for (const status of [403, 429]) {
    const { api, calls, waits } = client([response(status)]);
    const error = await failure(api);
    assert.equal(error.status, status);
    assert.notEqual(error.rateLimited, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  }
});
test("403 explicit primary and secondary rate-limit evidence is retried", async () => {
  for (const limited of [
    response(403, { "x-ratelimit-remaining": "0" }),
    response(403, {}, { message: `API rate limit exceeded for ${secret}` }),
    response(403, {}, { message: `You have exceeded a secondary rate limit. ${secret}` }),
  ]) {
    const { api, calls, waits } = client([limited, response(200, {}, { recovered: true })]);
    assert.deepEqual(await api.request("GET", path), { recovered: true });
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [1000]);
  }
});
test("reset beyond the wait budget holds immediately even with a shorter retry-after", async () => {
  const { api, calls, waits } = client([
    response(403, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1795003260",
      "retry-after": "1",
    }),
  ]);
  const error = await failure(api);
  assert.equal(error.status, 403);
  assert.equal(error.rateLimited, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test("oversized numeric retry hints hold immediately instead of overflowing into a retry", async () => {
  for (const header of ["retry-after", "x-ratelimit-reset"]) {
    const { api, calls, waits } = client([
      response(429, { "x-ratelimit-remaining": "0", [header]: "9".repeat(400) }),
    ]);
    assert.equal((await failure(api)).rateLimited, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  }
});
test("GET retries stop after three total attempts", async () => {
  const { api, calls, waits } = client(
    Array.from({ length: 3 }, () => response(429, { "retry-after": "1" }))
  );
  assert.equal((await failure(api)).rateLimited, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [1000, 1000]);
});
test("cumulative wait cannot exceed twenty seconds", async () => {
  const { api, calls, waits } = client([
    response(429, { "retry-after": "12" }),
    response(429, { "retry-after": "9" }),
  ]);
  assert.equal((await failure(api)).rateLimited, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [12000]);
});
test("twenty-second boundary and HTTP-date retry-after are supported", async () => {
  const { api, calls, waits } = client([
    response(429, { "retry-after": "Wed, 18 Nov 2026 12:00:10 GMT" }),
    response(429, { "retry-after": "10" }),
    response(200, {}, { ok: true }),
  ]);
  assert.deepEqual(await api.request("GET", path), { ok: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [10000, 10000]);
});
test("all mutations attempt only once, including explicit rate errors", async () => {
  for (const method of ["POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
    const { api, calls, waits } = client([response(429, { "retry-after": "1" })]);
    const error = await failure(api, method);
    assert.equal(error.rateLimited, true);
    assert.equal(error.status, 429);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  }
});
test("unknown network, HTTP, and JSON failures are sanitized and never retried", async () => {
  for (const bad of [
    new Error(`network ${secret} https://private.example`),
    response(500),
    new Response(secret),
  ]) {
    const { api, calls, waits } = client([bad]);
    await failure(api);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  }
});
test("rate-limit body inspection uses a clone and does not parse successful bodies", async () => {
  const ok = response(200, {}, { message: "secondary rate limit", value: 3 });
  ok.clone = () => {
    throw new Error(secret);
  };
  const { api } = client([ok]);
  assert.deepEqual(await api.request("GET", path), { message: "secondary rate limit", value: 3 });
});
test("manual archive redirects remain available to the bounded credential-stripping downloader", async () => {
  const { api, calls } = client([
    response(302, { location: "https://fixture.blob.core.windows.net/archive" }),
  ]);
  const result = await api.fetch(
    "https://api.github.com/repos/haideearus/cypress-realworld-app/actions/artifacts/1/zip",
    { method: "GET", redirect: "manual" }
  );
  assert.equal(result.status, 302);
  assert.equal(calls.length, 1);
});
