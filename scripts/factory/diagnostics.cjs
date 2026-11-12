const fs = require("node:fs");
const path = require("node:path");

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_DENIALS = 100;
const INPUT_FILE = "claude-execution-output.json";
const OUTPUT_FILE = "factory-permission-denials.json";
const TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "Bash",
  "PowerShell",
  "NotebookEdit",
  "Agent",
  "Task",
  "TaskOutput",
  "TaskStop",
  "WebFetch",
  "WebSearch",
]);
const COMMANDS = [
  ["yarn types", "type_check"],
  ["yarn lint", "lint"],
  ["yarn test:unit:ci", "unit_tests"],
  ["yarn build:production", "production_build"],
  ["yarn test:production", "production_tests"],
  ...["git status", "git diff", "git show", "git log"].map((c) => [c, "git_inspection"]),
  ...["yarn install", "npm install", "pnpm install", "yarn add", "npm add", "pnpm add"].map((c) => [
    c,
    "dependency_installation",
  ]),
  ...["pwd", "ls"].map((c) => [c, "filesystem_inspection"]),
];
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
function unavailable(reason) {
  return {
    kind: "factory-permission-diagnostics",
    version: 1,
    status: "unavailable",
    reason,
    stopReason: "unknown",
    numTurns: null,
    denialCount: null,
    denials: [],
    truncated: false,
  };
}
// Classification describes a command; it never grants permission or emits its text.
function commandInfo(command) {
  if (typeof command !== "string" || command.length > 16384)
    return { commandCategory: "other_shell", commandForm: "unknown" };
  const text = command.trim();
  const matched = COMMANDS.find(
    ([prefix]) =>
      text === prefix || [" ", "\t", "\n", "\r"].some((space) => text.startsWith(prefix + space))
  );
  const dynamic = /[\r\n;&|<>`$]/.test(text);
  return {
    commandCategory: matched ? matched[1] : "other_shell",
    commandForm: dynamic
      ? "compound_or_dynamic"
      : !matched
        ? "unknown"
        : text === matched[0]
          ? "exact"
          : "with_arguments",
  };
}
function summarizeExecution(messages) {
  if (!Array.isArray(messages)) return unavailable("invalid_shape");
  let result;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (record(messages[index]) && messages[index].type === "result") {
      result = messages[index];
      break;
    }
  }
  if (!result) return unavailable("result_missing");
  const report = unavailable("denials_missing");
  report.stopReason =
    result.subtype === "error_max_turns"
      ? "turn_limit"
      : result.subtype === "success" && result.is_error === false
        ? "completed"
        : "other_failure";
  if (
    Number.isSafeInteger(result.num_turns) &&
    result.num_turns >= 0 &&
    result.num_turns <= 1000000
  )
    report.numTurns = result.num_turns;
  if (!Array.isArray(result.permission_denials)) {
    if (result.permission_denials !== undefined) report.reason = "denials_invalid";
    return report;
  }
  report.status = "available";
  report.reason = "ok";
  report.denialCount = result.permission_denials.length;
  report.truncated = report.denialCount > MAX_DENIALS;
  report.denials = result.permission_denials.slice(0, MAX_DENIALS).map((denial) => {
    const tool = record(denial) && TOOLS.has(denial.tool_name) ? denial.tool_name : "Other";
    if (tool === "Bash" || tool === "PowerShell")
      return { tool, ...commandInfo(denial.tool_input?.command) };
    return {
      tool,
      commandCategory: tool === "Other" ? "unknown" : "not_shell",
      commandForm: tool === "Other" ? "unknown" : "not_applicable",
    };
  });
  return report;
}
function readExecution(runnerTemp) {
  const input = path.join(runnerTemp, INPUT_FILE);
  let fd;
  try {
    const before = fs.lstatSync(input);
    if (!before.isFile() || before.isSymbolicLink()) return unavailable("execution_unsafe");
    if (before.size > MAX_INPUT_BYTES) return unavailable("execution_too_large");
    fd = fs.openSync(
      input,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return unavailable("execution_unsafe");
    if (stat.size > MAX_INPUT_BYTES) return unavailable("execution_too_large");
    // Bound the read itself, even if another process grows the file after stat.
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const bytes = fs.readSync(fd, buffer, count, buffer.length - count, null);
      if (!bytes) break;
      count += bytes;
    }
    if (count > MAX_INPUT_BYTES) return unavailable("execution_too_large");
    let messages;
    try {
      messages = JSON.parse(buffer.subarray(0, count).toString("utf8"));
    } catch {
      return unavailable("invalid_json");
    }
    return summarizeExecution(messages);
  } catch (error) {
    return unavailable(
      error.code === "ENOENT"
        ? "execution_missing"
        : error.code === "ELOOP"
          ? "execution_unsafe"
          : "execution_unreadable"
    );
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function main(env = process.env) {
  const runnerTemp = env.RUNNER_TEMP;
  if (!runnerTemp || !path.isAbsolute(runnerTemp)) throw new Error("Invalid diagnostic directory");
  const dir = fs.lstatSync(runnerTemp);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error("Invalid diagnostic directory");
  const report = readExecution(runnerTemp);
  const fd = fs.openSync(
    path.join(runnerTemp, OUTPUT_FILE),
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW || 0),
    0o600
  );
  try {
    fs.writeFileSync(fd, JSON.stringify(report, null, 2) + "\n");
  } finally {
    fs.closeSync(fd);
  }
  // Only the newly constructed fixed-schema report is logged, never input/error text.
  console.log(JSON.stringify(report, null, 2));
  return report;
}
if (require.main === module) {
  try {
    main();
  } catch {
    console.error("Permission diagnostics could not be written.");
    process.exitCode = 1;
  }
}
module.exports = { summarizeExecution, main };
