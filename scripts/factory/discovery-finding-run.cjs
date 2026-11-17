const fs = require("node:fs");
const path = require("node:path");
const p = require("./policy.cjs");
const c = require("./discovery-contract.cjs");
const f = require("./discovery-finding-contract.cjs");
const { GitHub, Ledger, ROOT } = require("./github.cjs");
const { FindingStore } = require("./discovery-finding-store.cjs");
const origin = require("./discovery-origin.cjs");
const pub = require("./discovery-publication.cjs");
const intake = require("./discovery-intake.cjs");
const { runtimeContext, output: writeOutputs } = require("./controller.cjs");
function output(values, env) {
  writeOutputs(values, env);
  console.log(JSON.stringify(values, null, 2));
  if (env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `\nFinding intake: ${values.outcome}. No model session is started by this workflow.\n`
    );
  return values;
}
function readBounded(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4000000)
    throw Error("Invalid bounded finding artifact");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (require("./artifacts.cjs").secretLike(JSON.stringify(value)))
    throw Error("Secret-bearing finding artifact");
  return value;
}
async function main(env = process.env, dependencies = {}) {
  p.assertSubscriptionEnv(env);
  const api = dependencies.api || new GitHub({ token: env.GH_TOKEN });
  const ledger = dependencies.ledger || new Ledger(api),
    store = dependencies.store || new FindingStore(api);
  const context = runtimeContext(env),
    inputs = JSON.parse(env.FACTORY_INPUTS || "{}"),
    config = p.readConfig(JSON.parse(env.FACTORY_VARIABLES || "{}"));
  const op = env.FACTORY_OPERATION || "select",
    day = p.dayKey(new Date(), config.timezone);
  await origin.producer(api, context, { complete: false });
  if (op === "initialize") {
    if (context.event !== "workflow_dispatch") throw Error("Owner initialization required");
    if (inputs.dry_run !== false)
      return output({ outcome: "initialization_preview", ready: false, modelCalls: 0 }, env);
    await store.initialize();
    return output({ outcome: "initialized", ready: false, modelCalls: 0 }, env);
  }
  const preview =
    op === "select" &&
    context.event === "workflow_dispatch" &&
    (inputs.operation !== "run" || inputs.dry_run !== false);
  const controls = (await ledger.read()).state;
  if (
    op !== "finish" &&
    (controls.stop || !config.enabled || !config.automatic || !config.discovery) &&
    !preview
  )
    return output({ outcome: "disabled-or-stopped", ready: false, modelCalls: 0 }, env);
  let registry;
  try {
    registry = (await store.read()).state;
  } catch (error) {
    if (error.status === 404)
      return output({ outcome: "setup-required", ready: false, modelCalls: 0 }, env);
    throw error;
  }
  if (op === "select") {
    const pending = Object.values(registry.records).find(
      (r) =>
        r.status === "published" &&
        !controls.tickets[String(r.publication.issue)] &&
        Object.values(registry.replays).filter((x) => x.key === r.candidate.key && x.day === day)
          .length < 2 &&
        (!r.intake || r.intake.outcome !== "ready" || r.intake.head !== context.workflowSha)
    );
    const unfinished = Object.values(registry.records).find((r) =>
      ["verified", "held-stop", "held-quota", "publishing-intent"].includes(r.status)
    );
    const grant = Object.values(controls.grants).find(
      (g) =>
        g.phase === "discover" &&
        g.status === "finished" &&
        g.outcome === "discovery_complete" &&
        !registry.imports[g.id]
    );
    const selected = unfinished?.candidate || pending?.candidate;
    const id = selected?.source.grantId || grant?.id;
    if (!id)
      return output(
        { outcome: preview ? "preview-empty" : "no-pending-findings", ready: false, modelCalls: 0 },
        env
      );
    const source = controls.grants[id];
    if (
      !source ||
      source.phase !== "discover" ||
      source.status !== "finished" ||
      source.outcome !== "discovery_complete"
    )
      throw Error("Discovery source is no longer publishable");
    const artifacts = await api.pages(
      `${ROOT}/actions/runs/${source.runId}/artifacts?per_page=100`,
      "artifacts"
    );
    const matches = artifacts.filter((a) => a.name === `discovery-evidence-${id}` && !a.expired);
    if (matches.length !== 1)
      throw Error("Discovery evidence expired or ambiguous; no repair admitted");
    return output(
      {
        outcome: preview ? "preview" : "selected",
        ready: !preview,
        modelCalls: 0,
        sourceGrant: id,
        sourceRun: source.runId,
        artifactId: matches[0].id,
        artifactName: matches[0].name,
      },
      env
    );
  }
  if (preview) throw Error("Preview cannot mutate finding state");
  if (op === "publish") {
    const g = controls.grants[inputs.sourceGrant],
      t = g && controls.tickets[String(g.ticket)];
    if (!g || t?.origin !== "discovery-sweep") throw Error("Missing real discovery grant");
    const metadata = await api.request("GET", `${ROOT}/actions/artifacts/${inputs.artifactId}`);
    const artifact = {
      id: metadata.id,
      name: metadata.name,
      workflowRunId: String(g.runId),
      digest: metadata.digest,
    };
    const bundle = readBounded(path.join(env.FACTORY_FINDING_INPUT, "evidence.json"));
    if (
      bundle.grantId !== g.id ||
      bundle.head !== g.head ||
      bundle.source !== "claude-subscription" ||
      bundle.fixture !== false ||
      !Array.isArray(bundle.findings)
    )
      throw Error("Finding source bundle identity mismatch");
    require("./discovery-evidence.cjs").validateCandidateReport(bundle.report, {
      head: g.head,
      grantId: g.id,
    });
    const candidates = [];
    for (let index = 0; index < bundle.findings?.length; index++) {
      if (bundle.findings[index].status !== "verified") continue;
      const candidate = f.candidateFromEvidence(bundle, index, artifact, t.discovery);
      if (!(await origin.verifySource(api, candidate))) throw Error("Source proof rejected");
      candidates.push(candidate);
    }
    const staged = await store.update((s) => {
      const keys = candidates.map((candidate) => pub.stageFinding(s, candidate).record);
      s.imports[g.id] = {
        runId: g.runId,
        evidenceHash: c.digest(bundle),
        findings: candidates.map((x) => x.key),
      };
      return { state: s, keys };
    });
    for (const key of [...new Set(staged.keys)]) {
      await pub.publishFinding({
        api,
        store,
        ledger,
        config,
        context,
        key,
        verifySource: (x) => origin.verifySource(api, x),
      });
      await pub.appendDuplicates({ api, store, ledger, config, context, key });
    }
    const after = (await store.read()).state;
    const head = await require("./discovery-run.cjs").testedMain(
      api,
      { ...context, event: "workflow_dispatch" },
      {}
    );
    const row = Object.values(after.records).find(
      (r) =>
        r.candidate.source.grantId === g.id &&
        r.status === "published" &&
        !controls.tickets[String(r.publication.issue)] &&
        (!r.intake || r.intake.outcome !== "ready" || r.intake.head !== head.head)
    );
    if (!row || !intake.canReplay((await ledger.read()).state, config, day))
      return output({ outcome: "published-or-held", ready: false, modelCalls: 0 }, env);
    const receipt = await store.update((s) => ({
      state: s,
      receipt: intake.reserveReplay(s, row.candidate.key, day, context, head.head, head.ciRunId),
    }));
    output(
      {
        outcome: "replay-reserved",
        ready: true,
        receiptId: receipt.receipt.id,
        key: row.candidate.key,
        head: head.head,
        modelCalls: 0,
      },
      env
    );
    return;
  }
  const receipt = registry.replays[inputs.receiptId],
    row = receipt && registry.records[receipt.key];
  if (
    !receipt ||
    receipt.context.runId !== context.runId ||
    receipt.context.workflowSha !== context.workflowSha ||
    receipt.context.runAttempt !== 1 ||
    receipt.key !== inputs.key ||
    receipt.head !== inputs.head
  )
    throw Error("Intake reservation mismatch");
  if (op === "replay") {
    if (
      !intake.canReplay(controls, config, day) ||
      !(await origin.verifySource(api, row.candidate))
    )
      throw Error("Replay stopped or source invalid");
    const bundle = readBounded(path.join(env.FACTORY_FINDING_INPUT, "evidence.json"));
    const root = path.join(env.RUNNER_TEMP, `finding-${receipt.id}`);
    const image = await intake.buildBaseline({
      cwd: env.GITHUB_WORKSPACE || process.cwd(),
      head: receipt.head,
      root,
    });
    if (!intake.canReplay((await ledger.read()).state, config, day))
      throw Error("Stopped before replay");
    const result = await intake.replayForIntake({
      candidate: row.candidate,
      bundle,
      image,
      tests: path.join(root, "tests"),
    });
    const evidence = { ...result, id: receipt.id, head: receipt.head };
    await require("./secret-scan.cjs").scanFiles([
      { path: "finding-replay.json", content: JSON.stringify(evidence) },
    ]);
    fs.mkdirSync(env.FACTORY_FINDING_OUTPUT, { recursive: true });
    fs.writeFileSync(
      path.join(env.FACTORY_FINDING_OUTPUT, "replay.json"),
      JSON.stringify(evidence)
    );
    return output({ outcome: result.outcome, modelCalls: 0 }, env);
  }
  if (op === "finish") {
    let result = null;
    if (env.FACTORY_REPLAY_SUCCESS === "true")
      result = readBounded(path.join(env.FACTORY_FINDING_OUTPUT, "replay.json"));
    if (
      result &&
      (result.id !== receipt.id ||
        result.head !== receipt.head ||
        result.candidateHash !== c.digest(row.candidate) ||
        result.originalHead !== row.candidate.source.head ||
        result.originalRedHash !== row.candidate.redLogHash ||
        result.outcome !== intake.assessReplay(row.candidate, result.proposed, result.observations))
    )
      throw Error("Invalid intake result");
    const saved = await store.update((s) => {
      const r = s.replays[receipt.id];
      if (r.outcome !== "intent") return { state: s, receipt: r };
      r.outcome = result?.outcome || "held";
      r.evidenceHash = result ? c.digest(result) : null;
      s.records[r.key].intake = structuredClone(r);
      if (r.outcome === "observed-resolved") s.records[r.key].status = "observed-resolved";
      return { state: s, receipt: r };
    });
    // A resolved baseline is an observation, never a claim of a factory-authored or live repair.
    await pub.noteResolution({ api, store, ledger, config, key: row.candidate.key, context });
    return output(
      { outcome: saved.receipt.outcome, issue: row.publication.issue, modelCalls: 0 },
      env
    );
  }
  throw Error("Unknown finding operation");
}
if (require.main === module)
  main().catch((error) => {
    console.error(
      require("./artifacts.cjs").secretLike(String(error.message))
        ? "Finding operation held"
        : String(error.message).slice(0, 220)
    );
    process.exitCode = 1;
  });
module.exports = { main, readBounded };
