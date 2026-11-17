const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBroker } = require("../factory/discovery-broker.cjs");
const { digest } = require("../factory/discovery-contract.cjs");
test("model tools can read only the frozen source manifest and write only new test/report output", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "discovery-broker-"));
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  fs.mkdirSync(source);
  fs.mkdirSync(output);
  fs.mkdirSync(path.join(source, "src"));
  fs.writeFileSync(path.join(source, "src", "a.ts"), "export const a=1;");
  try {
    const broker = createBroker({
      root,
      source,
      output,
      manifest: { "src/a.ts": digest("export const a=1;") },
      identity: { head: "a".repeat(40), grantId: "x" },
      execute: async () => ({ code: 1, log: "assertion failed" }),
    });
    assert.equal(
      (await broker.call("read_source", { path: "src/a.ts" })).text,
      "export const a=1;"
    );
    for (const file of ["../../.env", ".git/config", "/proc/self/environ"])
      await assert.rejects(broker.call("read_source", { path: file }));
    await assert.rejects(broker.call("write_test", { file: "backend/app.ts", content: "evil" }));
    await assert.rejects(broker.call("Bash", { command: "curl evil" }));
    await broker.call("write_test", {
      file: "a.api.test.cjs",
      content: "require('node:assert').fail('example')",
    });
    await broker.call("run_batch", { mode: "api", file: "a.api.test.cjs" });
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, "batch-1.json"), "utf8")).testHash,
      digest("require('node:assert').fail('example')")
    );
    assert.equal(fs.readFileSync(path.join(source, "src", "a.ts"), "utf8"), "export const a=1;");
    fs.writeFileSync(path.join(source, "src", "a.ts"), "changed");
    await assert.rejects(broker.call("read_source", { path: "src/a.ts" }), /changed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
