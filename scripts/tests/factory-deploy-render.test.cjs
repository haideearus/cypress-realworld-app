const test = require("node:test");
const assert = require("node:assert/strict");
const { triggerDeploy, waitForRelease, APP_URL } = require("../factory/deploy-render.cjs");

const SHA = "a".repeat(40);
const OLD_SHA = "b".repeat(40);
const HOOK = "https://api.render.com/deploy/srv-demo123?key=private-hook-value";
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const html = () =>
  new Response('<!doctype html><html><body><div id="root"></div></body></html>', {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

function clock() {
  let milliseconds = Date.parse("2026-11-13T20:00:00Z");
  return {
    now: () => milliseconds,
    sleep: async (ms) => {
      milliseconds += ms;
    },
    advance: (ms) => {
      milliseconds += ms;
    },
  };
}

function pollingOptions(fetch, overrides = {}) {
  return { sha: SHA, fetch, ...clock(), timeoutMs: 60, intervalMs: 10, ...overrides };
}

function healthy(url) {
  if (url.endsWith("/healthz")) return json({ status: "ok", release: SHA });
  if (url.endsWith("/readyz")) return json({ status: "ok" });
  if (url === `${APP_URL}/`) return html();
  throw new Error("Unexpected request");
}

test("trigger posts exactly once, replaces ref, and reports only bounded deployment metadata", async () => {
  const calls = [];
  const result = await triggerDeploy({
    hook: `${HOOK}&ref=${OLD_SHA}`,
    sha: SHA,
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return json({ deploy: { id: "dep-example123", secret: "must-not-return" } });
    },
  });
  assert.deepEqual(result, { httpStatus: 200, deployId: "dep-example123" });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("ref"), SHA);
  assert.equal(url.searchParams.get("key"), "private-hook-value");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "error");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.headers.Authorization, undefined);
});

for (const [index, hook] of [
  "http://api.render.com/deploy/srv-demo123?key=secret",
  "https://api.render.com.evil.test/deploy/srv-demo123?key=secret",
  "https://api.render.com@evil.test/deploy/srv-demo123?key=secret",
  "https://user:password@api.render.com/deploy/srv-demo123?key=secret",
  "https://api.render.com:8443/deploy/srv-demo123?key=secret",
  "https://api.render.com:443/deploy/srv-demo123?key=secret",
  "https://api.render.com/deploy/srv-demo123?key=secret#fragment",
  "https://api.render.com/deploy/srv-demo123",
  "https://api.render.com/deploy/srv-demo123?key=",
  "https://api.render.com/deploy/srv-demo123?key=a&key=b",
  "https://api.render.com/deploy/srv-demo123?key=a&ref=b&ref=c",
  "https://api.render.com/deploy/srv-demo123?key=a&imgURL=evil",
  "https://api.render.com/v1/services/srv-demo123?key=a",
  "not a URL",
].entries()) {
  test(`invalid deploy hook rejected without HTTP: case ${index + 1}`, async () => {
    let calls = 0;
    await assert.rejects(
      triggerDeploy({
        hook,
        sha: SHA,
        fetch: async () => {
          calls++;
        },
      }),
      /Invalid deploy hook/
    );
    assert.equal(calls, 0);
  });
}

test("invalid SHA never reaches the network", async () => {
  let calls = 0;
  for (const sha of ["main", "A".repeat(40), "a".repeat(39), `${SHA}\n`]) {
    await assert.rejects(
      triggerDeploy({
        hook: HOOK,
        sha,
        fetch: async () => {
          calls++;
        },
      }),
      /Invalid release/
    );
    await assert.rejects(
      waitForRelease(
        pollingOptions(
          async () => {
            calls++;
          },
          { sha }
        )
      ),
      /Invalid release/
    );
  }
  assert.equal(calls, 0);
});

test("queued 202 and an unrecognized 200 response are accepted without invented deployment IDs", async () => {
  for (const response of [
    new Response(null, { status: 202 }),
    json({ id: "untrusted-value" }),
    json({ id: "dep-example\n" }),
    new Response("accepted"),
  ]) {
    const status = response.status;
    const result = await triggerDeploy({ hook: HOOK, sha: SHA, fetch: async () => response });
    assert.deepEqual(result, { httpStatus: status, deployId: null });
  }
});

test("ambiguous hook failure is redacted and never retried", async () => {
  let calls = 0;
  await assert.rejects(
    triggerDeploy({
      hook: HOOK,
      sha: SHA,
      fetch: async () => {
        calls++;
        throw new Error(HOOK);
      },
    }),
    (error) => {
      assert.match(error.message, /Deploy request failed/);
      assert.ok(!error.message.includes("private-hook-value"));
      assert.equal(error.cause, undefined);
      return true;
    }
  );
  assert.equal(calls, 1);
});

