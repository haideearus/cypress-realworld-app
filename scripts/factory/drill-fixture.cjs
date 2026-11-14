const { DRILL_PATH, DRILL_TEST_PATH } = require("./drill-contract.cjs");

// These strings are seeded only on the unique rehearsal branch. No application
// module on main imports this intentionally broken readiness implementation.
const brokenSource = `module.exports = function readiness(available) {
  return {
    statusCode: available === true ? 200 : 503,
    body: { status: available === true ? "unavailable" : "unavailable" },
  };
};
`;

const regressionSource = `import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const readiness = require("../../backend/factory-drill/readiness.cjs");

describe("isolated readiness contract", () => {
  it("reports ready when the dependency is available", () => {
    expect(readiness(true)).toEqual({ statusCode: 200, body: { status: "ok" } });
  });
  it.each([false, undefined])("fails closed for an unavailable dependency: %s", (available) => {
    expect(readiness(available)).toEqual({ statusCode: 503, body: { status: "unavailable" } });
  });
});
`;

// The release is the only substituted value and is validated before execution.
function serverSource(release) {
  if (typeof release !== "string" || !/^[a-f0-9]{40}$/.test(release))
    throw new Error("Invalid fixture release");
  return `const http = require("node:http");
// Retain the wrapper's operations before loading generated code. The independent
// root oracle remains the trust boundary; these captures also prevent ordinary
// global monkeypatches from changing the measured function contract.
const createServer = http.createServer;
const stringify = JSON.stringify;
const ownKeys = Reflect.ownKeys;
const hasOwn = Object.hasOwn;
const isArray = Array.isArray;
const URLConstructor = URL;
const readiness = require("/candidate/readiness.cjs");
createServer((req, res) => {
  const url = new URLConstructor(req.url, "http://127.0.0.1:18765");
  if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
  if (url.pathname === "/healthz") {
    res.writeHead(200, {"content-type": "application/json"});
    res.end(stringify({status: "ok", release: ${JSON.stringify(release)}}));
  } else if (url.pathname === "/readyz") {
    const dependency = url.searchParams.get("dependency");
    const available = dependency === "timeout" ? undefined : dependency !== "unavailable";
    try {
      const result = readiness(available);
      if (result === null || typeof result !== "object" || isArray(result) ||
          ownKeys(result).length !== 2 || !hasOwn(result, "statusCode") || !hasOwn(result, "body")) {
        res.writeHead(500); res.end(); return;
      }
      const body = result.body;
      const statusCode = result.statusCode;
      if (body === null || typeof body !== "object" || isArray(body) ||
          ownKeys(body).length !== 1 || !hasOwn(body, "status")) {
        res.writeHead(500); res.end(); return;
      }
      const status = body.status;
      if (statusCode !== (available === true ? 200 : 503) ||
          status !== (available === true ? "ok" : "unavailable")) {
        res.writeHead(500); res.end(); return;
      }
      res.writeHead(statusCode, {"content-type": "application/json"});
      res.end(stringify({status}));
    } catch { res.writeHead(500); res.end(); }
  } else if (url.pathname === "/") {
    res.writeHead(200, {"content-type": "text/html"});
    res.end('<!doctype html><html><body><main id="root">Synthetic drill</main></body></html>');
  } else { res.writeHead(404); res.end(); }
}).listen(18765, "127.0.0.1");
`;
}

module.exports = {
  implementationPath: DRILL_PATH,
  regressionPath: DRILL_TEST_PATH,
  brokenSource,
  regressionSource,
  serverSource,
};
