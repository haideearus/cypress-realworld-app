const fs = require("node:fs");
const path = require("node:path");
const p = require("./policy.cjs");
const c = require("./discovery-contract.cjs");
const rc = require("./discovery-recovery-contract.cjs");
const origin = require("./discovery-recovery-origin.cjs");
const { RecoveryGitHub } = require("./recovery-github.cjs");
const { Ledger, ROOT } = require("./github.cjs");
const { FindingStore } = require("./discovery-finding-store.cjs");
const { runtimeContext, output } = require("./controller.cjs");
const { diagnostic, withStage } = require("./discovery-diagnostics.cjs");
const { downloadJsonArtifact } = require("./discovery-archive.cjs");
const { validateEvidence } = require("./discovery-recovery-evidence.cjs");

function contextFor(env, ciRunId) {
  const runtime = runtimeContext(env);
  const context = Object.fromEntries(
    [
      "repository",
      "actor",
      "triggeringActor",
      "ref",
      "event",
      "workflowRef",
      "workflowSha",
      "runId",
      "runAttempt",
    ].map((key) => [key, runtime[key]])
  );
  context.ciRunId = ciRunId;
  rc.makeProof(context);
  return context;
}
function allowed(state, config) {
  const active = require("./active-tickets.cjs");
  return Boolean(
    config.enabled &&
      !config.automatic &&
      !config.autoMerge &&
      !config.discovery &&
      !state.stop &&
      !active.activeEntries(state).length &&
      !active.pendingIntent(state)
  );
}
function emit(values, env) {
  const result = { ...values, modelCalls: 0 };
  output(result, env);
  console.log(JSON.stringify(result, null, 2));
  return result;
}
function artifactIdentity(metadata) {
  return {
    id: metadata.id,
    name: metadata.name,
    workflowRunId: String(metadata.workflow_run?.id),
    digest: metadata.digest,
  };
}
async function replayArtifact(api, receipt, { readArtifact = downloadJsonArtifact } = {}) {
  const proof = receipt.proof;
  const run = await origin.verifyProducer(api, proof.context, { complete: false });
  // The finalizer runs while its parent is active; reconciliation may inspect a failed parent.
  if (!run) throw Error("Missing recovery producer");
  return assessArtifact(api, receipt, readArtifact);
}
async function assessArtifact(api, receipt, readArtifact) {
  const proof = receipt.proof;
  if (
    !(await require("./discovery-origin.cjs").successfulJob(
      api,
      proof.context.runId,
      "replay",
      "Replay saved privacy candidates without a model"
    ))
  )
    return null;
  const matches = (
    await api.pages(
      `${ROOT}/actions/runs/${proof.context.runId}/artifacts?per_page=100`,
      "artifacts"
    )
  ).filter((a) => a.name === rc.artifactName(proof));
  if (matches.length !== 1) throw Error("Recovery artifact missing or ambiguous");
  const metadata = await api.request("GET", `${ROOT}/actions/artifacts/${matches[0].id}`);
  const artifact = artifactIdentity(metadata);
  rc.validateArtifact(artifact, proof);
  if (metadata.expired !== false || metadata.workflow_run?.head_sha !== proof.context.workflowSha)
    throw Error("Recovery artifact provenance changed");
  const bundle = await readArtifact(api, metadata, "evidence.json");
  validateEvidence(bundle, proof);
  // Validate all individually verified candidates before the receipt can be assessed.
  const f = require("./discovery-finding-contract.cjs");
  const originalProof = (await new Ledger(api).read()).state.tickets[String(rc.SOURCE.ticket)]
    .discovery;
  for (const [index, row] of bundle.findings.entries())
    if (row.status === "verified") f.candidateFromEvidence(bundle, index, artifact, originalProof);
  return artifact;
}
async function main(env = process.env, dependencies = {}) {
  p.assertSubscriptionEnv(env);
  const api = dependencies.api || new RecoveryGitHub({ token: env.GH_TOKEN });
  const ledger = dependencies.ledger || new Ledger(api),
    store = dependencies.store || new FindingStore(api);
  const config = p.readConfig(JSON.parse(env.FACTORY_VARIABLES || "{}"));
  const inputs = JSON.parse(env.FACTORY_INPUTS || "{}"),
    op = env.FACTORY_OPERATION || "select";
  const readArtifact = dependencies.readArtifact || downloadJsonArtifact;
  const provenance = dependencies.provenance || origin;
  const state = (await ledger.read()).state;
  const registry = (await store.read()).state;
  const rows = registry.imports[rc.SOURCE.grantId]?.recoveries || [];
  let context;
  if (op === "select") {
    if (!["preview", "run", "reconcile"].includes(inputs.operation || "preview"))
      throw Error("Unknown recovery operation");
    // Reject an unauthorized runtime before any CI lookup or durable mutation.
    contextFor(env, "1");
    const tested = await (dependencies.testedMain || require("./discovery-run.cjs").testedMain)(
      api,
      runtimeContext(env),
      {}
    );
    context = contextFor(env, tested.ciRunId);
  } else {
    const receipt = rows.find((r) => r.proof.id === inputs.receiptId);
    if (!receipt) throw Error("Missing exact recovery receipt");
    context = contextFor(env, receipt.proof.context.ciRunId);
    if (
      c.digest(context) !== c.digest(receipt.proof.context) ||
      inputs.artifactName !== rc.artifactName(receipt.proof)
    )
      throw Error("Recovery reservation context changed");
  }
  await provenance.verifyProducer(api, context, { complete: false });
  const saved = await provenance.verifyOriginal(api, { ledger, discovery: dependencies.discovery });
  const preview =
    op === "select" &&
    (!["run", "reconcile"].includes(inputs.operation) || inputs.dry_run !== false);
  if (preview)
    return emit(
      {
        outcome: "recovery_preview",
        ready: false,
        eligible: allowed(state, config),
        sourceRun: rc.SOURCE.runId,
        maximumReplays: 2,
        dailyUsed: rc.dailyUsage(
          registry,
          p.dayKey(dependencies.now || new Date(), config.timezone)
        ),
      },
      env
    );
  if (op !== "finish" && !allowed(state, config))
    throw Error("Recovery requires idle factory and paused automation/discovery");
  const before = async () => {
    if (!allowed((await ledger.read()).state, config))
      throw Error("Recovery stopped before isolated execution");
  };
  if (op === "select") {
    if (inputs.operation === "reconcile") {
      const receipt = rows.find((r) => r.outcome === "intent");
      if (!receipt) return emit({ outcome: "nothing-to-reconcile", ready: false }, env);
      await provenance.verifyProducer(api, receipt.proof.context, { complete: true });
      const artifact = await assessArtifact(api, receipt, readArtifact);
      await before();
      const result = await store.update((s) => ({
        state: s,
        receipt: rc.finish(s, receipt.proof.id, artifact, context),
      }));
      return emit({ outcome: result.receipt.outcome, ready: false }, env);
    }
    const day = p.dayKey(dependencies.now || new Date(), config.timezone);
    await before();
    const result = await store.update((s) => ({ state: s, receipt: rc.reserve(s, context, day) }));
    return emit(
      {
        outcome: "recovery-reserved",
        ready: result.receipt.outcome === "intent",
        receiptId: result.receipt.proof.id,
        artifactName: rc.artifactName(result.receipt.proof),
      },
      env
    );
  }
  const receipt = rows.find((r) => r.proof.id === inputs.receiptId);
  if (receipt.outcome !== "intent") return emit({ outcome: receipt.outcome, ready: false }, env);
  if (op === "replay") {
    const bundle = rc.validateBundle(await readArtifact(api, saved.artifact, "bundle.json"));
    await before();
    const root = path.join(env.RUNNER_TEMP, `privacy-recovery-${receipt.proof.id}`);
    const image = await withStage("image-build", () =>
      (dependencies.buildBaseline || require("./discovery-intake.cjs").buildBaseline)({
        cwd: env.GITHUB_WORKSPACE || process.cwd(),
        head: rc.SOURCE.head,
        root,
      })
    );
    if (
      c.digest(require("./discovery-worker.cjs").manifestFor(path.join(root, "source"))) !==
      rc.SOURCE.sourceHash
    )
      throw Error("Frozen recovery app source changed");
    await before();
    const outputDir = path.join(root, "assessment");
    fs.mkdirSync(outputDir);
    const result = await require("./discovery-replay.cjs").assessCandidates({
      bundle,
      image,
      output: outputDir,
      before,
    });
    result.recovery = receipt.proof;
    validateEvidence(result, receipt.proof);
    await require("./secret-scan.cjs").scanFiles([
      { path: "recovery-evidence.json", content: JSON.stringify(result) },
    ]);
    fs.mkdirSync(env.FACTORY_RECOVERY_OUTPUT);
    fs.writeFileSync(
      path.join(env.FACTORY_RECOVERY_OUTPUT, "evidence.json"),
      JSON.stringify(result),
      { flag: "wx" }
    );
    return emit({ outcome: "candidates-assessed", ready: false }, env);
  }
  if (op === "finish") {
    let artifact =
      env.FACTORY_REPLAY_SUCCESS === "true" && allowed((await ledger.read()).state, config)
        ? await replayArtifact(api, receipt, { readArtifact })
        : null;
    if (artifact && !allowed((await ledger.read()).state, config)) artifact = null;
    const result = await withStage("finalization", () =>
      store.update((s) => ({
        state: s,
        receipt: rc.finish(s, receipt.proof.id, artifact, context),
      }))
    );
    return emit({ outcome: result.receipt.outcome, ready: false }, env);
  }
  throw Error("Unknown recovery worker operation");
}
if (require.main === module)
  main().catch((error) => {
    console.error(JSON.stringify(diagnostic("recovery", error)));
    process.exitCode = 1;
  });
module.exports = { main, allowed, contextFor, artifactIdentity, assessArtifact };
