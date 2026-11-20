const { assertSubscriptionEnv } = require("./policy.cjs");
const {
  credentials,
  probeUserJourney,
  readPublicRelease,
  pause,
} = require("./app-checks-probe.cjs");
const { monitorContext } = require("./app-checks-contract.cjs");
const {
  requireAck,
  assertAckContext,
  validateAckResult,
  makeAckReport,
  writeAckReport,
} = require("./monitor-ack-contract.cjs");
async function probeAckJourney({
  username,
  password,
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  blockedRepair = false,
} = {}) {
  credentials(username, password);
  requireAck(
    typeof fetch === "function" && typeof sleep === "function" && typeof blockedRepair === "boolean"
  );
  if (blockedRepair)
    return probeUserJourney({ username, password, fetch, sleep, feedContract: true });
  for (let attempts = 1; attempts <= 3; attempts++) {
    const before = await readPublicRelease(fetch, 6000);
    let checks = { login: "failed", session: "failed", feed: "failed", logout: "failed" };
    if (before) {
      const r = await probeUserJourney({
        username,
        password,
        fetch,
        sleep,
        attempts: 1,
        requestTimeoutMs: 6000,
        feedContract: false,
      });
      checks = r.checks;
    }
    const after = await readPublicRelease(fetch, 6000);
    const result = validateAckResult({
      healthy:
        Object.values(checks).every((v) => v === "ok") && before !== null && before === after,
      checks,
      attempts,
      releases: { before, after },
    });
    if (result.healthy || attempts === 3 || !(await pause(sleep))) return result;
  }
}
async function main(
  env = process.env,
  { probe = probeAckJourney, now = () => new Date().toISOString() } = {}
) {
  const context = monitorContext(env);
  assertAckContext(context);
  assertSubscriptionEnv(env);
  requireAck([undefined, "true", "false"].includes(env.ACK_BLOCKED_REPAIR));
  const blockedRepair = env.ACK_BLOCKED_REPAIR === "true";
  requireAck(
    ![
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "FACTORY_GITHUB_APP_PRIVATE_KEY",
      "RENDER_DEPLOY_HOOK_URL",
    ].some((k) => env[k])
  );
  const result = await probe({
    username: env.FACTORY_MONITOR_USERNAME,
    password: env.FACTORY_MONITOR_PASSWORD,
    blockedRepair,
  });
  const report = makeAckReport(result, context, now(), blockedRepair);
  writeAckReport(env, report, context, blockedRepair);
  console.log(
    JSON.stringify({
      outcome: "checked",
      scope: blockedRepair ? "feed-contract" : "standard-only",
      result,
    })
  );
  return report;
}
if (require.main === module)
  main().catch(() => {
    console.error("Acknowledgment check failed; no response or credential data logged");
    process.exitCode = 1;
  });
module.exports = { probeAckJourney, main };
