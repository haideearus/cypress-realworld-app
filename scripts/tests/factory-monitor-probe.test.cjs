const test = require("node:test");
const assert = require("node:assert/strict");
const { probeApp } = require("../factory/monitor-probe.cjs");

const APP_URL = "https://haide-software-factory.onrender.com";
const RELEASE = "b".repeat(40);
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const html = () =>
  new Response('<!doctype html><html><body><div id="root"></div></body></html>', {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
function healthy(url) {
  if (url === `${APP_URL}/healthz`) return json({ status: "ok", release: RELEASE });
  if (url === `${APP_URL}/readyz`) return json({ status: "ok" });
  if (url === `${APP_URL}/`) return html();
  throw new Error("Unexpected URL");
}
const failed = (attempts = 3) => ({
  healthy: false,
  checks: { health: "failed", readiness: "failed", frontend: "failed" },
  attempts,
});

test("healthy previously deployed release passes without comparing it to main", async () => {
  const calls = [];
  const result = await probeApp({
    fetch: async (url, options) => {
      calls.push({ url, options });
      return healthy(url);
    },
    sleep: async () => {
      throw new Error("Healthy app must not retry");
    },
  });
  assert.deepEqual(result, {
    healthy: true,
    checks: { health: "ok", readiness: "ok", frontend: "ok" },
    attempts: 1,
    release: RELEASE,
  });
  assert.deepEqual(calls.map(({ url }) => url).sort(), [
    `${APP_URL}/`,
    `${APP_URL}/healthz`,
    `${APP_URL}/readyz`,
  ]);
  for (const { options } of calls) {
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(options.headers).sort(), ["Accept", "Cache-Control"]);
    assert.equal(options.headers["Cache-Control"], "no-cache");
  }
});

test("cold start is retried after 30 seconds and can recover on the third round", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await probeApp({
    fetch: async (url) =>
      ++calls <= 6 ? new Response("cold start", { status: 503 }) : healthy(url),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(result.healthy, true);
  assert.equal(result.attempts, 3);
  assert.equal(result.release, RELEASE);
  assert.equal(calls, 9);
  assert.deepEqual(sleeps, [30000, 30000]);
});

test("persistent failures stop after exactly three rounds and no extra delay", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await probeApp({
    fetch: async () => {
      calls++;
      return new Response("unavailable", { status: 503 });
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.deepEqual(result, failed());
  assert.equal(calls, 9);
  assert.deepEqual(sleeps, [30000, 30000]);
});

test("an allowed smaller attempt count stays bounded", async () => {
  let calls = 0;
  const result = await probeApp({
    attempts: 1,
    fetch: async () => {
      calls++;
      return new Response(null, { status: 500 });
    },
    sleep: async () => {
      throw new Error("Single attempt must not sleep");
    },
  });
  assert.deepEqual(result, failed(1));
  assert.equal(calls, 3);
});

for (const health of [
  { status: "ok", release: "local" },
  { status: "ok", release: "A".repeat(40) },
  { status: "ok", release: RELEASE + "\n" },
  { status: "ok", release: "b".repeat(39) },
  { status: "unavailable", release: RELEASE },
  {},
]) {
  test(`invalid health evidence never exposes an invalid release: ${JSON.stringify(health).length}-${Object.keys(health).length}`, async () => {
    const result = await probeApp({
      attempts: 1,
      fetch: async (url) => (url.endsWith("/healthz") ? json(health) : healthy(url)),
    });
    assert.deepEqual(result, {
      healthy: false,
      checks: { health: "failed", readiness: "ok", frontend: "ok" },
      attempts: 1,
    });
  });
}

test("failed database readiness is reported separately from health and frontend", async () => {
  const result = await probeApp({
    attempts: 1,
    fetch: async (url) =>
      url.endsWith("/readyz") ? json({ status: "unavailable" }, 503) : healthy(url),
  });
  assert.deepEqual(result, {
    healthy: false,
    checks: { health: "ok", readiness: "failed", frontend: "ok" },
    attempts: 1,
    release: RELEASE,
  });
});

for (const frontend of [
  new Response("<html>server error</html>", { headers: { "content-type": "text/html" } }),
  new Response('<div data-id="root"></div>', { headers: { "content-type": "text/html" } }),
  new Response('<div id="root"></div>', { headers: { "content-type": "application/json" } }),
]) {
  test("frontend marker and HTML content type are required", async () => {
    const result = await probeApp({
      attempts: 1,
      fetch: async (url) => (url === `${APP_URL}/` ? frontend : healthy(url)),
    });
    assert.equal(result.healthy, false);
    assert.equal(result.checks.frontend, "failed");
  });
}

for (const failure of [
  "redirect",
  "network",
  "oversized-stream",
  "oversized-length",
  "malformed-json",
]) {
  test(`${failure} produces only bounded check names, never response details or secrets`, async () => {
    const result = await probeApp({
      attempts: 1,
      fetch: async () => {
        if (failure === "redirect")
          return new Response(null, {
            status: 302,
            headers: { location: "https://secret.invalid/?token=do-not-log" },
          });
        if (failure === "network") throw new Error("secret token do-not-log");
        if (failure === "oversized-stream")
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(300000));
                controller.close();
              },
            })
          );
        if (failure === "oversized-length")
          return new Response("do-not-log", { headers: { "content-length": "300000" } });
        return new Response("do-not-log", { headers: { "content-type": "application/json" } });
      },
    });
    assert.deepEqual(result, failed(1));
    assert.ok(!JSON.stringify(result).includes("do-not-log"));
  });
}

test("request timeout bounds a fetch implementation that ignores abort", async () => {
  let calls = 0;
  const result = await probeApp({
    attempts: 1,
    requestTimeoutMs: 10,
    fetch: async () => {
      calls++;
      return new Promise(() => {});
    },
  });
  assert.deepEqual(result, failed(1));
  assert.equal(calls, 3);
});

test("body stream timeout is bounded after response headers arrive", async () => {
  const result = await probeApp({
    attempts: 1,
    requestTimeoutMs: 10,
    fetch: async () => new Response(new ReadableStream({ start() {} })),
  });
  assert.deepEqual(result, failed(1));
});

test("a failed retry pause stops safely without exposing its exception", async () => {
  const result = await probeApp({
    fetch: async () => new Response(null, { status: 503 }),
    sleep: async () => {
      throw new Error("secret should not appear");
    },
  });
  assert.deepEqual(result, failed(1));
});

test("latest round determines the reported checks, without stale release evidence", async () => {
  let calls = 0;
  const result = await probeApp({
    attempts: 2,
    fetch: async (url) => {
      calls++;
      if (calls <= 3 && url.endsWith("/healthz")) return healthy(url);
      return new Response(null, { status: 503 });
    },
    sleep: async () => {},
  });
  assert.deepEqual(result, failed(2));
});

test("invalid injected bounds fail before any network or sleep call", async () => {
  let calls = 0;
  for (const overrides of [
    { attempts: 0 },
    { attempts: 4 },
    { attempts: 1.5 },
    { attempts: "3" },
    { requestTimeoutMs: 0 },
    { requestTimeoutMs: 30001 },
    { requestTimeoutMs: NaN },
    { fetch: false },
    { sleep: false },
  ]) {
    await assert.rejects(
      probeApp({
        fetch: async () => {
          calls++;
        },
        sleep: async () => {
          calls++;
        },
        ...overrides,
      }),
      /Invalid monitor probe configuration/
    );
  }
  assert.equal(calls, 0);
});
