const test = require("node:test");
const assert = require("node:assert/strict");
const { buildArgs, promptFor } = require("../factory/worker.cjs");

test("feature implementation uses the existing app worker with no shell or vulnerability tools", () => {
  const args = buildArgs({ turns: 16 }, "code", false, false, true);
  assert.match(args, /--tools "Read,Glob,Grep,Edit,Write"/);
  assert.match(args, /--disallowedTools ".*Bash,PowerShell/);
  assert.doesNotMatch(args, /Bash\(/);
  assert.match(
    promptFor("code", "a".repeat(40), false, false, false, true),
    /feature acceptance criteria/
  );
});
