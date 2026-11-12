const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
let diagnostics;
try {
  diagnostics = require("../factory/diagnostics.cjs");
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}
const script = path.resolve(__dirname, "../factory/diagnostics.cjs");
const rawSecret = "SYNTHETIC-PRIVATE-VALUE-DO-NOT-RETAIN";
const result = (denials = []) => [
  {
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
    num_turns: 21,
    permission_denials: denials,
    errors: [rawSecret],
    result: rawSecret,
  },
];
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-diagnostics-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("factory-diagnostics-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
function run(dir) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { RUNNER_TEMP: dir },
  });
}
function readReport(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "factory-permission-denials.json"), "utf8"));
}
test("diagnostic reporter exists", () => assert.ok(diagnostics));
test("report uses fixed metadata and never copies raw tool inputs or transcript text", () => {
  const messages = [
    { type: "assistant", content: rawSecret },
    ...result([
      { tool_name: "Bash", tool_input: { command: "yarn test:unit:ci", secret: rawSecret } },
      { tool_name: "Bash", tool_input: { command: `yarn test:unit:ci -- ${rawSecret}` } },
      { tool_name: "Bash", tool_input: { command: `yarn lint && echo ${rawSecret}` } },
      { tool_name: "Read", tool_input: { file_path: `/private/${rawSecret}` } },
      { tool_name: rawSecret, tool_input: { command: rawSecret } },
      { tool_name: "Agent", tool_input: { prompt: rawSecret } },
      { tool_name: "PowerShell", tool_input: { command: `Get-Content ${rawSecret}` } },
    ]),
  ];
  const report = diagnostics.summarizeExecution(messages);
  assert.equal(report.kind, "factory-permission-diagnostics");
  assert.equal(report.status, "available");
  assert.equal(report.stopReason, "turn_limit");
  assert.equal(report.numTurns, 21);
  assert.equal(report.denialCount, 7);
  assert.deepEqual(report.denials, [
    { tool: "Bash", commandCategory: "unit_tests", commandForm: "exact" },
    { tool: "Bash", commandCategory: "unit_tests", commandForm: "with_arguments" },
    { tool: "Bash", commandCategory: "lint", commandForm: "compound_or_dynamic" },
    { tool: "Read", commandCategory: "not_shell", commandForm: "not_applicable" },
    { tool: "Other", commandCategory: "unknown", commandForm: "unknown" },
    { tool: "Agent", commandCategory: "not_shell", commandForm: "not_applicable" },
    { tool: "PowerShell", commandCategory: "other_shell", commandForm: "unknown" },
  ]);
  assert.ok(!JSON.stringify(report).includes(rawSecret));
  assert.ok(!JSON.stringify(report).includes("/private/"));
});
test("all permitted checks and a few other commands get descriptive categories only", () => {
  const commands = [
    "yarn types",
    "yarn lint",
    "yarn build:production",
    "yarn test:production",
    "git status --short",
    "yarn install",
    "pwd",
    `echo ${rawSecret}`,
  ];
  const report = diagnostics.summarizeExecution(
    result(
      commands.map((command) => ({
        tool_name: "Bash",
        tool_input: { command },
      }))
    )
  );
  assert.deepEqual(
    report.denials.map((d) => d.commandCategory),
    [
      "type_check",
      "lint",
      "production_build",
      "production_tests",
      "git_inspection",
      "dependency_installation",
      "filesystem_inspection",
      "other_shell",
    ]
  );
  assert.ok(!JSON.stringify(report).includes(rawSecret));
});
test("missing denial details are unknown rather than a fabricated zero", () => {
  const messages = result();
  delete messages[0].permission_denials;
  const report = diagnostics.summarizeExecution(messages);
  assert.equal(report.status, "unavailable");
  assert.equal(report.reason, "denials_missing");
  assert.equal(report.denialCount, null);
  assert.equal(diagnostics.summarizeExecution(result()).denialCount, 0);
  assert.equal(diagnostics.summarizeExecution([]).reason, "result_missing");
});
test("untrusted fields and excessive denial lists have bounded fixed output", () => {
  const messages = result(
    Array.from({ length: 101 }, () => ({
      tool_name: rawSecret,
      tool_input: { command: rawSecret },
    }))
  );
  messages[0].subtype = rawSecret;
  messages[0].num_turns = rawSecret;
  const report = diagnostics.summarizeExecution(messages);
  assert.equal(report.denialCount, 101);
  assert.equal(report.denials.length, 100);
  assert.equal(report.truncated, true);
  assert.equal(report.stopReason, "other_failure");
  assert.equal(report.numTurns, null);
  assert.ok(!JSON.stringify(report).includes(rawSecret));
  assert.equal(diagnostics.summarizeExecution({ result: rawSecret }).reason, "invalid_shape");
});
test("CLI writes only the sanitized report without any token or model access", (t) => {
  const dir = temp(t);
  fs.writeFileSync(
    path.join(dir, "claude-execution-output.json"),
    JSON.stringify(
      result([{ tool_name: "Bash", tool_input: { command: `git diff -- ${rawSecret}` } }])
    )
  );
  const processResult = run(dir);
  assert.equal(processResult.status, 0, processResult.stderr);
  const report = readReport(dir);
  assert.deepEqual(JSON.parse(processResult.stdout), report);
  assert.equal(report.denialCount, 1);
  assert.equal(report.denials[0].commandCategory, "git_inspection");
  assert.ok(!JSON.stringify(report).includes(rawSecret));
  assert.ok(!(processResult.stdout + processResult.stderr).includes(rawSecret));
  if (process.platform !== "win32")
    assert.equal(
      fs.statSync(path.join(dir, "factory-permission-denials.json")).mode & 0o777,
      0o600
    );
});
test("missing and malformed execution files produce explicit unavailable reports", (t) => {
  for (const input of [undefined, `invalid JSON ${rawSecret}`]) {
    const dir = temp(t);
    if (input !== undefined)
      fs.writeFileSync(path.join(dir, "claude-execution-output.json"), input);
    const processResult = run(dir);
    assert.equal(processResult.status, 0, processResult.stderr);
    const report = readReport(dir);
    assert.equal(report.reason, input === undefined ? "execution_missing" : "invalid_json");
    assert.equal(report.denialCount, null);
    assert.ok(
      !(JSON.stringify(report) + processResult.stdout + processResult.stderr).includes(rawSecret)
    );
  }
});
test("oversized execution data is refused without copying it into a report", (t) => {
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, "claude-execution-output.json"), "x".repeat(8 * 1024 * 1024 + 1));
  const processResult = run(dir);
  assert.equal(processResult.status, 0, processResult.stderr);
  assert.equal(readReport(dir).reason, "execution_too_large");
});
test("an existing report is never overwritten or passed off as sanitized", (t) => {
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, "factory-permission-denials.json"), rawSecret);
  const processResult = run(dir);
  assert.equal(processResult.status, 1);
  assert.equal(processResult.stderr.trim(), "Permission diagnostics could not be written.");
  assert.equal(
    fs.readFileSync(path.join(dir, "factory-permission-denials.json"), "utf8"),
    rawSecret
  );
  assert.ok(!(processResult.stdout + processResult.stderr).includes(rawSecret));
});
test("a directory at the execution filename is unsafe", (t) => {
  const dir = temp(t);
  fs.mkdirSync(path.join(dir, "claude-execution-output.json"));
  const processResult = run(dir);
  assert.equal(processResult.status, 0, processResult.stderr);
  assert.equal(readReport(dir).reason, "execution_unsafe");
});
test("symlinked execution input is reported unsafe", (t) => {
  const dir = temp(t);
  const target = path.join(dir, "private.json");
  fs.writeFileSync(target, JSON.stringify(result()));
  try {
    fs.symlinkSync(target, path.join(dir, "claude-execution-output.json"));
  } catch (error) {
    if (error.code === "EPERM")
      return t.skip("File symlinks require Windows privileges; Linux CI covers this");
    throw error;
  }
  const processResult = run(dir);
  assert.equal(processResult.status, 0, processResult.stderr);
  assert.equal(readReport(dir).reason, "execution_unsafe");
});
