const { createHash } = require("node:crypto");
const REPOSITORY = "haideearus/cypress-realworld-app";
const WORKFLOW = REPOSITORY + "/.github/workflows/factory-dependencies.yml@refs/heads/main";
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const criteria = (pr) => digest(["dependency-pr", 1, REPOSITORY, pr]);
const branch = (s) =>
  typeof s === "string" &&
  /^dependabot\/npm_and_yarn\/[A-Za-z0-9._/-]{1,180}$/.test(s) &&
  !s.split("/").some((x) => x === "." || x === "..");
const alertKey = (ref) => /^agent\/dependency-alert-([a-f0-9]{64})$/.exec(ref || "")?.[1];
const alertBranch = (key) => `agent/dependency-alert-${key}`;
function contextOK(c) {
  return !!(
    c &&
    c.repository === REPOSITORY &&
    ((c.actor === "haideearus" && c.triggeringActor === "haideearus") ||
      require("./trusted-wake.cjs").isTrustedWakeContext(c, "dependency")) &&
    c.ref === "refs/heads/main" &&
    ["schedule", "workflow_dispatch"].includes(c.event) &&
    c.workflowRef === WORKFLOW &&
    SHA.test(c.workflowSha || "") &&
    /^[1-9]\d*$/.test(c.runId || "") &&
    Number.isSafeInteger(c.runAttempt) &&
    c.runAttempt > 0
  );
}
function prOK(pr, closed = false, config = {}) {
  const native =
    branch(pr?.head?.ref) && pr?.user?.login === "dependabot[bot]" && pr.user.id === 49699333;
  const generated =
    config.alertRepair === true &&
    config.appSlug &&
    alertKey(pr?.head?.ref) &&
    pr?.user?.login === `${config.appSlug}[bot]` &&
    Number.isSafeInteger(pr.user.id) &&
    pr.user.id > 0;
  if (
    !pr ||
    !Number.isSafeInteger(pr.number) ||
    pr.number < 1 ||
    (!closed && pr.state !== "open") ||
    (closed && !["open", "closed"].includes(pr.state)) ||
    pr.draft !== false ||
    pr.user?.type !== "Bot" ||
    (!native && !generated) ||
    pr.head?.repo?.full_name !== REPOSITORY ||
    pr.base?.repo?.full_name !== REPOSITORY ||
    pr.base?.ref !== "main" ||
    !SHA.test(pr.head?.sha || "") ||
    !SHA.test(pr.base?.sha || "")
  )
    throw new Error("Untrusted dependency PR identity");
  return pr;
}
function filesOK(files, lockOnly = false) {
  if (
    !Array.isArray(files) ||
    files.length < 1 ||
    files.length > 2 ||
    new Set(files.map((f) => f.filename)).size !== files.length ||
    files.some(
      (f) =>
        !(lockOnly ? ["yarn.lock"] : ["package.json", "yarn.lock"]).includes(f.filename) ||
        f.status !== "modified" ||
        f.previous_filename !== undefined
    )
  )
    throw new Error("Dependency PR changes forbidden files");
}
const EVIDENCE_DELAY_MS = 60000;
const EVIDENCE_REASONS = {
  invalid_public_evidence: "Public package, advisory, release or CI evidence could not be verified",
  public_service_unavailable: "A public evidence service returned HTTP 502, 503 or 504",
  public_rate_limit: "A public evidence service rate limit blocked verification",
  candidate_changed: "The dependency PR or its base changed while checking evidence",
};
const timestamp = (value) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
function validateEvidenceHistory(attempt) {
  const records = attempt.evidence;
  if (records === undefined) return;
  if (!Array.isArray(records) || records.length < 1 || records.length > 2)
    throw new Error("Invalid dependency evidence history");
  for (const [index, record] of records.entries()) {
    const previous = records[index - 1];
    const keys = Object.keys(record || {})
      .sort()
      .join(",");
    if (
      !timestamp(record?.at) ||
      Date.parse(record.at) < Date.parse(attempt.at) ||
      (previous &&
        (previous.status !== "temporary" ||
          Date.parse(record.at) - Date.parse(previous.finishedAt) < EVIDENCE_DELAY_MS)) ||
      (record.status !== "started" &&
        (!timestamp(record.finishedAt) || Date.parse(record.finishedAt) < Date.parse(record.at)))
    )
      throw new Error("Invalid dependency evidence timing");
    if (
      !(
        (record.status === "started" && keys === "at,status") ||
        (record.status === "ready" &&
          keys === "at,digest,finishedAt,status" &&
          HASH.test(record.digest)) ||
        (record.status === "temporary" &&
          index === 0 &&
          keys === "at,finishedAt,reason,status" &&
          record.reason === "public_service_unavailable") ||
        (record.status === "held" &&
          keys === "at,finishedAt,reason,status" &&
          Object.hasOwn(EVIDENCE_REASONS, record.reason))
      )
    )
      throw new Error("Invalid dependency evidence result");
  }
}
function validateTicket(t, grants = []) {
  const d = t?.dependency;
  if (
    t?.origin !== "dependency-pr" ||
    t.coding !== 0 ||
    t.retries !== 0 ||
    !d ||
    d.version !== 1 ||
    d.pr !== t.pr ||
    !Number.isSafeInteger(t.pr) ||
    t.pr < 1 ||
    t.criteriaHash !== criteria(t.pr) ||
    (!branch(t.branch) && !alertKey(t.branch)) ||
    ["automatic", "monitor", "drill", "recovery"].some((k) => t[k] !== undefined) ||
    d.workflowRef !== WORKFLOW ||
    !SHA.test(d.workflowSha || "") ||
    !/^[1-9]\d*$/.test(d.runId || "") ||
    !Number.isSafeInteger(d.runAttempt) ||
    d.runAttempt < 1 ||
    !/^[a-z0-9][a-z0-9-]{0,98}$/.test(d.appSlug || "") ||
    !Array.isArray(d.attempts) ||
    d.attempts.length < 1 ||
    d.attempts.length > 10
  )
    throw new Error("Invalid dependency provenance");
  const seen = new Set();
  for (const a of d.attempts) {
    if (
      !a ||
      Object.keys(a)
        .filter((key) => key !== "evidence")
        .sort()
        .join(",") !== "at,base,head,runAttempt,runId,workflowSha" ||
      !SHA.test(a.head || "") ||
      !SHA.test(a.base || "") ||
      !SHA.test(a.workflowSha || "") ||
      !/^[1-9]\d*$/.test(a.runId || "") ||
      !Number.isSafeInteger(a.runAttempt) ||
      a.runAttempt < 1 ||
      !Number.isFinite(Date.parse(a.at)) ||
      new Date(a.at).toISOString() !== a.at ||
      seen.has(a.head)
    )
      throw new Error("Invalid dependency head history");
    validateEvidenceHistory(a);
    seen.add(a.head);
  }
  const first = d.attempts[0],
    last = d.attempts.at(-1);
  if (
    first.runId !== d.runId ||
    first.runAttempt !== d.runAttempt ||
    first.workflowSha !== d.workflowSha ||
    last.head !== t.head ||
    grants.some(
      (g) =>
        g.phase !== "review" ||
        g.slot !== "dependency" ||
        !d.attempts.some(
          (a) => a.head === g.head && a.runId === g.runId && a.runAttempt === g.runAttempt
        )
    ) ||
    new Set(grants.map((g) => g.head)).size !== grants.length
  )
    throw new Error("Dependency grant provenance changed");
  return last;
}
function matches(t, c, config) {
  const a = validateTicket(t);
  if (
    !contextOK(c) ||
    a.runId !== c.runId ||
    a.runAttempt !== c.runAttempt ||
    a.workflowSha !== c.workflowSha ||
    t.dependency.appSlug !== config.appSlug
  )
    throw new Error("Dependency lease belongs to another trusted run");
  return a;
}
module.exports = {
  REPOSITORY,
  WORKFLOW,
  SHA,
  HASH,
  EVIDENCE_DELAY_MS,
  EVIDENCE_REASONS,
  digest,
  criteria,
  branch,
  contextOK,
  alertKey,
  alertBranch,
  prOK,
  filesOK,
  validateTicket,
  matches,
};
