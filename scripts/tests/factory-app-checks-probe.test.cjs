const test = require("node:test");
const assert = require("node:assert/strict");
const APP = "https://haide-software-factory.onrender.com";
const COOKIE = "connect.sid=s%3Asynthetic-session.signature";
const username = "synthetic-monitor";
const password = "fixture-password-not-a-real-secret";
const user = { id: "fixture-user", username };
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
function fixture(change = () => undefined) {
  const calls = [];
  const fetch = async (url, options) => {
    const index = calls.push({ url, options }) - 1;
    const replaced = await change(url, options, index);
    if (replaced !== undefined) return replaced;
    if (url === APP + "/api/login")
      return json({ user }, 200, {
        "set-cookie": COOKIE + "; Path=/; Secure; HttpOnly; SameSite=Lax",
      });
    if (url === APP + "/api/checkAuth")
      return options.headers.Cookie === COOKIE && index % 5 !== 4
        ? json({ user })
        : json({ error: "User is unauthorized" }, 401);
    if (url === APP + "/api/transactions/public?page=1&limit=5")
      return json({
        results: [{ id: "payment-fixture" }],
        pageData: { page: 1, limit: 5, totalPages: 1, hasNextPages: false },
      });
    if (url === APP + "/api/logout")
      return new Response(null, {
        status: 302,
        headers: { location: "/", "set-cookie": "connect.sid=; Path=/; Max-Age=0" },
      });
    throw Error("Unexpected destination");
  };
  return { fetch, calls };
}
const probe = (options) =>
  require("../factory/app-checks-probe.cjs").probeUserJourney({
    username,
    password,
    attempts: 1,
    ...options,
  });
