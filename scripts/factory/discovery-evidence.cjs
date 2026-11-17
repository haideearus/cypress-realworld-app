const c = require("./discovery-contract.cjs");
const o = require("./discovery-oracles.cjs");
const s = require("./discovery-sandbox.cjs");
const { secretLike } = require("./artifacts.cjs");
function texts(v, max = 30) {
  return (
    Array.isArray(v) &&
    v.length <= max &&
    v.every((x) => typeof x === "string" && x.trim() && x.length <= 1000 && !secretLike(x))
  );
}
function validateCandidateReport(r, { head, grantId }) {
  c.exact(r, ["version", "head", "grantId", "checked", "skipped", "findings"]);
  if (r.version !== 1 || r.head !== head || r.grantId !== grantId)
    throw Error("Invalid discovery report identity");
  if (!texts(r.checked) || !texts(r.skipped) || !Array.isArray(r.findings) || r.findings.length > 2)
    throw Error("Invalid discovery report bounds");
  for (const f of r.findings) {
    c.exact(f, ["title", "summary", "test", "mode", "oracle"]);
    if (!texts([f.title, f.summary]) || f.title.length > 200 || !s.FILE.test(f.test))
      throw Error("Invalid discovery finding");
    s.validateRequest({ mode: f.mode, file: f.test });
    if (f.oracle !== null) o.validateOracle(f.oracle);
  }
  if (secretLike(JSON.stringify(r))) throw Error("Discovery report contains secret-like content");
  return r;
}
function observationMatches(value, oracle) {
  return (
    value &&
    value.version === 1 &&
    value.kind === oracle.kind &&
    value.inputHash === o.oracleHash(oracle) &&
    Number.isInteger(value.status) &&
    value.status >= 100 &&
    value.status <= 599 &&
    typeof value.signature === "string" &&
    value.signature.length < 300 &&
    ["server-error", "unauthenticated-access", "other-account-access", "feed-contract"].includes(
      value.symptom
    ) &&
    !secretLike(JSON.stringify(value))
  );
}
async function verifyReproducer({ head, grantId, finding, baselinePassed, replay }) {
  if (!baselinePassed) return { status: "held", reason: "baseline-failed" };
  if (!finding.oracle) return { status: "held", reason: "unsupported-oracle" };
  o.validateOracle(finding.oracle);
  try {
    const first = await replay(finding.oracle);
    const second = await replay(finding.oracle);
    if (
      !observationMatches(first.observation, finding.oracle) ||
      !observationMatches(second.observation, finding.oracle) ||
      first.observation.signature !== second.observation.signature
    )
      return { status: "held", reason: "nonreproducing-or-flaky" };
    return {
      version: 1,
      status: "verified",
      head,
      grantId,
      oracle: finding.oracle,
      fingerprint: c.digest([finding.oracle.kind, finding.oracle.route, first.observation.symptom]),
      replays: [first, second],
    };
  } catch {
    return { status: "held", reason: "environment-or-startup" };
  }
}
module.exports = { validateCandidateReport, verifyReproducer, observationMatches };
