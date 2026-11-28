const fs = require("node:fs");
const path = require("node:path");
const policy = require("./policy.cjs");
const { GitHub, ROOT } = require("./github.cjs");
const { runtimeContext, output, readJson } = require("./controller.cjs");
const { DependencyCoordinator, DependencyMerger, expectedReport } = require("./dependencies.cjs");
const { trackNativeDependencies } = require("./dependency-tracking.cjs");
const { widerReceiptFor, verifyWiderContents } = require("./dependency-alert-repair.cjs");
const { MergeCheckFailure, describe, premergeEvidence } = require("./dependency-merge-retry.cjs");
const native = require("./dependency-native-recovery.cjs");
const {
  inspectUpdate,
  queryOsv,
  reportFor,
  validateReport,
  toolsAt,
} = require("./dependency-analysis.cjs");

const dependencyTools = () => toolsAt(path.join(__dirname, "dependency-tools"));
async function evidenceSources(api, ticket) {
  const source = await native.sources(api, ticket);
  return {
    ...source,
    wider: verifyWiderContents(
      await widerReceiptFor(api, ticket),
      source.headManifest,
      source.headLock
    ),
    ...native.analysisScope(source, ticket, dependencyTools()),
  };
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
  const { baseManifest, headManifest, baseLock, headLock, wider, nativeMajor } =
    await evidenceSources(coordinator.api, t);
  const inventory = inspectUpdate(
    baseManifest,
    headManifest,
    baseLock,
    headLock,
    dependencyTools(),
    false,
    { wider: wider || nativeMajor }
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
  const api = new GitHub({ token: env.GH_TOKEN, retryReads: true, retryInternalReads: true });
  const afterMainCI = runtime.event === "workflow_run" && op === "dep_recover_tracked";
  const context = afterMainCI
    ? runtime
    : await require("./trusted-wake.cjs").loadWakeContext(api, runtime, env, {
        bind: op === "dep_select" && preview === false,
      });
  const c = new DependencyCoordinator(api, config, context);
  if (!afterMainCI) c.authorize();
  const n = Number(inputs.ticket);
  let result;
  if (op === "dep_select") result = await c.select(preview);
  else if (op === "dep_track" || op === "dep_recover_tracked") {
    const token = env.FACTORY_DEPENDABOT_REBASE_TOKEN;
    const refreshApi = !preview && token ? new GitHub({ token }) : undefined;
    result = await trackNativeDependencies(api, config, context, preview, {
      refreshApi,
      recoveryOnly: op === "dep_recover_tracked",
      mainCIEvent: afterMainCI ? readJson(env.GITHUB_EVENT_PATH, 2000000) : undefined,
    });
  } else if (op === "dep_compat_refresh")
    result = await c.refreshCompatibility(n, inputs.head, inputs.base);
  else if (op === "dep_compat_plan") result = await native.planCompatibility(c, n);
  else if (op === "dep_compat_publish") {
    const { COMPATIBILITY_BUNDLE_LIMIT } = require("./artifacts.cjs");
    result = await native.publishCompatibility(
      c,
      n,
      inputs.grantId,
      readJson(env.FACTORY_BUNDLE_PATH, COMPATIBILITY_BUNDLE_LIMIT)
    );
  } else if (op === "dep_analysis" || op === "dep_premerge") {
    const stage = op === "dep_analysis" ? "analysis" : "premerge";
    const report = await analyze(c, n, stage).catch((error) => {
      if (stage === "premerge")
        output(
          { premergeEvidence: JSON.stringify(premergeEvidence(error)) },
          { ...env, GITHUB_STEP_SUMMARY: undefined }
        );
      throw error;
    });
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
      async (t) => ({ ...(await evidenceSources(api, t)), ci: t.ci }),
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
  else if (op === "dep_finalize") result = await c.finalize(n, inputs);
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
function refusalReason(error, operation) {
  const knownStage = {
    dep_analysis: "analysis",
    dep_premerge: "premerge",
    dep_merge: "merge",
    dep_select: "selection",
    dep_ci: "CI",
    dep_evidence: "review evidence",
    dep_assess: "assessment",
    dep_reserve: "review reservation",
    dep_compat_plan: "native compatibility planning",
    dep_compat_publish: "native compatibility publication",
    dep_compat_refresh: "native compatibility refresh",
  };
  const { stage, reason } =
    error instanceof MergeCheckFailure
      ? error.diagnostic
      : describe(
          error,
          Object.hasOwn(knownStage, operation) ? knownStage[operation] : "dependency operation"
        );
  return (
    `Dependency operation refused at ${stage}. ${reason}.` +
    (error instanceof MergeCheckFailure && error.ledgerDiagnostic
      ? ` Could not record recovery in the ledger. ${error.ledgerDiagnostic.reason}.`
      : "")
  );
}

if (require.main === module)
  main().catch((error) => {
    console.error(refusalReason(error, process.env.FACTORY_OPERATION));
    process.exitCode = 1;
  });
module.exports = {
  content: require("./dependency-compatibility.cjs").readDependencySource,
  analyze,
  main,
  refusalReason,
};
