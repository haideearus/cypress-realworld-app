const fs = require("node:fs");
const { REPOSITORY, OWNER, SHA } = require("./policy.cjs");
const { UUID, validateMonitorProof } = require("./monitor-proof.cjs");
const { reportPath } = require("./app-checks-contract.cjs");
const { sameRepair, validateBlockedRecovery } = require("./monitor-blocked-recovery-contract.cjs");
const WORKFLOW = ".github/workflows/factory-monitor-acknowledge.yml";
const REASON = "observed-recovered-no-code-repair";
const exact = (o, keys) =>
  o &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  Object.keys(o).sort().join(",") === keys.split(",").sort().join(",");
const iso = (s) =>
  typeof s === "string" && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const runId = (s) =>
  typeof s === "string" && /^[1-9]\d{0,15}$/.test(s) && Number.isSafeInteger(Number(s));
function requireAck(ok) {
  if (!ok) throw Error("Acknowledgment preconditions or evidence unavailable");
}
function assertAckContext(c) {
  requireAck(
    c.repository === REPOSITORY &&
      c.actor === OWNER &&
      c.triggeringActor === OWNER &&
      c.ref === "refs/heads/main" &&
      c.workflowRef === `${REPOSITORY}/${WORKFLOW}@refs/heads/main` &&
      SHA.test(c.workflowSha || "") &&
      c.sha === c.workflowSha &&
      c.runAttempt === 1 &&
      c.eventName === "workflow_dispatch" &&
      runId(c.runId)
  );
}
function assertAckSettings(s, blockedRepair = false) {
  requireAck(
    s &&
      typeof blockedRepair === "boolean" &&
      ["FACTORY_ENABLED", "FACTORY_AUTOMATION_ENABLED", "FACTORY_AUTOMERGE_ENABLED"].every(
        (k) => s[k] === "false"
      ) &&
      [undefined, "", "false", ...(blockedRepair ? ["true"] : [])].includes(
        s.FACTORY_FEED_CONTRACT_CHECK_ENABLED
      )
  );
}
function validateAckResult(r, blockedRepair = false) {
  requireAck(
    exact(
      r,
      blockedRepair
        ? "healthy,checks,attempts,releases,feedContract"
        : "healthy,checks,attempts,releases"
    ) &&
      (!blockedRepair || ["ok", "failed"].includes(r.feedContract)) &&
      exact(r.checks, "login,session,feed,logout") &&
      Object.values(r.checks).every((v) => ["ok", "failed"].includes(v)) &&
      Number.isInteger(r.attempts) &&
      r.attempts >= 1 &&
      r.attempts <= 3 &&
      exact(r.releases, "before,after") &&
      Object.values(r.releases).every(
        (s) => s === null || (typeof s === "string" && SHA.test(s))
      ) &&
      typeof r.healthy === "boolean" &&
      r.healthy ===
        (Object.values(r.checks).every((v) => v === "ok") &&
          (!blockedRepair || r.feedContract === "ok") &&
          r.releases.before !== null &&
          r.releases.before === r.releases.after)
  );
  return r;
}
function validateAckReport(r, c, now = new Date().toISOString(), blockedRepair = false) {
  assertAckContext(c);
  requireAck(
    exact(r, "version,kind,repository,runId,runAttempt,workflowSha,at,result") &&
      r.version === 1 &&
      r.kind ===
        (blockedRepair ? "feed-contract-recovery-observation" : "standard-recovery-observation") &&
      r.repository === REPOSITORY &&
      r.runId === c.runId &&
      r.runAttempt === 1 &&
      r.workflowSha === c.workflowSha &&
      iso(r.at) &&
      iso(now) &&
      Date.parse(now) - Date.parse(r.at) <= 600000 &&
      Date.parse(r.at) - Date.parse(now) <= 5000
  );
  validateAckResult(r.result, blockedRepair);
  return r;
}
function makeAckReport(result, c, at = new Date().toISOString(), blockedRepair = false) {
  const r = {
    version: 1,
    kind: blockedRepair ? "feed-contract-recovery-observation" : "standard-recovery-observation",
    repository: REPOSITORY,
    runId: c.runId,
    runAttempt: 1,
    workflowSha: c.workflowSha,
    at,
    result,
  };
  return validateAckReport(r, c, at, blockedRepair);
}
function writeAckReport(env, r, c, blockedRepair = false) {
  validateAckReport(r, c, r.at, blockedRepair);
  const content = JSON.stringify(r) + "\n";
  requireAck(Buffer.byteLength(content) <= 8192);
  fs.writeFileSync(reportPath(env), content, { flag: "wx", mode: 0o600 });
}
function readAckReport(env, c, now = new Date().toISOString(), blockedRepair = false) {
  let fd;
  try {
    const file = reportPath(env),
      before = fs.lstatSync(file);
    requireAck(
      before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= 8192
    );
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    requireAck(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.size <= 8192 &&
        stat.ino === before.ino &&
        stat.dev === before.dev
    );
    const buffer = Buffer.alloc(8193),
      count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    requireAck(count <= 8192);
    return validateAckReport(
      JSON.parse(buffer.subarray(0, count).toString("utf8")),
      c,
      now,
      blockedRepair
    );
  } catch {
    throw Error("Invalid or unavailable acknowledgment report");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function runIdentity(o) {
  return (
    exact(o, "runId,runAttempt,workflowSha") &&
    runId(o.runId) &&
    o.runAttempt === 1 &&
    SHA.test(o.workflowSha || "")
  );
}
function validateAcknowledgment(a) {
  const blockedRepair = a && Object.hasOwn(a, "blockedRecovery");
  const refreshed = a?.verification && Object.hasOwn(a.verification, "blockedRecovery");
  requireAck(
    exact(
      a,
      "version,kind,phase,operationId,actor,reason,at,proof,request,verification" +
        (blockedRepair ? ",blockedRecovery" : "")
    ) &&
      a.version === 1 &&
      a.kind === "owner-observed-recovery" &&
      ["intent", "complete"].includes(a.phase) &&
      UUID.test(a.operationId || "") &&
      a.actor === OWNER &&
      a.reason === REASON &&
      iso(a.at) &&
      validateMonitorProof(a.proof) &&
      (blockedRepair ? a.proof.probeMode === "feed-contract" : a.proof.version === 1) &&
      runIdentity(a.request) &&
      exact(
        a.verification,
        "runId,runAttempt,workflowSha,at,reportAt,release" + (refreshed ? ",blockedRecovery" : "")
      ) &&
      (!refreshed || (blockedRepair && a.phase === "complete")) &&
      runIdentity({
        runId: a.verification.runId,
        runAttempt: a.verification.runAttempt,
        workflowSha: a.verification.workflowSha,
      }) &&
      iso(a.verification.at) &&
      iso(a.verification.reportAt) &&
      SHA.test(a.verification.release || "") &&
      Date.parse(a.at) <= Date.parse(a.verification.at) &&
      Date.parse(a.verification.at) - Date.parse(a.verification.reportAt) <= 600000 &&
      Date.parse(a.verification.reportAt) - Date.parse(a.verification.at) <= 5000
  );
  if (blockedRepair) {
    const { observations } = validateBlockedRecovery(a.blockedRecovery);
    requireAck(
      observations.length === 2 &&
        observations.every(
          (row) =>
            row.runId !== a.request.runId &&
            row.runId !== a.verification.runId &&
            row.runId !== a.proof.runId &&
            (refreshed || row.release === a.verification.release) &&
            Date.parse(row.at) < Date.parse(a.at)
        )
    );
    if (refreshed) {
      const replacement = validateBlockedRecovery(a.verification.blockedRecovery);
      requireAck(
        sameRepair(a.blockedRecovery.repair, replacement.repair) &&
          replacement.observations.length === 2 &&
          replacement.observations.every(
            (row) =>
              row.runId !== a.request.runId &&
              row.runId !== a.verification.runId &&
              row.release === a.verification.release &&
              Date.parse(row.at) > Date.parse(a.at) &&
              Date.parse(row.at) < Date.parse(a.verification.at)
          )
      );
    }
  }
  return a;
}
module.exports = {
  WORKFLOW,
  REASON,
  requireAck,
  assertAckContext,
  assertAckSettings,
  validateAckResult,
  validateAckReport,
  makeAckReport,
  writeAckReport,
  readAckReport,
  validateAcknowledgment,
};
