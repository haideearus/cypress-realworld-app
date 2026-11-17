const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const Module = require("node:module");
const path = require("node:path");
const { argsFor } = require("../factory/discovery-worker.cjs");
test(
  "pinned action parser preserves a genuinely empty builtin tool list",
  { skip: process.env.FACTORY_DISCOVERY_ACTION_TEST !== "true" },
  async () => {
    const url =
      "https://raw.githubusercontent.com/anthropics/claude-code-action/4fa93a88de49bbef68b10eb15aabedf28ca0e1ed/base-action/src/parse-sdk-options.ts";
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    assert.equal(response.ok, true);
    const source = await response.text();
    assert.equal(
      createHash("sha256").update(source).digest("hex"),
      "b42cc8daa1d15fb00321784cec375b1c855bb2e41bf03b37dfd462385f9e5548"
    );
    // Exercise the actual pinned parser without importing/calling its model runner.
    const js = require("typescript").transpileModule(source, {
      compilerOptions: {
        module: require("typescript").ModuleKind.CommonJS,
        target: require("typescript").ScriptTarget.ES2022,
      },
    }).outputText;
    const mod = new Module(path.join(__dirname, "offline-action-parser.cjs"), module);
    mod.paths = Module._nodeModulePaths(process.cwd());
    mod._compile(js, path.join(__dirname, "offline-action-parser.cjs"));
    const parsed = mod.exports.parseSdkOptions({
      claudeArgs: argsFor({ turns: 20 }, "/tmp/discovery/mcp.json"),
    }).sdkOptions;
    assert.equal(
      Object.hasOwn(parsed.extraArgs, "tools"),
      false,
      "bare --tools loses its required empty value"
    );
    assert.equal(
      Object.hasOwn(parsed.extraArgs, "tools="),
      true,
      "SDK passes --tools= as one complete CLI switch"
    );
    assert.equal(parsed.extraArgs["mcp-config"], "/tmp/discovery/mcp.json");
    assert.ok(parsed.allowedTools.every((t) => t.startsWith("mcp__discovery__")));
  }
);
