const c = require("./discovery-contract.cjs");
const rc = require("./discovery-recovery-contract.cjs");
const FINDINGS = [
  "174cac0da0ea08536b2ee60b5e4478378bb095247b20b0ae2c26a77b91bf88a0",
  "bcff5ff8e6b74f67a78ef382f903430df97446c9729d972818e27a670cc49338",
];
const RED = [
  [
    "4504053811998b54b9db8d5d99eab3e514764576ee26c65e35f3218dfd7aa85a",
    "be8884537cb2eee5c2220f2e23ad0895769a660f2c48035ed2ca3a896ee385fb",
  ],
  [
    "de6178f6cbe689c0faefc7fa04367a2e93bf1db3569c2cb5b61776aecdc72f85",
    "48b169f38ee8efc9ed58ebae4d3a006be84c29766f81bb9a2bb64b47aa57a0b6",
  ],
];
function validateEvidence(b, proof) {
  rc.validateProof(proof);
  if (
    !b ||
    b.version !== 1 ||
    b.head !== rc.SOURCE.head ||
    b.grantId !== rc.SOURCE.grantId ||
    b.source !== "claude-subscription" ||
    b.fixture !== false ||
    b.sourceHash !== rc.SOURCE.sourceHash ||
    c.digest(b.report) !== rc.SOURCE.reportHash ||
    c.digest(b.recovery) !== c.digest(proof) ||
    !Array.isArray(b.findings) ||
    b.findings.length !== 2
  )
    throw Error("Changed saved recovery evidence");
  for (const [index, row] of b.findings.entries()) {
    const original = row?.original;
    if (
      c.digest(row?.finding) !== c.digest(b.report.findings[index]) ||
      !["verified", "held"].includes(row.status) ||
      original?.testHash !== RED[index][0] ||
      c.digest(original.test) !== RED[index][0] ||
      original.result?.logHash !== RED[index][1] ||
      c.digest(original.result.log) !== RED[index][1]
    )
      throw Error("Changed latest original recovery RED");
  }
  if (require("./artifacts.cjs").secretLike(JSON.stringify(b)))
    throw Error("Unsafe recovered evidence");
  return b;
}
function validateCandidate(r) {
  const index =
    r.file === "bank-account-isolation.api.test.cjs"
      ? 0
      : r.file === "private-transaction-isolation.api.test.cjs"
        ? 1
        : -1;
  if (
    index < 0 ||
    r.testHash !== RED[index][0] ||
    r.redLogHash !== RED[index][1] ||
    r.findingHash !== FINDINGS[index] ||
    c.digest({
      title: r.title,
      summary: r.summary,
      test: r.file,
      mode: r.mode,
      oracle: r.oracle,
    }) !== FINDINGS[index] ||
    r.oracleHash !== require("./discovery-oracles.cjs").oracleHash(r.oracle) ||
    r.fingerprint !==
      c.digest([
        r.oracle.kind,
        r.oracle.route,
        index === 0 ? "other-bank-account-access" : "private-transaction-access",
      ])
  )
    throw Error("Changed saved recovery candidate");
}
module.exports = { validateEvidence, validateCandidate };
