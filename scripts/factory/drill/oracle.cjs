const fs = require("node:fs");
const { probeApp } = require("../monitor-probe.cjs");
const { APP_URL } = require("../deploy-render.cjs");

function createLoopbackFetch(fetch = globalThis.fetch) {
  const destinations = new Map(
    ["/healthz", "/readyz", "/"].map((route) => [
      `${APP_URL}${route}`,
      `http://127.0.0.1:18765${route}`,
    ])
  );
  return async (url, options = {}) => {
    if (!destinations.has(url) || options.method !== "GET")
      throw new Error("Forbidden drill probe destination or method");
    return fetch(destinations.get(url), {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      signal: options.signal,
      headers: { Accept: "application/json, text/html", "Cache-Control": "no-cache" },
    });
  };
}

async function observeFixture({ release, fetch = globalThis.fetch }) {
  // Poll only for process startup. A readiness failure must remain observable.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:18765/healthz", {
        redirect: "error",
        signal: AbortSignal.timeout(300),
      });
      await response.body?.cancel();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const observed = await probeApp({
    fetch: createLoopbackFetch(fetch),
    attempts: 1,
    requestTimeoutMs: 1000,
  });
  const regression = await Promise.all(
    [
      ["/readyz", 200, "ok"],
      ["/readyz?dependency=ready", 200, "ok"],
      ["/readyz?dependency=unavailable", 503, "unavailable"],
      ["/readyz?dependency=timeout", 503, "unavailable"],
    ].map(async ([route, status, bodyStatus]) => {
      let reader;
      try {
        const response = await fetch(`http://127.0.0.1:18765${route}`, {
          method: "GET",
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(1000),
        });
        if (
          response.status !== status ||
          !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "")
        )
          return false;
        reader = response.body?.getReader();
        if (!reader) return false;
        const chunks = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8192) return false;
          chunks.push(Buffer.from(value));
        }
        const body = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
        return body?.status === bodyStatus && Object.keys(body).join(",") === "status";
      } catch {
        return false;
      } finally {
        if (reader) void reader.cancel().catch(() => {});
      }
    })
  );
  if (observed.release !== release) observed.checks.health = "failed";
  const checks = { ...observed.checks, regression: regression.every(Boolean) ? "ok" : "failed" };
  return {
    healthy: Object.values(checks).every((value) => value === "ok"),
    checks,
    attempts: 1,
    ...(checks.health === "ok" ? { release } : {}),
  };
}

function oracleSource(release) {
  if (typeof release !== "string" || !/^[a-f0-9]{40}$/.test(release))
    throw new Error("Invalid fixture release");
  // Execute the exact production probe implementation with only its fixed URL
  // dependency supplied. All code here comes from the trusted workflow checkout.
  const probeSource = fs.readFileSync(require.resolve("../monitor-probe.cjs"), "utf8");
  return `"use strict";
const APP_URL = ${JSON.stringify(APP_URL)};
const { probeApp } = (() => {
  const module = {exports: {}};
  const require = (name) => {
    if (name !== "./deploy-render.cjs") throw new Error("Unexpected trusted probe dependency");
    return { APP_URL: ${JSON.stringify(APP_URL)} };
  };
  ${probeSource}
  return module.exports;
})();
const createLoopbackFetch = ${createLoopbackFetch.toString()};
const observeFixture = ${observeFixture.toString()};
observeFixture({release: ${JSON.stringify(release)}}).then(
  (result) => process.stdout.write(JSON.stringify(result)),
  () => { process.exitCode = 1; }
);
`;
}

module.exports = { createLoopbackFetch, observeFixture, oracleSource };
