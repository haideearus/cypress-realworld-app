const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { DRILL_PATH } = require("./drill-contract.cjs");
const { secretLike } = require("./artifacts.cjs");
const { brokenSource } = require("./drill-fixture.cjs");
const { checkFixture } = require("./drill-sandbox.cjs");
const {
  SHA,
  UUID,
  exactKeys,
  validateSource,
  validateObservation,
  assertBaseline,
} = require("./drill/validation.cjs");

function verifyBundle({ bundle, grantId, head }) {
  if (
    !UUID.test(grantId || "") ||
    !SHA.test(head || "") ||
    !exactKeys(bundle, ["kind", "grantId", "base", "files", "evidence"]) ||
    bundle.kind !== "code" ||
    bundle.grantId !== grantId ||
    bundle.base !== head ||
    !Array.isArray(bundle.files) ||
    bundle.files.length !== 1 ||
    typeof bundle.evidence !== "string" ||
    !bundle.evidence.trim() ||
    Buffer.byteLength(bundle.evidence) > 20000 ||
    secretLike(bundle.evidence)
  )
    throw new Error("Invalid drill bundle identity or shape");
  const file = bundle.files[0];
  if (
    !exactKeys(file, ["path", "mode", "content"]) ||
    file.path !== DRILL_PATH ||
    file.mode !== "100644"
  )
    throw new Error("Drill bundle may change only the regular fixture implementation");
  return {
    source: validateSource(file.content),
    bundleSha256: createHash("sha256").update(JSON.stringify(bundle)).digest("hex"),
  };
}

function validateIdentity({ grantId, head, runId, runAttempt, workflowSha, seedSha }) {
  if (
    !UUID.test(grantId || "") ||
    !SHA.test(head || "") ||
    !SHA.test(workflowSha || "") ||
    !SHA.test(seedSha || "") ||
    head !== seedSha ||
    typeof runId !== "string" ||
    !/^[1-9]\d{0,19}$/.test(runId) ||
    runAttempt !== 1
  )
    throw new Error("Invalid drill verification identity");
}

function validateReport(report, expected) {
  validateIdentity(expected);
  if (
    !exactKeys(report, [
      "version",
      "synthetic",
      "runId",
      "runAttempt",
      "workflowSha",
      "seedSha",
      "grantId",
      "bundleSha256",
      "baseline",
      "candidate",
      "healthy",
      "startedAt",
      "finishedAt",
    ]) ||
    report.version !== 1 ||
    report.synthetic !== true ||
    !/^[a-f0-9]{64}$/.test(expected.bundleSha256 || "") ||
    ["runId", "runAttempt", "workflowSha", "seedSha", "grantId", "bundleSha256"].some(
      (key) => report[key] !== expected[key]
    ) ||
    ["startedAt", "finishedAt"].some(
      (key) =>
        typeof report[key] !== "string" ||
        !Number.isFinite(Date.parse(report[key])) ||
        new Date(report[key]).toISOString() !== report[key]
    ) ||
    Date.parse(report.finishedAt) < Date.parse(report.startedAt)
  )
    throw new Error("Invalid drill verification report");
  const baseline = validateObservation(report.baseline, expected.seedSha);
  const candidate = validateObservation(report.candidate, expected.seedSha);
  assertBaseline(baseline);
  if (typeof report.healthy !== "boolean" || report.healthy !== candidate.healthy)
    throw new Error("Inconsistent drill verification report");
  return structuredClone(report);
}

async function verifyRepair({
  bundle,
  check = checkFixture,
  now = () => new Date().toISOString(),
  ...identity
}) {
  validateIdentity(identity);
  const { source, bundleSha256 } = verifyBundle({
    bundle,
    grantId: identity.grantId,
    head: identity.head,
  });
  const startedAt = now();
  const baseline = validateObservation(
    await check(brokenSource, { release: identity.seedSha }),
    identity.seedSha
  );
  assertBaseline(baseline);
  const candidate = validateObservation(
    await check(source, { release: identity.seedSha }),
    identity.seedSha
  );
  const report = {
    version: 1,
    synthetic: true,
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    workflowSha: identity.workflowSha,
    seedSha: identity.seedSha,
    grantId: identity.grantId,
    bundleSha256,
    baseline,
    candidate,
    healthy: candidate.healthy,
    startedAt,
    finishedAt: now(),
  };
  return validateReport(report, { ...identity, bundleSha256 });
}

function readJson(file, maxBytes) {
  if (typeof file !== "string" || !file) throw new Error("Missing verification input path");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
    throw new Error("Verification input must be a bounded regular file");
  const bytes = fs.readFileSync(file);
  const text = bytes.toString("utf8");
  if (text.includes("\uFFFD") || !Buffer.from(text, "utf8").equals(bytes))
    throw new Error("Invalid verification input encoding");
  return JSON.parse(text);
}

async function main(env = process.env, operation = process.argv[2] || "verify") {
  if (
    Object.entries(env).some(
      ([key, value]) =>
        value &&
        /^(?:GH_TOKEN|GITHUB_TOKEN|CLAUDE_CODE_(?:OAUTH_TOKEN|API_KEY_HELPER|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY)|ANTHROPIC_.+|OPENAI_API_KEY|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)|(?:TEST_)?DATABASE_URL|RENDER_DEPLOY_HOOK(?:_URL)?|FACTORY_GITHUB_APP_PRIVATE_KEY)$/.test(
          key
        )
    )
  )
    throw new Error("Verification refuses provider, production or GitHub credentials");
  if (!["verify", "baseline"].includes(operation))
    throw new Error("Unknown drill verification operation");
  const identity = readJson(env.FACTORY_DRILL_INPUT, 4096);
  let report;
  if (operation === "baseline") {
    if (!exactKeys(identity, ["seedSha"]) || !SHA.test(identity.seedSha || ""))
      throw new Error("Invalid baseline identity");
    report = validateObservation(
      await checkFixture(brokenSource, { release: identity.seedSha }),
      identity.seedSha
    );
    assertBaseline(report);
  } else {
    if (!exactKeys(identity, ["grantId", "head", "seedSha", "workflowSha", "runId", "runAttempt"]))
      throw new Error("Invalid verification input identity");
    const bundle = readJson(env.FACTORY_DRILL_BUNDLE, 80000);
    report = await verifyRepair({ ...identity, bundle });
  }
  if (typeof env.FACTORY_DRILL_REPORT !== "string" || !env.FACTORY_DRILL_REPORT)
    throw new Error("Missing verification report path");
  fs.writeFileSync(env.FACTORY_DRILL_REPORT, JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return operation === "baseline" || report.healthy ? 0 : 1;
}

if (require.main === module)
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.error("Drill verification failed closed");
      process.exitCode = 1;
    }
  );

module.exports = { verifyBundle, verifyRepair, validateReport, main };
