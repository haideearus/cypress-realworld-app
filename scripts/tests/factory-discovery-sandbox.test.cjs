const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const s = require("../factory/discovery-sandbox.cjs");
test("runtime containers have no public network, host secrets, writable source or socket mounts", () => {
  const args = s.containerArgs({
    name: "discovery-abc",
    network: "discovery-net",
    image: "sha256:" + "a".repeat(64),
    role: "test",
    testDir: "/tmp/tests",
    mode: "api",
    file: "case.api.test.cjs",
  });
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--cap-drop"));
  assert.ok(args.includes("no-new-privileges=true"));
  assert.ok(!args.includes("--privileged"));
  assert.ok(!args.includes("--network=host"));
  assert.ok(!args.join(" ").includes("docker.sock"));
  assert.ok(args.join(" ").includes("target=/proposals,readonly"));
  assert.throws(
    () => s.containerArgs({ name: "x", network: "host", image: "node:latest", role: "test" }),
    /Invalid/
  );
  const env = s.safeEnv({
    PATH: "safe",
    GH_TOKEN: "secret",
    CLAUDE_CODE_OAUTH_TOKEN: "secret",
    DATABASE_URL: "production",
    HTTP_PROXY: "proxy",
  });
  assert.deepEqual(env, { PATH: "safe" });
});
test("batch budget is consumed before execution and never accepts shell commands or a fifth batch", async () => {
  let executed = 0;
  const b = new s.BatchBudget(async (r) => {
    executed++;
    return r;
  });
  for (let i = 0; i < 4; i++) await b.run({ mode: "api", file: "case.api.test.cjs" });
  await assert.rejects(b.run({ mode: "api", file: "case.api.test.cjs" }), /batch limit/);
  assert.equal(executed, 4);
  await assert.rejects(
    new s.BatchBudget(async () => {}).run({ mode: "shell", file: "x; curl evil" }),
    /Invalid/
  );
  await assert.rejects(
    new s.BatchBudget(async () => {}).run({
      mode: "api",
      file: "case.api.test.cjs",
      timeout: 301000,
    }),
    /Invalid/
  );
});
test("broker output validation rejects application writes, traversal and symlinked proposals", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "discovery-path-test-"));
  try {
    fs.mkdirSync(path.join(root, "tests"));
    fs.writeFileSync(path.join(root, "tests", "a.api.test.cjs"), "test");
    assert.ok(s.regularProposal(root, "tests/a.api.test.cjs"));
    for (const n of ["backend/app.ts", "package.json", "../x", "tests/../../x", "tests/x.sh"])
      assert.throws(() => s.regularProposal(root, n), /Invalid/);
    fs.mkdirSync(path.join(root, "actual"));
    fs.symlinkSync(path.join(root, "actual"), path.join(root, "alias"), "junction");
    fs.renameSync(path.join(root, "tests"), path.join(root, "original-tests"));
    fs.symlinkSync(path.join(root, "original-tests"), path.join(root, "tests"), "junction");
    assert.throws(() => s.regularProposal(root, "tests/a.api.test.cjs"), /regular|symlink/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
