const fs = require("node:fs");
const { GitHub, ROOT } = require("./github.cjs");
const { runtimeContext, output } = require("./controller.cjs");
const { assertSubscriptionEnv } = require("./policy.cjs");
const { WakeStore } = require("./wake-store.cjs");
const { handleWake, verifyProducer } = require("./wake-controller.cjs");
async function main(env = process.env) {
  assertSubscriptionEnv(env);
  const context = runtimeContext(env),
    vars = JSON.parse(env.FACTORY_VARIABLES || "{}");
  const stat = fs.lstatSync(env.GITHUB_EVENT_PATH);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2000000)
    throw Error("Invalid wake event file");
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8")),
    inputs = event.inputs || {};
  const api = new GitHub({ token: env.GITHUB_TOKEN });
  const preview = inputs.preview === true || inputs.preview === "true";
  let result;
  if (context.event === "workflow_dispatch") {
    if (context.actor !== "haideearus" || context.triggeringActor !== "haideearus")
      throw Error("Only owner may initialize or preview wake metadata");
    await verifyProducer(api, context);
    if (inputs.operation === "initialize") {
      if (preview) result = { outcome: "initialization_preview", modelCalls: 0 };
      else {
        await new WakeStore(api).initialize();
        result = { outcome: "initialized", modelCalls: 0 };
      }
    } else {
      if (!preview) throw Error("Manual wake inspection is preview-only");
      const issue = Number(inputs.issue);
      if (!Number.isSafeInteger(issue) || issue < 1)
        throw Error("Preview requires an issue number");
      // Inspection only: never turn a synthetic manual event into live authorization.
      const actual = await api.request("GET", `${ROOT}/issues/${issue}`);
      const eligible = require("./automation.cjs").eligibleIssue(actual);
      result = { outcome: "preview", issue, eligible, modelCalls: 0 };
    }
  } else result = await handleWake({ api, context, event, vars });
  output(result, env);
  console.log(JSON.stringify(result));
  return result;
}
if (require.main === module)
  main().catch(() => {
    console.error(
      "Event wake held; inspect trusted source and retained receipt. No dispatch was retried."
    );
    process.exitCode = 1;
  });
module.exports = { main };
