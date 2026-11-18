// Trusted pre/post-model verification. Proposed tests run only in isolated Docker.
const fs = require("node:fs"),
  path = require("node:path");
const c = require("./discovery-contract.cjs"),
  p = require("./policy.cjs"),
  f = require("./discovery-finding-contract.cjs");
const { GitHub, Ledger, ROOT } = require("./github.cjs");
const { FindingStore } = require("./discovery-finding-store.cjs");
const { runtimeContext, output, readJson } = require("./controller.cjs");
const intake = require("./discovery-intake.cjs");
function priorOverlay(cwd, base, head) {
  if (!c.SHA.test(base) || !c.SHA.test(head)) throw Error("Invalid immutable repair base");
  const git = (args) =>
    require("node:child_process").execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd,
      env: require("./discovery-sandbox.cjs").safeEnv(),
      encoding: "utf8",
      maxBuffer: 1000000,
      windowsHide: true,
    });
  git(["merge-base", "--is-ancestor", base, head]);
  const names = git([
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--name-only",
    "-z",
    base,
    head,
    "--",
  ])
    .split("\0")
    .filter(Boolean);
  const files = names.map((name) => {
    if (!require("./artifacts.cjs").validPath(name))
      throw Error("Untrusted repair baseline changed harness files");
    const entry = git(["ls-tree", head, "--", name]);
    if (!entry) return { path: name, deleted: true };
    if (!entry.startsWith("100644 blob ")) throw Error("Nonregular repair overlay");
    return { path: name, mode: "100644", content: git(["show", `${head}:${name}`]) };
  });
  if (files.length) require("./artifacts.cjs").validateChanges(files);
  return files;
}
function repairProof(ticket, grant, bundle, red, green) {
  if (red.outcome !== "ready" || green.outcome !== "observed-resolved")
    throw Error("Trusted discovery repair RED/GREEN incomplete");
  return {
    version: 2,
    findingRef: ticket.finding.origin.key,
    candidateHash: ticket.finding.origin.candidateHash,
    grantId: grant.id,
    head: grant.head,
    filesHash: c.digest(bundle.files),
    redHash: red.redHash,
    greenHash: green.evidenceHash,
    redOutcome: red.outcome,
    greenOutcome: green.outcome,
  };
}
function validRepairProof(ticket, grant, bundle) {
  try {
    const v = bundle.findingVerification;
    c.exact(v, [
      "version",
      "findingRef",
      "candidateHash",
      "grantId",
      "head",
      "filesHash",
      "redHash",
      "greenHash",
      "redOutcome",
      "greenOutcome",
    ]);
    return (
      v.version === 2 &&
      v.findingRef === ticket.finding.origin.key &&
      v.candidateHash === ticket.finding.origin.candidateHash &&
      v.grantId === grant.id &&
      v.head === grant.head &&
      v.filesHash === c.digest(bundle.files) &&
      c.HASH.test(v.redHash) &&
      c.HASH.test(v.greenHash) &&
      v.redOutcome === "ready" &&
      v.greenOutcome === "observed-resolved" &&
      (!ticket.findingRedHash || ticket.findingRedHash === v.redHash)
    );
  } catch {
    return false;
  }
}
async function finalizeRepairBundle(ticket, grant, bundle, red, green) {
  // Scan the final wire representation, including the trusted post-model receipt.
  // Raw origin/intake records remain unchanged in the trusted ledger.
  const complete = {
    ...bundle,
    findingVerification: repairProof(ticket, grant, bundle, red, green),
  };
  if (!validRepairProof(ticket, grant, complete)) throw Error("Invalid final repair proof");
  await require("./secret-scan.cjs").scanFiles([
    { path: "bundle.json", content: JSON.stringify(complete) },
  ]);
  return complete;
}
async function verifyPublishedRepair(api, ticket, grant, bundle) {
  const issue = await api.request("GET", `${ROOT}/issues/${grant.ticket}`);
  if (
    !(await require("./discovery-origin.cjs").verifyRepairOrigin(api, issue, ticket.finding)) ||
    !validRepairProof(ticket, grant, bundle)
  )
    throw Error("Discovery repair verification missing or changed");
  const jobs = await api.pages(
    `${ROOT}/actions/runs/${grant.runId}/attempts/${grant.runAttempt}/jobs?per_page=100`,
    "jobs"
  );
  const coding = jobs.filter(
    (j) => j.name?.split(" / ").includes(grant.slot) && j.name.endsWith("coding / agent")
  );
  if (
    coding.length !== 1 ||
    coding[0].status !== "completed" ||
    coding[0].conclusion !== "success" ||
    [
      "Prove finding RED without model credentials",
      "Run the one reserved Claude subscription session",
      "Prove finding GREEN without model credentials",
    ].some(
      (name) =>
        coding[0].steps?.filter((s) => s.name === name && s.conclusion === "success").length !== 1
    )
  )
    throw Error("Successful trusted finding repair job required");
}
function evidenceLocation(candidate) {
  f.validateCandidate(candidate);
  return {
    artifactName: candidate.artifact.name,
    sourceRun: candidate.artifact.workflowRunId,
  };
}
function repairBaseline(ticket) {
  const head =
    ticket.findingApiRecovery?.head ||
    ticket.findingOutputRecovery?.head ||
    ticket.findingContinuation?.head ||
    ticket.findingRetry?.head ||
    ticket.finding.intake.head;
  if (!c.SHA.test(head)) throw Error("Invalid trusted repair baseline");
  return head;
}
async function main(env = process.env) {
  p.assertSubscriptionEnv(env);
  const inputs = JSON.parse(env.FACTORY_INPUTS || "{}"),
    config = p.readConfig(JSON.parse(env.FACTORY_VARIABLES || "{}"));
  const api = new GitHub({ token: env.GH_TOKEN, retryReads: true });
  const context = await require("./trusted-wake.cjs").loadWakeContext(
    api,
    {
      ...runtimeContext(env),
      ticket: Number(inputs.ticket),
      phase: inputs.phase,
      slot: inputs.slot,
      head: inputs.head,
    },
    env
  );
  const state = (await new Ledger(api).read()).state;
  const grant = p.preflight(state, inputs.grantId, context, config),
    ticket = state.tickets[String(grant.ticket)];
  if (!ticket.finding || grant.phase !== "code") return output({ finding: false }, env);
  const issue = await api.request("GET", `${ROOT}/issues/${grant.ticket}`);
  if (!(await require("./discovery-origin.cjs").verifyRepairOrigin(api, issue, ticket.finding)))
    throw Error("Finding repair origin changed");
  const record = (await new FindingStore(api).read()).state.records[ticket.finding.origin.key];
  if (env.FACTORY_OPERATION === "resolve")
    return output(
      {
        finding: true,
        ...evidenceLocation(record.candidate),
      },
      env
    );
  const root = path.join(env.RUNNER_TEMP, `finding-repair-${grant.id}`);
  const candidate = record.candidate,
    head = grant.head;
  const bundle = require("./discovery-finding-run.cjs").readBounded(
    path.join(env.FACTORY_FINDING_INPUT, "evidence.json")
  );
  const op = env.FACTORY_OPERATION;
  if (!["red", "green"].includes(op)) throw Error("Invalid finding repair operation");
  if (op === "red") fs.mkdirSync(root, { recursive: false });
  const code = op === "green" ? readJson(path.join(env.FACTORY_ARTIFACT_DIR, "bundle.json")) : null;
  if (code && (code.grantId !== grant.id || code.base !== grant.head || code.kind !== "code"))
    throw Error("Code artifact identity changed");
  const cwd = env.GITHUB_WORKSPACE || process.cwd(),
    base = repairBaseline(ticket);
  const prior = priorOverlay(cwd, base, head);
  const files = [
    ...new Map([...prior, ...(code?.files || [])].map((file) => [file.path, file])).values(),
  ];
  if (files.length) require("./artifacts.cjs").validateChanges(files);
  let image;
  if (op === "red") {
    image = await intake.buildBaseline({ cwd, head: base, root: path.join(root, "baseline") });
    fs.writeFileSync(
      path.join(root, "baseline.json"),
      JSON.stringify({ image, base, head, grantId: grant.id }),
      { flag: "wx" }
    );
  } else {
    const baseline = readJson(path.join(root, "baseline.json"));
    if (
      baseline.base !== base ||
      baseline.head !== head ||
      baseline.grantId !== grant.id ||
      !require("./discovery-sandbox.cjs").IMAGE.test(baseline.image)
    )
      throw Error("Immutable repair baseline changed");
    image = baseline.image;
  }
  const build = path.join(root, op);
  fs.mkdirSync(build);
  const overlayFile = path.join(build, "overlay.json");
  fs.writeFileSync(overlayFile, JSON.stringify(files), { flag: "wx", mode: 0o644 });
  p.preflight((await new Ledger(api).read()).state, grant.id, context, config);
  const result = await intake.replayForIntake({
    candidate,
    bundle,
    image,
    tests: path.join(build, "tests"),
    overlayFile,
  });
  const evidenceHash = c.digest(result);
  if (op === "red") {
    if (
      result.outcome !== "ready" &&
      !(ticket.findingRedHash && result.outcome === "observed-resolved")
    )
      throw Error("Current coding baseline does not prove discovery RED");
    const red = {
      outcome: "ready",
      redHash: ticket.findingRedHash || evidenceHash,
      baselineOutcome: result.outcome,
      candidateHash: c.digest(candidate),
      grantId: grant.id,
      head,
    };
    fs.writeFileSync(path.join(root, "red.json"), JSON.stringify(red), { flag: "wx" });
    fs.writeFileSync(path.join(root, "red-evidence.json"), JSON.stringify(result), { flag: "wx" });
    return output({ finding: true, redHash: red.redHash }, env);
  }
  const red = readJson(path.join(root, "red.json"));
  if (red.candidateHash !== c.digest(candidate) || red.grantId !== grant.id || red.head !== head)
    throw Error("Trusted RED receipt changed");
  const complete = await finalizeRepairBundle(ticket, grant, code, red, {
    outcome: result.outcome,
    evidenceHash,
  });
  await require("./secret-scan.cjs").scanFiles([
    { path: "finding-green.json", content: JSON.stringify(result) },
  ]);
  fs.writeFileSync(
    path.join(env.FACTORY_ARTIFACT_DIR, "finding-green.json"),
    JSON.stringify(result)
  );
  fs.copyFileSync(
    path.join(root, "red-evidence.json"),
    path.join(env.FACTORY_ARTIFACT_DIR, "finding-red.json")
  );
  fs.writeFileSync(path.join(env.FACTORY_ARTIFACT_DIR, "bundle.json"), JSON.stringify(complete));
  output({ finding: true, outcome: "trusted-red-green", modelCalls: 0 }, env);
}
if (require.main === module)
  main().catch((error) => {
    console.error(
      require("./artifacts.cjs").secretLike(String(error.message))
        ? "Discovery repair held"
        : String(error.message).slice(0, 220)
    );
    process.exitCode = 1;
  });
module.exports = {
  repairProof,
  finalizeRepairBundle,
  validRepairProof,
  verifyPublishedRepair,
  priorOverlay,
  evidenceLocation,
  repairBaseline,
  main,
};
