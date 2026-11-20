const fs = require("node:fs");
const path = require("node:path");
const c = require("./discovery-contract.cjs");
const e = require("./discovery-evidence.cjs");
const s = require("./discovery-sandbox.cjs");
const { withStage } = require("./discovery-diagnostics.cjs");

function failedIsolated(result) {
  return Boolean(
    result &&
      Number.isInteger(result.code) &&
      result.code > 0 &&
      result.code !== 124 &&
      result.networkIsolated === true &&
      result.exitState?.status === "exited" &&
      result.exitState.exitCode === result.code &&
      result.exitState.oomKilled === false &&
      typeof result.log === "string" &&
      result.log.length <= 120000 &&
      c.HASH.test(result.logHash || "") &&
      c.digest(result.log) === result.logHash
  );
}

function originals(bundle) {
  if (!Array.isArray(bundle.batches) || bundle.batches.length > 4)
    throw Error("Invalid exploratory batch history");
  const numbers = new Set();
  for (const batch of bundle.batches) {
    if (
      !Number.isInteger(batch?.number) ||
      batch.number < 1 ||
      batch.number > 4 ||
      numbers.has(batch.number) ||
      !Number.isInteger(batch.result?.code)
    )
      throw Error("Invalid exploratory batch execution record");
    numbers.add(batch.number);
  }
  return bundle.report.findings.map((finding) => {
    const latest = bundle.batches
      .filter((batch) => batch.file === finding.test && batch.mode === finding.mode)
      .sort((a, b) => b.number - a.number)[0];
    if (
      !latest ||
      typeof latest.test !== "string" ||
      Buffer.byteLength(latest.test) > 50000 ||
      !c.HASH.test(latest.testHash || "") ||
      c.digest(latest.test) !== latest.testHash ||
      latest.result?.mode !== finding.mode ||
      latest.result?.file !== finding.test ||
      !s.IMAGE.test(latest.result?.image || "") ||
      !failedIsolated(latest.result)
    )
      throw Error("Latest exploratory revision lacks a valid isolated RED artifact");
    return latest;
  });
}

async function assessCandidates({
  bundle,
  image,
  output,
  before = async () => {},
  run = s.sandbox,
  now = Date.now,
  quotaWaited = () => 0,
}) {
  // Treat proposals as inert data. Only the isolated sandbox receives their paths.
  const b = structuredClone(bundle);
  if (!s.IMAGE.test(image)) throw Error("Invalid immutable replay image");
  e.validateCandidateReport(b.report, { head: b.head, grantId: b.grantId });
  const selected = originals(b);
  const stat = fs.lstatSync(output);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Invalid replay output directory");
  const findings = [];
  for (const [index, finding] of b.report.findings.entries()) {
    const original = selected[index];
    const startedAt = now();
    const waitedAtStart = quotaWaited();
    // Only bounded GitHub quota sleeps extend the shared execution deadline.
    const deadline = () => startedAt + 300000 + (quotaWaited() - waitedAtStart);
    const folder = path.join(output, String(index));
    const tests = path.join(folder, "tests");
    // Fresh directories and exclusive creation prevent sibling proposals or existing paths
    // from changing the source selected for a particular finding.
    fs.mkdirSync(folder);
    fs.mkdirSync(tests);
    fs.writeFileSync(path.join(tests, finding.test), original.test, { flag: "wx", mode: 0o644 });
    let interrupted;
    const checkDeadline = () => {
      const deadlineAt = deadline();
      if (!Number.isFinite(deadlineAt) || now() >= deadlineAt)
        throw Error("Discovery replay five-minute finding deadline");
    };
    const execute = (stage, options) =>
      withStage(stage, async () => {
        try {
          checkDeadline();
          await before();
          checkDeadline();
        } catch (error) {
          interrupted = { error };
          throw error;
        }
        const result = await run({ image, ...options, deadlineAt: deadline() });
        try {
          checkDeadline();
        } catch (error) {
          interrupted = { error };
          throw error;
        }
        return result;
      });
    const proposedReplays = [];
    for (let count = 0; count < 2; count++)
      proposedReplays.push(
        await execute("proposal-replay", {
          tests,
          request: { mode: finding.mode, file: finding.test },
        })
      );
    const deterministic = proposedReplays.every(
      (result) =>
        result?.image === image &&
        result.mode === finding.mode &&
        result.file === finding.test &&
        failedIsolated(result)
    );
    const verified = await e.verifyReproducer({
      head: b.head,
      grantId: b.grantId,
      finding,
      baselinePassed: deterministic,
      replay: async (oracle) => {
        const result = await execute("oracle-replay", { oracle });
        if (result?.networkIsolated !== true || result.image !== image)
          throw Error("Trusted oracle isolation was not established");
        return result;
      },
    });
    // The verifier intentionally holds ordinary environment failures. Admission vetoes
    // and deadline exhaustion must instead stop the whole assessment immediately.
    if (interrupted) throw interrupted.error;
    findings.push({ finding, original, proposedReplays, ...verified });
  }
  return {
    version: 1,
    head: b.head,
    grantId: b.grantId,
    source: "claude-subscription",
    fixture: false,
    report: b.report,
    actualBatches: b.batches.map((batch) => ({
      number: batch.number,
      mode: batch.mode,
      file: batch.file,
      testHash: batch.testHash,
      code: batch.result.code,
    })),
    findings,
    sourceHash: b.sourceHash,
    coverageComplete: false,
    publication: "not-installed",
  };
}

module.exports = { assessCandidates, failedIsolated };
