const test = require("node:test");
const assert = require("node:assert/strict");
test("runtime can find prepared Yarn and browser app/API share only the disposable namespace", () => {
  const runtime = require("../factory/discovery/runtime.cjs");
  assert.equal(runtime.environment("a".repeat(40)).COREPACK_HOME, "/opt/corepack");
  assert.equal(runtime.cypressConfig().e2e.baseUrl, "http://localhost:3000");
  assert.equal(runtime.cypressConfig().env.apiUrl, "http://localhost:3001");
  const args = require("../factory/discovery-sandbox.cjs").containerArgs({
    name: "discovery-test-1",
    network: "discovery-net",
    appName: "discovery-app-1",
    image: "sha256:" + "a".repeat(64),
    role: "test",
    testDir: "/tmp/tests",
    mode: "cypress",
    file: "login.cy.ts",
  });
  assert.equal(args[args.indexOf("--network") + 1], "container:discovery-app-1");
  assert.throws(
    () =>
      require("../factory/discovery-sandbox.cjs").containerArgs({
        name: "discovery-test-1",
        network: "discovery-net",
        appName: "host",
        image: "sha256:" + "a".repeat(64),
        role: "test",
        testDir: "/tmp/tests",
        mode: "cypress",
        file: "login.cy.ts",
      }),
    /Invalid/
  );
});
