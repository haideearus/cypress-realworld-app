const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtempSync, writeFileSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { execFileSync } = require("node:child_process");

test("private local environment wins over defaults while explicit process values survive", () => {
  const directory = mkdtempSync(join(tmpdir(), "rwa-env-test-"));
  writeFileSync(
    join(directory, ".env"),
    "NEON_ENV_TEST_VALUE=default\nNEON_ENV_TEST_DEFAULT=kept\nNEON_ENV_TEST_EXPLICIT=file\n"
  );
  writeFileSync(
    join(directory, ".env.local"),
    "NEON_ENV_TEST_VALUE=private\nNEON_ENV_TEST_EXPLICIT=private-file\n"
  );
  const compiled = resolve("dist/server/backend/environment.js");
  const entry = existsSync(compiled) ? compiled : require.resolve("dotenv/config");
  const output = execFileSync(
    process.execPath,
    [
      "-e",
      `require(${JSON.stringify(entry)}); console.log(JSON.stringify([process.env.NEON_ENV_TEST_VALUE,process.env.NEON_ENV_TEST_DEFAULT,process.env.NEON_ENV_TEST_EXPLICIT]));`,
    ],
    {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, NEON_ENV_TEST_EXPLICIT: "process" },
    }
  );
  assert.deepEqual(JSON.parse(output), ["private", "kept", "process"]);
});
