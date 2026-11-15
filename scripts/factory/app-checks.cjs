const { assertSubscriptionEnv } = require("./policy.cjs");
const { assertMonitorContext } = require("./monitor.cjs");
const { credentials, probeUserJourney } = require("./app-checks-probe.cjs");
const {
  appChecksEnabled,
  monitorContext,
  makeReport,
  writeReport,
} = require("./app-checks-contract.cjs");
async function main(
  env = process.env,
  {
    probe = probeUserJourney,
    now = () => new Date().toISOString(),
    log = (value) => console.log(JSON.stringify(value)),
  } = {}
) {
  try {
    const context = monitorContext(env);
    assertMonitorContext(context);
    if (!appChecksEnabled(env.FACTORY_APP_CHECKS_ENABLED)) {
      const result = { outcome: "disabled" };
      log(result);
      return result;
    }
    assertSubscriptionEnv(env);
    if (
      [
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "FACTORY_GITHUB_APP_PRIVATE_KEY",
        "RENDER_DEPLOY_HOOK_URL",
      ].some((key) => env[key])
    )
      throw Error("Unrelated credentials are forbidden");
    credentials(env.FACTORY_MONITOR_USERNAME, env.FACTORY_MONITOR_PASSWORD);
    const feedContract = appChecksEnabled(env.FACTORY_FEED_CONTRACT_CHECK_ENABLED);
    const checked = await probe({
      username: env.FACTORY_MONITOR_USERNAME,
      password: env.FACTORY_MONITOR_PASSWORD,
      feedContract,
    });
    if (Object.hasOwn(checked, "feedContract") !== feedContract) throw Error("Probe mode mismatch");
    const report = makeReport(checked, context, now());
    writeReport(env, report);
    const result = { outcome: "checked", result: report.result };
    log(result);
    return result;
  } catch {
    throw Error(
      "App checks failed; verify configuration. No credentials or response data are logged."
    );
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { main };