test("hook error responses do not expose their body or get retried", async () => {
  let calls = 0;
  await assert.rejects(
    triggerDeploy({
      hook: HOOK,
      sha: SHA,
      fetch: async () => {
        calls++;
        return new Response(HOOK, { status: 503 });
      },
    }),
    /^Error: Deploy request failed \(HTTP 503\)/
  );
  assert.equal(calls, 1);
});

test("hook timeout remains bounded even for a transport that ignores abort", async () => {
  let calls = 0;
  await assert.rejects(
    triggerDeploy({
      hook: HOOK,
      sha: SHA,
      requestTimeoutMs: 10,
      fetch: async () => {
        calls++;
        return new Promise(() => {});
      },
    }),
    /Deploy request failed/
  );
  assert.equal(calls, 1);
});

test("successful release requires matching health, ready database, HTML frontend, then matching health again", async () => {
  const calls = [];
  const result = await waitForRelease(
    pollingOptions(async (url, options) => {
      calls.push({ url: String(url), options });
      return healthy(String(url));
    })
  );
  assert.deepEqual(result, {
    release: SHA,
    health: true,
    ready: true,
    frontend: true,
    observedAt: "2026-11-13T20:00:00.000Z",
  });
  assert.deepEqual(
    calls.map((call) => call.url),
    [`${APP_URL}/healthz`, `${APP_URL}/readyz`, `${APP_URL}/`, `${APP_URL}/healthz`]
  );
  for (const { options } of calls) {
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers["Cache-Control"], "no-cache");
    assert.equal(options.headers.Authorization, undefined);
  }
});

test("cold start and old release may recover within the bounded polling window", async () => {
  let attempts = 0;
  const result = await waitForRelease(
    pollingOptions(async (url) => {
      if (url.endsWith("/healthz") && ++attempts === 1)
        return new Response("cold", { status: 503 });
      if (attempts === 2) return json({ status: "ok", release: OLD_SHA });
      return healthy(url);
    })
  );
  assert.equal(result.release, SHA);
  assert.equal(result.observedAt, "2026-11-13T20:00:00.020Z");
});

for (const failure of [
  "old-release",
  "database-unavailable",
  "wrong-html",
  "wrong-root-attribute",
  "wrong-content-type",
  "changed-release",
  "redirect",
  "network",
  "oversized",
]) {
  test(`unverified ${failure} never reports deployment success`, async () => {
    let healthCount = 0;
    const options = pollingOptions(async (url, request) => {
      assert.equal(new URL(url).origin, APP_URL);
      assert.equal(request.method, "GET");
      if (failure === "network") throw new Error(HOOK);
      if (failure === "redirect")
        return new Response(null, { status: 302, headers: { location: HOOK } });
      if (failure === "oversized") return new Response("x".repeat(300000));
      if (url.endsWith("/healthz")) {
        healthCount++;
        return json({
          status: "ok",
          release:
            failure === "old-release" || (failure === "changed-release" && healthCount % 2 === 0)
              ? OLD_SHA
              : SHA,
        });
      }
      if (failure === "database-unavailable" && url.endsWith("/readyz"))
        return json({ status: "unavailable" }, 503);
      if (failure === "wrong-html" && url === `${APP_URL}/`)
        return new Response("<html>error page</html>", {
          headers: { "content-type": "text/html" },
        });
      if (failure === "wrong-root-attribute" && url === `${APP_URL}/`)
        return new Response('<div data-id="root"></div>', {
          headers: { "content-type": "text/html" },
        });
      if (failure === "wrong-content-type" && url === `${APP_URL}/`)
        return new Response('<div id="root"></div>', {
          headers: { "content-type": "application/json" },
        });
      return healthy(url);
    });
    await assert.rejects(waitForRelease(options), (error) => {
      assert.match(error.message, /Release verification timed out/);
      assert.ok(!error.message.includes(HOOK));
      return true;
    });
  });
}

test("body streaming is bounded even without content-length", async () => {
  let calls = 0;
  await assert.rejects(
    triggerDeploy({
      hook: HOOK,
      sha: SHA,
      fetch: async () => {
        calls++;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(300000));
              controller.close();
            },
          })
        );
      },
    }),
    /Deploy request failed/
  );
  assert.equal(calls, 1);
});

test("polling deadline stops subsequent probes when transport uses up remaining time", async () => {
  const time = clock();
  let calls = 0;
  await assert.rejects(
    waitForRelease(
      pollingOptions(
        async () => {
          calls++;
          time.advance(100);
          return json({ status: "ok", release: SHA });
        },
        { ...time }
      )
    ),
    /Release verification timed out/
  );
  assert.equal(calls, 1);
});

test("invalid polling bounds are rejected before HTTP", async () => {
  let calls = 0;
  for (const options of [
    { timeoutMs: 0 },
    { timeoutMs: 1200001 },
    { intervalMs: 0 },
    { requestTimeoutMs: 0 },
  ]) {
    await assert.rejects(
      waitForRelease(
        pollingOptions(async () => {
          calls++;
        }, options)
      ),
      /Invalid verification/
    );
  }
  assert.equal(calls, 0);
});
