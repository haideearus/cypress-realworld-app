const { createHash } = require("node:crypto");
const REPOSITORY = "haideearus/cypress-realworld-app";
const WORKFLOW = REPOSITORY + "/.github/workflows/factory-dependencies.yml@refs/heads/main";
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const COMPATIBILITY_SLOT = "dependency_compat";
const COMPATIBILITY_REASONS = new Set([
  "native_ci_failure",
  "major_upgrade",
  "dependency_analysis_failure",
  "review_blocked",
]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const exact = (x, keys) => Boolean(x && Object.keys(x).sort().join(",") === keys);
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
function alertFilesOK(files, receipt) {
  filesOK(files, Boolean(receipt && !receipt.wider?.manifestChanged));
  if (
    receipt?.wider &&
    (files.length !== (receipt.wider.manifestChanged ? 2 : 1) ||
      !files.some((file) => file.filename === "yarn.lock"))
  )
    throw new Error("Wider dependency change does not match the publication receipt");
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
function validCompatibilityRequest(record) {
  return (
    exact(record, "package,reason") &&
    COMPATIBILITY_REASONS.has(record.reason) &&
    exact(record.package, "name,version") &&
    typeof record.package.name === "string" &&
    /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(record.package.name) &&
    record.package.name.length <= 214 &&
    typeof record.package.version === "string" &&
    /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(record.package.version) &&
    record.package.version.length <= 128
  );
}

function validArchivedCI(ci, head) {
  return (
    exact(ci, "head,passed,requestId,runId") &&
    ci.head === head &&
    UUID.test(ci.requestId || "") &&
    Number.isSafeInteger(ci.runId) &&
    ci.runId > 0 &&
    typeof ci.passed === "boolean"
  );
}

function validBlockingReview(result, head) {
  try {
    require("./artifacts.cjs").validateReview(result, head);
    return (
      result.verdict === "changes_requested" &&
      result.findings.some((finding) => ["important", "critical"].includes(finding.severity))
    );
  } catch {
    return false;
  }
}

function matchesBlockingGrant(attempt, grant) {
  const evidence = attempt.evidence?.at(-1);
  return Boolean(
    grant?.phase === "review" &&
      grant.slot === "dependency" &&
      grant.status === "finished" &&
      grant.outcome === "blocked" &&
      grant.head === attempt.head &&
      grant.runId === attempt.runId &&
      grant.runAttempt === attempt.runAttempt &&
      evidence?.status === "ready" &&
      timestamp(grant.at) &&
      grant.at >= evidence.finishedAt
  );
}

function validateArchivedReview(attempt, next, grants) {
  const review = attempt.review;
  if (review === undefined) return;
  if (
    !exact(review, "grantId,result") ||
    !UUID.test(review.grantId || "") ||
    !next?.compatibilityReclaim ||
    next.head !== attempt.head ||
    !validArchivedCI(attempt.ci, attempt.head) ||
    attempt.ci.passed !== true ||
    attempt.evidence?.at(-1)?.status !== "ready" ||
    !validBlockingReview(review.result, attempt.head) ||
    (grants &&
      !matchesBlockingGrant(
        attempt,
        grants.find((grant) => grant.id === review.grantId)
      ))
  )
    throw new Error("Invalid archived dependency blocking review");
}

function validateCompatibilityRefresh(attempt, next) {
  const refreshes = attempt.compatibilityRefreshes;
  if (refreshes === undefined) return;
  if (
    !Array.isArray(refreshes) ||
    refreshes.length < 1 ||
    refreshes.length > 10 ||
    new Set(refreshes.map((refresh) => refresh?.base)).size !== refreshes.length ||
    refreshes.some(
      (refresh, index) =>
        !exact(refresh, "at,base") ||
        !SHA.test(refresh.base || "") ||
        refresh.base === attempt.base ||
        refresh.base === attempt.head ||
        !timestamp(refresh.at) ||
        refresh.at < (refreshes[index - 1]?.at ?? attempt.at) ||
        (next && refresh.at > next.at)
    )
  )
    throw new Error("Invalid dependency compatibility refresh intents");
}

function validateCompatibility(attempt, next, grants) {
  const record = attempt.compatibility;
  if (record === undefined) return;
  const { grantId, publish, ...request } = record || {};
  const grant = grants?.find((g) => g.id === grantId);
  if (
    !validCompatibilityRequest(request) ||
    !UUID.test(grantId || "") ||
    (grants &&
      (grant?.phase !== "code" ||
        grant.slot !== COMPATIBILITY_SLOT ||
        grant.head !== attempt.head ||
        grant.runId !== attempt.runId ||
        grant.runAttempt !== attempt.runAttempt ||
        !timestamp(grant.at) ||
        grant.at < attempt.at ||
        (grant.status === "reserved"
          ? grant.outcome !== undefined
          : !["awaiting_review", "blocked"].includes(grant.outcome))))
  )
    throw new Error("Invalid dependency compatibility grant provenance");
  if (publish === undefined) {
    if (grant?.outcome === "awaiting_review")
      throw new Error("Dependency compatibility grant has no confirmed publication");
    return;
  }
  const finish = publish?.confirmedAt ?? publish?.abortedAt;
  if (
    !(
      exact(publish, "at,head") ||
      exact(publish, "at,confirmedAt,head") ||
      (exact(publish, "abortedAt,at,head,outcome") &&
        ["not_published", "changed"].includes(publish.outcome))
    ) ||
    !SHA.test(publish.head || "") ||
    publish.head === attempt.head ||
    !timestamp(publish.at) ||
    publish.at < (grant?.at ?? attempt.at) ||
    (finish !== undefined && (!timestamp(finish) || finish < publish.at)) ||
    (publish.confirmedAt !== undefined
      ? !next ||
        next.head !== publish.head ||
        next.base !== attempt.base ||
        next.at !== publish.confirmedAt ||
        (grant &&
          (grant.status !== "finished" || !["awaiting_review", "blocked"].includes(grant.outcome)))
      : grant?.outcome === "awaiting_review" ||
        (publish.abortedAt && grant && grant.outcome !== "blocked") ||
        (next && !publish.abortedAt))
  )
    throw new Error("Invalid dependency compatibility publication provenance");
}

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
function validateTicket(t, grants) {
  const d = t?.dependency;
  if (
    t?.origin !== "dependency-pr" ||
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
  const seen = new Map();
  const compat = new Set();
  const fixed = new Set();
  for (const [index, a] of d.attempts.entries()) {
    const previous = d.attempts[index - 1];
    const lastSeen = seen.get(a?.head);
    if (
      !a ||
      Object.keys(a)
        .filter(
          (key) =>
            ![
              "evidence",
              "compatibility",
              "compatibilityReclaim",
              "compatibilityContinuation",
              "compatibilityRefreshes",
              "compatibilityRefreshFrom",
              "ci",
              "review",
            ].includes(key)
        )
        .sort()
        .join(",") !== "at,base,head,runAttempt,runId,workflowSha" ||
      !SHA.test(a.head || "") ||
      !SHA.test(a.base || "") ||
      !SHA.test(a.workflowSha || "") ||
      !/^[1-9]\d*$/.test(a.runId || "") ||
      !Number.isSafeInteger(a.runAttempt) ||
      a.runAttempt < 1 ||
      !timestamp(a.at) ||
      (a.ci !== undefined && !validArchivedCI(a.ci, a.head)) ||
      (a.compatibilityReclaim === undefined && a.compatibilityContinuation === undefined
        ? lastSeen !== undefined
        : !previous ||
          ![undefined, true].includes(a.compatibilityReclaim) ||
          ![undefined, true].includes(a.compatibilityContinuation) ||
          (a.compatibilityReclaim === true) === (a.compatibilityContinuation === true) ||
          !branch(t.branch) ||
          lastSeen !== previous ||
          previous?.compatibilityReclaim === true ||
          (previous.compatibilityContinuation === true &&
            !(a.compatibilityReclaim === true && previous.review)) ||
          previous?.compatibility !== undefined ||
          previous?.base !== a.base ||
          a.at < previous.at ||
          (previous?.runId === a.runId && previous?.runAttempt === a.runAttempt) ||
          (a.compatibilityContinuation === true && !fixed.has(a.head)) ||
          (a.compatibilityReclaim === true &&
            fixed.has(a.head) &&
            previous.ci?.passed !== false &&
            previous.review === undefined)) ||
      (a.compatibilityRefreshFrom !== undefined &&
        (!previous ||
          a.head === previous.head ||
          a.compatibilityRefreshFrom !== previous.head ||
          !fixed.has(previous.head) ||
          !previous.compatibilityRefreshes?.some((record) => record.base === a.base))) ||
      ((a.compatibility !== undefined || t.aiSessionLimit !== undefined) && !branch(t.branch)) ||
      (a.compatibility && compat.has(a.compatibility.grantId))
    )
      throw new Error("Invalid dependency head history");
    validateEvidenceHistory(a);
    validateCompatibility(a, d.attempts[index + 1], grants);
    validateCompatibilityRefresh(a, d.attempts[index + 1]);
    validateArchivedReview(a, d.attempts[index + 1], grants);
    if (
      a.compatibility &&
      (a.compatibility.reason === "review_blocked") !==
        Boolean(a.compatibilityReclaim && previous?.review)
    )
      throw new Error("Dependency compatibility repair lacks its archived review evidence");
    if (
      a.compatibilityRefreshFrom !== undefined ||
      previous?.compatibility?.publish?.confirmedAt === a.at
    )
      fixed.add(a.head);
    if (a.compatibilityRefreshes !== undefined && !fixed.has(a.head))
      throw new Error("Dependency refresh requires confirmed compatibility provenance");
    if (a.compatibility) compat.add(a.compatibility.grantId);
    seen.set(a.head, a);
  }
  const first = d.attempts[0],
    last = d.attempts.at(-1),
    reviews = grants?.filter((g) => g.phase === "review") ?? [];
  if (
    first.runId !== d.runId ||
    first.runAttempt !== d.runAttempt ||
    first.workflowSha !== d.workflowSha ||
    last.head !== t.head ||
    t.coding !== compat.size ||
    t.retries !== Math.max(0, t.coding - 1) ||
    t.coding > 0 !== (t.aiSessionLimit !== undefined) ||
    grants?.some((g) => g.phase !== "review" && !compat.has(g.id)) ||
    reviews.some(
      (g) =>
        g.slot !== "dependency" ||
        !d.attempts.some(
          (a) => a.head === g.head && a.runId === g.runId && a.runAttempt === g.runAttempt
        )
    ) ||
    new Set(reviews.map((g) => g.head)).size !== reviews.length
  )
    throw new Error("Dependency grant provenance changed");
  require("./dependency-merge-retry.cjs").validate(t, d.attempts, grants ?? []);
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
function compatibilityWakeMatches(ticket, context) {
  const target = require("./trusted-wake.cjs").dependencyWakeTarget(context);
  const attempt = ticket?.dependency?.attempts?.at(-1);
  return Boolean(
    target?.compatibility &&
      target.number === ticket?.pr &&
      target.head === ticket.head &&
      target.base === attempt?.base
  );
}
function compatibilityForHead(t) {
  let expected = t?.head;
  for (const attempt of [...(t?.dependency?.attempts ?? [])].reverse()) {
    if (
      attempt.compatibility?.publish?.confirmedAt &&
      attempt.compatibility.publish.head === expected
    )
      return attempt;
    if (attempt.head === expected && attempt.compatibilityRefreshFrom)
      expected = attempt.compatibilityRefreshFrom;
  }
}
function archivedCompatibilityReview(t) {
  const attempts = t?.dependency?.attempts;
  return attempts?.at(-1)?.compatibilityReclaim ? attempts.at(-2)?.review : undefined;
}
module.exports = {
  REPOSITORY,
  WORKFLOW,
  SHA,
  HASH,
  COMPATIBILITY_SLOT,
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
  alertFilesOK,
  validCompatibilityRequest,
  validArchivedCI,
  validBlockingReview,
  matchesBlockingGrant,
  archivedCompatibilityReview,
  compatibilityForHead,
  compatibilityWakeMatches,
  validateTicket,
  matches,
};
