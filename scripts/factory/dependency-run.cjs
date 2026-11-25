const fs = require("node:fs");
const path = require("node:path");
const policy = require("./policy.cjs");
const { GitHub, ROOT } = require("./github.cjs");
const { runtimeContext, output, readJson } = require("./controller.cjs");
const { DependencyCoordinator, DependencyMerger, expectedReport } = require("./dependencies.cjs");
const { trackNativeDependencies } = require("./dependency-tracking.cjs");
const { widerReceiptFor, verifyWiderContents } = require("./dependency-alert-repair.cjs");
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
  const wider = verifyWiderContents(await widerReceiptFor(coordinator.api, t), hm, hl);
  const inventory = inspectUpdate(
    bm,
    hm,
    bl,
    hl,
    toolsAt(path.join(__dirname, "dependency-tools")),
    false,
    { wider }
  );
  if (!inventory.changed) throw new Error("Dependency PR has no changed package versions");
  const advisory = await queryOsv(inventory.queries, transport);
  if (wider && (!advisory.cleared.length || advisory.remainingBaseline.length))
    throw new Error("Wider dependency advisory clearance is no longer verified");
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
  const inputs = JSON.parse(env.FACTORY_INPUTS || "{}") || {};
  const op = env.FACTORY_OPERATION;
  const runtime = runtimeContext(env);
  const preview =
    inputs.preview === undefined ? runtime.event === "workflow_dispatch" : inputs.preview;
  const api = new GitHub({ token: env.GH_TOKEN });
  const context = await require("./trusted-wake.cjs").loadWakeContext(api, runtime, env, {
    bind: op === "dep_select" && preview === false,
  });
  const c = new DependencyCoordinator(api, config, context);
  c.authorize();
  const n = Number(inputs.ticket);
  let result;
  if (op === "dep_select") result = await c.select(preview);
  else if (op === "dep_track" || op === "dep_recover_tracked") {
    const token = env.FACTORY_DEPENDABOT_REBASE_TOKEN;
    const refreshApi = !preview && token ? new GitHub({ token }) : undefined;
    result = await trackNativeDependencies(api, config, context, preview, {
      refreshApi,
      recoveryOnly: op === "dep_recover_tracked",
    });
  } else if (op === "dep_analysis" || op === "dep_premerge") {
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
  } else if (op === "dep_evidence") {
    const preflight = require("./dependency-preflight.cjs");
    const { packet, ...outcome } = await preflight.prepare(
      c,
      n,
      async (t) => {
        const attempt = require("./dependency-contract.cjs").validateTicket(t);
        const [baseManifest, headManifest, baseLock, headLock] = await Promise.all([
          content(api, attempt.base, "package.json"),
          content(api, t.head, "package.json"),
          content(api, attempt.base, "yarn.lock"),
          content(api, t.head, "yarn.lock"),
        ]);
        return {
          base: attempt.base,
          head: t.head,
          baseManifest,
          headManifest,
          baseLock,
          headLock,
          ci: t.ci,
          wider: verifyWiderContents(await widerReceiptFor(api, t), headManifest, headLock),
        };
      },
      { transport: preflight.evidenceTransport(env.GH_TOKEN) }
    );
    if (packet) {
      const dir = path.join(env.RUNNER_TEMP, "factory-dependencies");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify(packet));
    }
    console.log(outcome.reason);
    result = outcome;
  } else if (op === "dep_reserve")
    result = await c.reserve(n, readJson(env.FACTORY_BUNDLE_PATH, 262144));
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
  const tracking = op === "dep_track" || op === "dep_recover_tracked";
  if (!tracking && !(op === "dep_select" && preview))
    await require("./activity.cjs").recordResult(api, context, result, env);
  output(result, env);
  if (tracking && result.links?.length && env.GITHUB_STEP_SUMMARY) {
    const home = `https://github.com/${policy.REPOSITORY}`;
    const lines = result.links.map(({ pr, issue, status }) => {
      const proposal = `[PR #${pr}](${home}/pull/${pr})`;
      const ticket = issue ? ` · [Issue #${issue}](${home}/issues/${issue})` : "";
      return `- ${proposal}${ticket} · ${status}`;
    });
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `\n${lines.join("\n")}\n`);
  }
  return result;
}
const safeRefusals = new Set([
  "Dependency PR requires a current-main rebase",
  "Native review gate is pending or unavailable",
  "PR mergeability is not clean",
  "Native checks or clean PR mergeability changed",
  "Another merge intent holds the global merge writer",
  "An active ticket holds the factory lock",
]);

function refusalReason(error) {
  if (safeRefusals.has(error?.message)) return `Dependency operation refused. ${error.message}.`;
  return "Dependency operation refused. Inspect bounded prerequisites and retained ledger history.";
}

if (require.main === module)
  main().catch((error) => {
    console.error(refusalReason(error));
    process.exitCode = 1;
  });
module.exports = { content, analyze, main, refusalReason };
