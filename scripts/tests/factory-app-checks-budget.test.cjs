const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
test("app-check phases reserve publisher and setup time inside the existing eight-minute job", () => {
  const { phaseBudgets } = require("../factory/app-checks-budget.cjs");
  const b = phaseBudgets();
  assert.equal(b.journey, 212000);
  assert.equal(b.availability, 152000);
  assert.equal(b.scanner, 30000);
  assert.equal(b.publication, 60000);
  assert.ok(b.setup >= 26000);
  assert.ok(Object.values(b).reduce((sum, n) => sum + n, 0) <= 480000);
});
test("scanner install and scanning share a single thirty-second deadline with no credential environment", () => {
  const { scanReport } = require("../factory/app-checks-scan.cjs");
  let elapsed = 0;
  const calls = [];
  scanReport(
    { RUNNER_TEMP: os.tmpdir(), GITHUB_RUN_ID: "900", GITHUB_RUN_ATTEMPT: "1" },
    {
      clock: () => elapsed,
      run: (binary, args, opts) => {
        calls.push({ binary, args, opts });
        elapsed += calls.length === 1 ? 22000 : 7000;
      },
    }
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.timeout, 30000);
  assert.equal(calls[1].opts.timeout, 8000);
  assert.ok(calls[0].args[0].endsWith("scanner-install.cjs"));
  assert.ok(calls[1].args[0].endsWith("secret-scan.cjs"));
  assert.equal(calls[0].opts.stdio, "pipe");
  assert.ok(
    !Object.keys(calls[1].opts.env).some((k) => /TOKEN|SECRET|PASSWORD|USERNAME|API_KEY/.test(k))
  );
  let count = 0;
  elapsed = 0;
  assert.throws(
    () =>
      scanReport(
        { RUNNER_TEMP: os.tmpdir(), GITHUB_RUN_ID: "900", GITHUB_RUN_ATTEMPT: "1" },
        {
          clock: () => elapsed,
          run: () => {
            count++;
            elapsed = 30001;
          },
        }
      ),
    /scan|deadline/i
  );
  assert.equal(count, 1);
});
test("enabled app checks bound all publication HTTP calls to one shared sixty-second phase", async () => {
  const { publisherFetch } = require("../factory/app-checks-budget.cjs");
  let elapsed = 0;
  const calls = [];
  const fetch = publisherFetch(
    async (url, options) => {
      calls.push(options);
      return new Response("{}");
    },
    () => elapsed
  );
  await fetch("https://api.github.com/fixture", { method: "GET" });
  elapsed = 59000;
  await fetch("https://api.github.com/fixture", { method: "POST" });
  assert.ok(calls[0].signal instanceof AbortSignal);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(calls[1].signal.aborted, true);
  elapsed = 60000;
  await assert.rejects(() => fetch("https://api.github.com/fixture", {}), /publication|deadline/i);
  assert.equal(calls.length, 2);
});