test("synthetic journey signs in, reads its session/feed and invalidates its old cookie on logout", async () => {
  const f = fixture();
  const result = await probe(f);
  assert.deepEqual(result, {
    healthy: true,
    checks: { login: "ok", session: "ok", feed: "ok", logout: "ok" },
    attempts: 1,
  });
  assert.deepEqual(
    f.calls.map((c) => [new URL(c.url).pathname + new URL(c.url).search, c.options.method]),
    [
      ["/api/login", "POST"],
      ["/api/checkAuth", "GET"],
      ["/api/transactions/public?page=1&limit=5", "GET"],
      ["/api/logout", "POST"],
      ["/api/checkAuth", "GET"],
    ]
  );
  for (const c of f.calls) {
    assert.equal(new URL(c.url).origin, APP);
    assert.equal(c.options.redirect, "manual");
    assert.equal(c.options.credentials, "omit");
    assert.ok(c.options.signal instanceof AbortSignal);
    assert.equal(c.options.headers.Origin, APP);
    if (c.options.method === "GET") assert.equal(c.options.body, undefined);
  }
  assert.deepEqual(JSON.parse(f.calls[0].options.body), { username, password, remember: false });
  assert.equal(f.calls[0].options.headers.Cookie, undefined);
  assert.equal(
    f.calls[4].options.headers.Cookie,
    COOKIE,
    "logout must invalidate the old server-side session"
  );
  assert.ok(!JSON.stringify(result).includes(username));
  assert.ok(!JSON.stringify(result).includes(password));
  assert.ok(!JSON.stringify(result).includes(COOKIE));
});
test("empty feeds are healthy and cookie rotation is honored without exposing cookies", async () => {
  let postLogout = false;
  const rotated = "connect.sid=s%3Arotated.signature";
  const f = fixture((url, options, index) => {
    if (url.endsWith("/api/checkAuth") && index === 1)
      return json({ user }, 200, { "set-cookie": rotated + "; Secure; HttpOnly" });
    if (url.includes("/api/transactions/public")) {
      assert.equal(options.headers.Cookie, rotated);
      return json({
        results: [],
        pageData: { page: 1, limit: 5, totalPages: 0, hasNextPages: false },
      });
    }
    if (url.endsWith("/api/logout")) {
      assert.equal(options.headers.Cookie, rotated);
      postLogout = true;
    }
    if (postLogout && url.endsWith("/api/checkAuth")) {
      assert.equal(options.headers.Cookie, rotated);
      return json({ error: "unauthorized" }, 401);
    }
  });
  assert.equal((await probe(f)).healthy, true);
});
test("broken session and feed contracts fail and still attempt session cleanup", async () => {
  const variants = [
    ["/api/checkAuth", () => json({ user: { ...user, id: "another-user" } })],
    [
      "/api/transactions/public?page=1&limit=5",
      () =>
        json({ results: [], pageData: { page: 2, limit: 5, totalPages: 1, hasNextPages: false } }),
    ],
    [
      "/api/transactions/public?page=1&limit=5",
      () =>
        json({
          results: new Array(6).fill({ id: "x" }),
          pageData: { page: 1, limit: 5, totalPages: 2, hasNextPages: true },
        }),
    ],
    [
      "/api/transactions/public?page=1&limit=5",
      () => new Response("private response", { headers: { "content-type": "text/html" } }),
    ],
    [
      "/api/transactions/public?page=1&limit=5",
      () => {
        throw Error("private exception " + password);
      },
    ],
  ];
  for (const [suffix, response] of variants) {
    const f = fixture((url, options, index) =>
      index < 3 && url === APP + suffix ? response() : undefined
    );
    const result = await probe(f);
    assert.equal(result.healthy, false);
    assert.ok(f.calls.some((c) => c.url.endsWith("/api/logout")));
    assert.ok(!JSON.stringify(result).includes("private"));
  }
});
test("bad credentials, unsafe cookies and redirects cannot become healthy or follow another host", async () => {
  for (const response of [
    () => json({ error: password }, 401),
    () => new Response(null, { status: 307, headers: { location: "https://attacker.invalid" } }),
    () => json({ user }, 200),
    () => json({ user }, 200, { "set-cookie": "connect.sid=bad value; Secure" }),
    () => json({ user: { ...user, password } }, 200, { "set-cookie": COOKIE + "; Secure" }),
  ]) {
    const f = fixture((url) => (url.endsWith("/api/login") ? response() : undefined));
    const result = await probe(f);
    assert.equal(result.healthy, false);
    assert.equal(result.checks.login, "failed");
    assert.ok(f.calls.every((c) => c.url.startsWith(APP + "/api/")));
    assert.ok(f.calls.length <= 3);
    assert.ok(!JSON.stringify(result).includes(password));
  }
});
test("logout succeeds only if the old session is rejected; external redirects are not followed", async () => {
  for (const type of ["still-authenticated", "external-redirect", "server-error", "html-401"]) {
    const f = fixture((url, options, index) => {
      if (url.endsWith("/api/logout") && type === "external-redirect")
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.invalid" },
        });
      if (url.endsWith("/api/logout") && type === "server-error") return json({}, 500);
      if (index === 4 && type === "still-authenticated") return json({ user });
      if (index === 4 && type === "html-401") return new Response("unauthorized", { status: 401 });
    });
    const result = await probe(f);
    assert.equal(result.healthy, false);
    assert.equal(result.checks.logout, "failed");
  }
});
test("a cookie received before a malformed or oversized login body is still cleaned up", async () => {
  for (const body of ["not-json", "x".repeat(65537)]) {
    const f = fixture((url) =>
      url.endsWith("/api/login")
        ? new Response(body, {
            headers: {
              "content-type": "application/json",
              "set-cookie": COOKIE + "; Secure; HttpOnly",
            },
          })
        : undefined
    );
    const result = await probe(f);
    assert.equal(result.healthy, false);
    assert.ok(f.calls.some((c) => c.url.endsWith("/api/logout")));
  }
});
test("safe cookies missing Secure or HttpOnly fail login but are retained for cleanup", async () => {
  for (const attributes of ["Secure", "HttpOnly"]) {
    const f = fixture((url, options, index) => {
      if (url.endsWith("/api/login"))
        return json({ user }, 200, { "set-cookie": COOKIE + "; " + attributes });
      if (url.endsWith("/api/checkAuth") && index === 2)
        return json({ error: "unauthorized" }, 401);
    });
    const result = await probe(f);
    assert.equal(result.healthy, false);
    assert.equal(result.checks.login, "failed");
    assert.deepEqual(
      f.calls.map((c) => new URL(c.url).pathname),
      ["/api/login", "/api/logout", "/api/checkAuth"]
    );
    assert.equal(f.calls[1].options.headers.Cookie, COOKIE);
    assert.equal(result.checks.logout, "ok");
  }
});
test("cold-start retries are bounded and can recover without sharing a cookie between attempts", async () => {
  const f = fixture((url, options, index) => (index === 0 ? json({}, 503) : undefined));
  const sleeps = [];
  // Use a fresh fixture per attempt after the initial one-call failure.
  const good = fixture();
  let first = true;
  const result = await probe({
    attempts: 3,
    sleep: async (ms) => sleeps.push(ms),
    fetch: (url, options) => {
      if (first) {
        first = false;
        return f.fetch(url, options);
      }
      return good.fetch(url, options);
    },
  });
  assert.equal(result.healthy, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(sleeps, [30000]);
  assert.equal(good.calls[0].options.headers.Cookie, undefined);
  let calls = 0;
  const failed = await probe({
    attempts: 3,
    fetch: async () => {
      calls++;
      return json({}, 503);
    },
    sleep: async () => {},
  });
  assert.equal(failed.attempts, 3);
  assert.equal(calls, 3);
});
test("oversized, streaming and unresponsive responses terminate within the request bound", async () => {
  const makers = [
    () => new Response("x".repeat(65537), { headers: { "content-type": "application/json" } }),
    () =>
      new Response("{}", {
        headers: { "content-type": "application/json", "content-length": "65537" },
      }),
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(65537));
          },
        })
      ),
    () => new Promise(() => {}),
    () =>
      new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => {});
          },
        })
      ),
  ];
  for (const make of makers) {
    const start = performance.now();
    const result = await probe({ fetch: async () => make(), requestTimeoutMs: 15 });
    assert.equal(result.healthy, false);
    assert.ok(performance.now() - start < 1000);
  }
});
test("invalid credentials and larger runtime limits refuse before any request", async () => {
  for (const change of [
    { username: "" },
    { password: "" },
    { username: "x\n" },
    { attempts: 4 },
    { requestTimeoutMs: 10001 },
    { attempts: 0 },
  ]) {
    let calls = 0;
    await assert.rejects(() =>
      probe({
        ...change,
        fetch: async () => {
          calls++;
          throw Error();
        },
      })
    );
    assert.equal(calls, 0);
  }
});
