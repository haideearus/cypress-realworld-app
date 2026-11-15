const fs = require("node:fs");
const path = require("node:path");
const { REPOSITORY, SHA } = require("./policy.cjs");
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === keys.split(",").sort().join(",");
const iso = (value) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
function validateAppChecks(result) {
  const contract = result && Object.hasOwn(result, "feedContract");
  const releasesValid =
    !contract ||
    (exact(result.releases, "before,after") &&
      Object.values(result.releases).every(
        (s) => s === null || (typeof s === "string" && SHA.test(s))
      ));
  const releaseStable =
    contract &&
    releasesValid &&
    result.releases.before !== null &&
    result.releases.before === result.releases.after;
  if (
    !exact(
      result,
      contract ? "healthy,checks,attempts,feedContract,releases" : "healthy,checks,attempts"
    ) ||
    !releasesValid ||
    !exact(result.checks, "login,session,feed,logout") ||
    typeof result.healthy !== "boolean" ||
    !Object.values(result.checks).every((v) => ["ok", "failed"].includes(v)) ||
    (contract && !["ok", "failed"].includes(result.feedContract)) ||
    result.healthy !==
      (Object.values(result.checks).every((v) => v === "ok") &&
        (!contract || (result.feedContract === "ok" && releaseStable))) ||
    !Number.isInteger(result.attempts) ||
    result.attempts < 1 ||
    result.attempts > 3
  )
    throw Error("Invalid app-check result");
  return structuredClone(result);
}
function appChecksEnabled(value) {
  if ([undefined, "", "false"].includes(value)) return false;
  if (value === "true") return true;
  throw Error("Invalid app-check configuration");
}
function monitorContext(env) {
  return {
    repository: env.GITHUB_REPOSITORY,
    ref: env.GITHUB_REF,
    workflowRef: env.GITHUB_WORKFLOW_REF,
    workflowSha: env.GITHUB_WORKFLOW_SHA,
    sha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    eventName: env.GITHUB_EVENT_NAME,
    actor: env.GITHUB_ACTOR,
    triggeringActor: env.GITHUB_TRIGGERING_ACTOR,
  };
}
function validateReport(report, context, now = new Date().toISOString()) {
  if (
    !exact(report, "version,repository,runId,runAttempt,workflowSha,at,result") ||
    report.version !== (Object.hasOwn(report.result || {}, "feedContract") ? 2 : 1) ||
    report.repository !== REPOSITORY ||
    context.repository !== REPOSITORY ||
    report.runId !== context.runId ||
    !/^[1-9]\d{0,15}$/.test(report.runId) ||
    report.runAttempt !== 1 ||
    context.runAttempt !== 1 ||
    !SHA.test(report.workflowSha || "") ||
    report.workflowSha !== context.workflowSha ||
    !iso(report.at) ||
    !iso(now) ||
    Date.parse(now) - Date.parse(report.at) > 600000 ||
    Date.parse(report.at) - Date.parse(now) > 5000
  )
    throw Error("Invalid current-run app-check report");
  return validateAppChecks(report.result);
}
function makeReport(result, context, at = new Date().toISOString()) {
  const report = {
    version: Object.hasOwn(result, "feedContract") ? 2 : 1,
    repository: context.repository,
    runId: context.runId,
    runAttempt: context.runAttempt,
    workflowSha: context.workflowSha,
    at,
    result: validateAppChecks(result),
  };
  validateReport(report, context, at);
  return report;
}
function reportPath(env) {
  if (
    typeof env.RUNNER_TEMP !== "string" ||
    !path.isAbsolute(env.RUNNER_TEMP) ||
    typeof env.GITHUB_RUN_ID !== "string" ||
    !/^[1-9]\d{0,15}$/.test(env.GITHUB_RUN_ID) ||
    env.GITHUB_RUN_ATTEMPT !== "1"
  )
    throw Error("Invalid app-check report path");
  return path.join(env.RUNNER_TEMP, `factory-app-checks-${env.GITHUB_RUN_ID}-1.json`);
}
function writeReport(env, report) {
  validateReport(report, monitorContext(env), report.at);
  const content = JSON.stringify(report) + "\n";
  if (Buffer.byteLength(content) > 8192) throw Error("Oversized app-check report");
  fs.writeFileSync(reportPath(env), content, { flag: "wx", mode: 0o600 });
}
function readReport(env, context, now = new Date().toISOString()) {
  let fd;
  try {
    const file = reportPath(env),
      before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 8192)
      throw Error();
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 8192 ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev
    )
      throw Error();
    const buffer = Buffer.alloc(8193),
      count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > 8192) throw Error();
    const result = validateReport(
      JSON.parse(buffer.subarray(0, count).toString("utf8")),
      context,
      now
    );
    if (
      Object.hasOwn(result, "feedContract") !==
      appChecksEnabled(env.FACTORY_FEED_CONTRACT_CHECK_ENABLED)
    )
      throw Error("App-check mode does not match this run");
    return result;
  } catch {
    throw Error("Invalid or unavailable app-check report");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
module.exports = {
  validateAppChecks,
  appChecksEnabled,
  monitorContext,
  validateReport,
  makeReport,
  reportPath,
  writeReport,
  readReport,
};
