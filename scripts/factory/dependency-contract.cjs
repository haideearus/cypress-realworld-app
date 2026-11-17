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
function prOK(pr, closed = false) {
  if (
    !pr ||
    !Number.isSafeInteger(pr.number) ||
    pr.number < 1 ||
    (!closed && pr.state !== "open") ||
    (closed && !["open", "closed"].includes(pr.state)) ||
    pr.draft !== false ||
    pr.user?.login !== "dependabot[bot]" ||
    pr.user?.type !== "Bot" ||
    pr.user?.id !== 49699333 ||
    pr.head?.repo?.full_name !== REPOSITORY ||
    pr.base?.repo?.full_name !== REPOSITORY ||
    pr.base?.ref !== "main" ||
    !SHA.test(pr.head?.sha || "") ||
    !SHA.test(pr.base?.sha || "") ||
    !branch(pr.head?.ref)
  )
    throw new Error("Untrusted dependency PR identity");
  return pr;
}
function filesOK(files) {
  if (
    !Array.isArray(files) ||
    files.length < 1 ||
    files.length > 2 ||
    new Set(files.map((f) => f.filename)).size !== files.length ||
    files.some(
      (f) =>
        !["package.json", "yarn.lock"].includes(f.filename) ||
        f.status !== "modified" ||
        f.previous_filename !== undefined
    )
  )
    throw new Error("Dependency PR changes forbidden files");
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
    !branch(t.branch) ||
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
      Object.keys(a).sort().join(",") !== "at,base,head,runAttempt,runId,workflowSha" ||
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
  digest,
  criteria,
  contextOK,
  prOK,
  filesOK,
  validateTicket,
  matches,
};
