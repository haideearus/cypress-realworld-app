const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { safeEnvironment } = require("./scanner-install.cjs");
const { reportPath } = require("./app-checks-contract.cjs");
const { LIMITS } = require("./app-checks-budget.cjs");
function scanReport(
  env = process.env,
  { run = execFileSync, clock = () => performance.now() } = {}
) {
  const file = reportPath(env),
    deadline = clock() + LIMITS.scanner;
  for (const args of [
    [path.join(__dirname, "scanner-install.cjs")],
    [path.join(__dirname, "secret-scan.cjs"), "file", file],
  ]) {
    const remaining = Math.floor(deadline - clock());
    if (remaining < 1) throw Error("App report scanner deadline reached");
    run(process.execPath, args, {
      timeout: remaining,
      stdio: "pipe",
      maxBuffer: 200000,
      windowsHide: true,
      env: safeEnvironment(),
    });
  }
  if (clock() > deadline) throw Error("App report scanner deadline reached");
}
if (require.main === module) {
  try {
    scanReport();
    console.log("Credential-free app report scan passed");
  } catch {
    console.error("App report scan failed or exceeded its deadline; publication stopped");
    process.exitCode = 1;
  }
}
module.exports = { scanReport };
