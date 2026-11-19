const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBroker } = require("../factory/discovery-broker.cjs");
const { digest } = require("../factory/discovery-contract.cjs");
const functional = require("../factory/discovery-functional.cjs");
const charter = "functional-feed";
const oracle = {
  kind: "feed-pagination",
  route: "/transactions/public",
  authenticated: true,
  query: { page: 2, limit: 5 },
};
test("broker reconnection cannot execute a fifth batch and a crashed batch stays consumed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "discovery-restart-"));
  const source = path.join(root, "source"),
    out = path.join(root, "output");
  fs.mkdirSync(source);
  fs.mkdirSync(out);
  let calls = 0;
  const execute = async () => {
    calls++;
    throw Error("lost execution result");
  };
  const options = {
    root,
    source,
    output: out,
    manifest: {},
    identity: { head: "a".repeat(40), grantId: "offline" },
    charter,
    execute,
  };
  try {
    const first = createBroker(options);
    await first.call("write_test", { file: "a.api.test.cjs", oracle });
    for (let i = 0; i < 4; i++)
      await assert.rejects(
        createBroker(options).call("run_batch", { mode: "api", file: "a.api.test.cjs" })
      );
    await assert.rejects(
      createBroker(options).call("run_batch", { mode: "api", file: "a.api.test.cjs" }),
      /batch limit/
    );
    assert.equal(calls, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("model tools can read only the frozen source manifest and write only new test/report output", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "discovery-broker-"));
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  fs.mkdirSync(source);
  fs.mkdirSync(output);
  const readable = "src/components/TransactionList.tsx";
  fs.mkdirSync(path.join(source, "src", "components"), { recursive: true });
  fs.writeFileSync(path.join(source, readable), "export const a=1;");
  fs.writeFileSync(path.join(source, "src", "other.ts"), "outside scope");
  try {
    const broker = createBroker({
      root,
      source,
      output,
      manifest: {
        [readable]: digest("export const a=1;"),
        "src/other.ts": digest("outside scope"),
      },
      identity: { head: "a".repeat(40), grantId: "x" },
      charter,
      execute: async () => ({ code: 1, log: "assertion failed" }),
    });
    assert.equal((await broker.call("read_source", { path: readable })).text, "export const a=1;");
    for (const file of ["../../.env", ".git/config", "/proc/self/environ", "src/other.ts"])
      await assert.rejects(broker.call("read_source", { path: file }));
    await assert.rejects(broker.call("write_test", { file: "backend/app.ts", content: "evil" }));
    await assert.rejects(broker.call("Bash", { command: "curl evil" }));
    await broker.call("write_test", {
      file: "a.api.test.cjs",
      oracle,
    });
    await broker.call("run_batch", { mode: "api", file: "a.api.test.cjs" });
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, "batch-1.json"), "utf8")).testHash,
      digest(functional.proposal(charter, oracle))
    );
    assert.equal(fs.readFileSync(path.join(source, readable), "utf8"), "export const a=1;");
    fs.writeFileSync(path.join(source, readable), "changed");
    await assert.rejects(broker.call("read_source", { path: readable }), /changed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
