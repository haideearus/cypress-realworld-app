const fs = require("node:fs");
const path = require("node:path");
const policy = require("./policy.cjs");
const { GitHub, ROOT } = require("./github.cjs");
const { runtimeContext, output, readJson } = require("./controller.cjs");
const { DependencyCoordinator, DependencyMerger, expectedReport } = require("./dependencies.cjs");
const {
  inspectUpdate,
  queryOsv,
  reportFor,
  validateReport,
  toolsAt,
} = require("./dependency-analysis.cjs");

async function content(api, ref, file) {
  if (!policy.SHA.test(ref) || !["package.json", "yarn.lock"].includes(file))
    throw new Error("Invalid dependency source");
  const max = file === "package.json" ? 65536 : 2097152;
  const r = await api.request("GET", `${ROOT}/contents/${file}?ref=${ref}`);
  if (
    r.type !== "file" ||
    r.path !== file ||
    r.encoding !== "base64" ||
    !Number.isSafeInteger(r.size) ||
    r.size < 1 ||
    r.size > max ||
    typeof r.content !== "string" ||
    r.content.length > Math.ceil(max * 1.4)
  )
    throw new Error("Dependency file exceeds source boundary");
  const bytes = Buffer.from(r.content.replace(/\n/g, ""), "base64");
  const text = bytes.toString("utf8");
  if (bytes.length !== r.size || !Buffer.from(text, "utf8").equals(bytes) || text.includes("\0"))
    throw new Error("Invalid dependency source encoding");
  return text;
}
async function analyze(coordinator, number, stage, { transport = fetch } = {}) {
  if (!["analysis", "premerge"].includes(stage)) throw new Error("Invalid dependency stage");
  const t = await coordinator.ticket(number, stage === "analysis");
  if (
    !coordinator.config.enabled ||
    !coordinator.config.automatic ||
    (stage === "premerge" && !coordinator.config.autoMerge)
  )
    throw new Error("Dependency operation disabled");
  if (
    stage === "premerge" &&
    !policy.reviewGate((await coordinator.ledger.read()).state, { number, head: t.head }).ok
  )
    throw new Error("Dependency review required before premerge");
  const identity = expectedReport(t, coordinator.context, stage);
  const [bm, hm, bl, hl] = await Promise.all([
    content(coordinator.api, identity.base, "package.json"),
    content(coordinator.api, identity.head, "package.json"),
    content(coordinator.api, identity.base, "yarn.lock"),
    content(coordinator.api, identity.head, "yarn.lock"),
  ]);
  const inventory = inspectUpdate(
    bm,
    hm,
    bl,
    hl,
    toolsAt(path.join(__dirname, "dependency-tools"))
  );
  if (!inventory.changed) throw new Error("Dependency PR has no changed package versions");
  const advisory = await queryOsv(inventory.queries, transport);
  // Revalidate the main/base/head after the public service call.
  await coordinator.pr(number, { expected: t });
  return validateReport(
    reportFor(identity, {
      changed: inventory.changed,
      candidateVersions: advisory.candidateVersions,
      cleared: advisory.cleared,
      remainingBaseline: advisory.remainingBaseline,
    }),
    identity
  );
}
async function main(env = process.env) {
  policy.assertSubscriptionEnv(env);
  const config = policy.readConfig(JSON.parse(env.FACTORY_VARIABLES || "{}"));
  const inputs = JSON.parse(env.FACTORY_INPUTS || "{}");
  const api = new GitHub({ token: env.GH_TOKEN });
  const context = await require("./trusted-wake.cjs").loadWakeContext(api, runtimeContext(env), env, { bind: env.FACTORY_OPERATION === "dep_select" });
  const c = new DependencyCoordinator(api, config, context);
  c.authorize();
  const n = Number(inputs.ticket),
    op = env.FACTORY_OPERATION;
  let result;
  if (op === "dep_select")
    result = await c.select(
      inputs.preview === undefined ? context.event === "workflow_dispatch" : inputs.preview
    );
  else if (op === "dep_analysis" || op === "dep_premerge") {
    const stage = op === "dep_analysis" ? "analysis" : "premerge";
    const report = await analyze(c, n, stage);
    const dir = path.join(env.RUNNER_TEMP, "factory-dependencies");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, stage + ".json"), JSON.stringify(report));
    result = {
      passed: true,
      ticket: n,
      head: report.head,
      reason: "Bounded dependency and OSV checks passed",
    };
  } else if (op === "dep_accept")
    result = await c.acceptAnalysis(n, readJson(env.FACTORY_BUNDLE_PATH, 60000));
  else if (op === "dep_ci") {
    await c.ticket(n);
    result = await c.controller.ci(n);
  } else if (op === "dep_reserve") result = await c.reserve(n);
  else if (op === "dep_assess")
    result = await c.assess(n, inputs.grantId, readJson(env.FACTORY_BUNDLE_PATH));
  else if (op === "dep_merge")
    result = await new DependencyMerger(
      api,
      config,
      context,
      env.FACTORY_BUNDLE_PATH ? readJson(env.FACTORY_BUNDLE_PATH, 60000) : null
    ).merge(n);
  else if (op === "dep_finalize") result = await c.finalize(n);
  else throw new Error("Unknown dependency operation");
  output(result, env);
  return result;
}
if (require.main === module)
  main().catch(() => {
    console.error(
      "Dependency operation refused; inspect bounded prerequisites and retained ledger history"
    );
    process.exitCode = 1;
  });
module.exports = { content, analyze, main };
