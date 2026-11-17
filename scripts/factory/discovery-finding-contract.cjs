const c = require("./discovery-contract.cjs");
const e = require("./discovery-evidence.cjs");
const o = require("./discovery-oracles.cjs");
const { UUID } = require("./monitor-proof.cjs");
const { secretLike } = require("./artifacts.cjs");
const WORKFLOW = ".github/workflows/factory-discovery-intake.yml";
const WORKFLOW_REF = `${c.REPOSITORY}/${WORKFLOW}@refs/heads/main`;
const STATES = [
  "verified",
  "held-stop",
  "held-quota",
  "publishing-intent",
  "published",
  "duplicate",
  "rejected",
  "observed-resolved",
  "held-evidence",
  "repair-merged",
];
function fingerprintFinding({ component, symptom, contract }) {
  return c.digest([contract, component, symptom]);
}
function sourceProof(source) {
  const { grantId, ...proof } = source;
  c.validateProof(proof);
  if (!UUID.test(grantId || "")) throw Error("Invalid source grant");
  return proof;
}
function contextOK(r) {
  return Boolean(
    r &&
      r.repository === c.REPOSITORY &&
      r.actor === "haideearus" &&
      r.triggeringActor === "haideearus" &&
      r.ref === "refs/heads/main" &&
      r.workflowRef === WORKFLOW_REF &&
      c.SHA.test(r.workflowSha || "") &&
      /^\d+$/.test(r.runId || "") &&
      r.runAttempt === 1 &&
      ["schedule", "workflow_run", "workflow_dispatch"].includes(r.event)
  );
}
function candidateFromEvidence(b, index, artifact, proof) {
  c.validateProof(proof);
  if (
    !b ||
    b.version !== 1 ||
    b.source !== "claude-subscription" ||
    b.fixture !== false ||
    b.head !== proof.head ||
    !UUID.test(b.grantId || "") ||
    !c.HASH.test(b.sourceHash || "") ||
    !Array.isArray(b.findings) ||
    b.findings.length > 2 ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= b.findings.length
  )
    throw Error("Invalid finding evidence");
  e.validateCandidateReport(b.report, { head: b.head, grantId: b.grantId });
  const x = b.findings[index],
    original = x?.original;
  if (
    x?.status !== "verified" ||
    x.head !== b.head ||
    x.grantId !== b.grantId ||
    !x.finding?.oracle ||
    JSON.stringify(x.finding) !== JSON.stringify(b.report.findings[index]) ||
    JSON.stringify(x.oracle) !== JSON.stringify(x.finding.oracle) ||
    !original ||
    original.mode !== x.finding.mode ||
    original.file !== x.finding.test ||
    typeof original.test !== "string" ||
    Buffer.byteLength(original.test) > 50000 ||
    c.digest(original.test) !== original.testHash ||
    !original.result ||
    !Number.isInteger(original.result.code) ||
    original.result.code < 1 ||
    original.result.code === 124 ||
    original.result.networkIsolated !== true ||
    typeof original.result.log !== "string" ||
    original.result.log.length > 120000 ||
    c.digest(original.result.log) !== original.result.logHash
  )
    throw Error("Invalid individually verified finding or changed RED evidence");
  if (
    !Array.isArray(x.proposedReplays) ||
    x.proposedReplays.length !== 2 ||
    x.proposedReplays.some(
      (r) => !Number.isInteger(r.code) || r.code < 1 || r.code === 124 || r.networkIsolated !== true
    ) ||
    !Array.isArray(x.replays) ||
    x.replays.length !== 2 ||
    x.replays.some(
      (r) =>
        r.networkIsolated !== true ||
        !e.observationMatches(r.observation, x.oracle) ||
        r.observation.signature !==
          `${x.oracle.route}:${r.observation.status}:${r.observation.symptom}`
    ) ||
    x.replays[0].observation.signature !== x.replays[1].observation.signature
  )
    throw Error("Invalid reproduced finding evidence");
  const fingerprint = fingerprintFinding({
    component: x.oracle.route,
    contract: x.oracle.kind,
    symptom: x.replays[0].observation.symptom,
  });
  if (
    x.fingerprint !== fingerprint ||
    !Number.isSafeInteger(artifact?.id) ||
    artifact.id < 1 ||
    artifact.name !== `discovery-evidence-${b.grantId}` ||
    String(artifact.workflowRunId) !== proof.runId ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest || "")
  )
    throw Error("Invalid finding artifact identity");
  if (secretLike(JSON.stringify(b))) throw Error("Invalid secret-bearing finding evidence");
  const row = {
    key: c.digest([b.grantId, c.digest(x.finding)]),
    fingerprint,
    source: { ...proof, grantId: b.grantId },
    artifact: { ...artifact },
    evidenceHash: c.digest(b),
    findingHash: c.digest(x.finding),
    testHash: original.testHash,
    redLogHash: original.result.logHash,
    oracleHash: o.oracleHash(x.oracle),
    title: x.finding.title,
    summary: x.finding.summary,
    mode: x.finding.mode,
    file: x.finding.test,
    oracle: x.oracle,
  };
  validateCandidate(row);
  return row;
}
function validateCandidate(r) {
  c.exact(r, [
    "key",
    "fingerprint",
    "source",
    "artifact",
    "evidenceHash",
    "findingHash",
    "testHash",
    "redLogHash",
    "oracleHash",
    "title",
    "summary",
    "mode",
    "file",
    "oracle",
  ]);
  sourceProof(r.source);
  o.validateOracle(r.oracle);
  require("./discovery-sandbox.cjs").validateRequest({ mode: r.mode, file: r.file });
  if (
    [
      "key",
      "fingerprint",
      "evidenceHash",
      "findingHash",
      "testHash",
      "redLogHash",
      "oracleHash",
    ].some((k) => !c.HASH.test(r[k] || "")) ||
    r.key !== c.digest([r.source.grantId, r.findingHash]) ||
    r.oracleHash !== o.oracleHash(r.oracle) ||
    typeof r.title !== "string" ||
    !r.title.trim() ||
    r.title.length > 200 ||
    typeof r.summary !== "string" ||
    !r.summary.trim() ||
    r.summary.length > 1000 ||
    secretLike(JSON.stringify(r))
  )
    throw Error("Invalid finding candidate");
  c.exact(r.artifact, ["id", "name", "workflowRunId", "digest"]);
  if (
    !Number.isSafeInteger(r.artifact.id) ||
    r.artifact.id < 1 ||
    r.artifact.name !== `discovery-evidence-${r.source.grantId}` ||
    String(r.artifact.workflowRunId) !== r.source.runId ||
    !/^sha256:[a-f0-9]{64}$/.test(r.artifact.digest || "")
  )
    throw Error("Invalid finding artifact");
  return r;
}
function emptyFindings() {
  return {
    version: 1,
    repository: c.REPOSITORY,
    records: {},
    days: {},
    sources: {},
    replays: {},
    imports: {},
  };
}
function validateFindings(s) {
  c.exact(s, ["version", "repository", "records", "days", "sources", "replays", "imports"]);
  if (
    s.version !== 1 ||
    s.repository !== c.REPOSITORY ||
    [s.records, s.days, s.sources, s.replays, s.imports].some(
      (x) => !x || Array.isArray(x) || typeof x !== "object"
    ) ||
    Object.keys(s.records).length > 400 ||
    Object.keys(s.replays).length > 3200 ||
    Object.keys(s.imports).length > 400
  )
    throw Error("Invalid or full finding registry");
  for (const [key, r] of Object.entries(s.records)) {
    if (
      Object.keys(r).some(
        (k) =>
          ![
            "candidate",
            "generation",
            "status",
            "publication",
            "duplicates",
            "intake",
            "comment",
            "resolution",
            "resolutionClosed",
            "resolutionHeld",
          ].includes(k)
      )
    )
      throw Error("Unexpected finding record data");
    validateCandidate(r.candidate);
    if (
      key !== r.candidate.key ||
      !STATES.includes(r.status) ||
      !Number.isSafeInteger(r.generation) ||
      r.generation < 1 ||
      !Array.isArray(r.duplicates) ||
      r.duplicates.length > 30
    )
      throw Error("Invalid finding record");
    if (r.publication) {
      const p = r.publication;
      c.exact(p, [
        "day",
        "context",
        "confirmation",
        "issue",
        "writeStarted",
        "title",
        "body",
        "criteriaHash",
      ]);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(p.day) ||
        !contextOK(p.context) ||
        (p.confirmation !== null && !contextOK(p.confirmation)) ||
        !c.HASH.test(p.criteriaHash || "") ||
        p.criteriaHash !== c.digest([p.title, p.body]) ||
        typeof p.writeStarted !== "boolean" ||
        typeof p.title !== "string" ||
        typeof p.body !== "string" ||
        p.body.length > 20000 ||
        c.digest(issueText(r)) !==
          c.digest({ title: p.title, body: p.body, criteriaHash: p.criteriaHash }) ||
        (p.issue !== null && (!Number.isSafeInteger(p.issue) || p.issue < 1))
      )
        throw Error("Invalid publication receipt");
    }
    if (r.intake) {
      validateReplay(r.intake);
      if (r.intake.key !== key || c.digest(s.replays[r.intake.id]) !== c.digest(r.intake))
        throw Error("Invalid current intake pointer");
    }
    for (const duplicate of r.duplicates) {
      const { comment, ...candidate } = duplicate;
      validateCandidate(candidate);
      validateComment(comment);
      if (candidate.fingerprint !== r.candidate.fingerprint)
        throw Error("Invalid duplicate fingerprint");
    }
    if (r.comment !== undefined) validateComment(r.comment);
    if (typeof r.resolutionClosed !== "boolean" || typeof r.resolutionHeld !== "boolean")
      throw Error("Invalid finding closure state");
    if (r.resolution !== null) {
      c.exact(r.resolution, ["kind", "pr", "head", "mergeCommit", "context"]);
      if (
        r.resolution.kind !== "protected-merge" ||
        !Number.isSafeInteger(r.resolution.pr) ||
        r.resolution.pr < 1 ||
        !c.SHA.test(r.resolution.head) ||
        !c.SHA.test(r.resolution.mergeCommit) ||
        !contextOK(r.resolution.context)
      )
        throw Error("Invalid protected finding resolution");
    }
    if (r.status === "repair-merged" && !r.resolution)
      throw Error("Missing merged finding resolution");
  }
  for (const [id, receipt] of Object.entries(s.replays)) {
    validateReplay(receipt);
    if (id !== receipt.id || !s.records[receipt.key])
      throw Error("Invalid retained replay identity");
  }
  for (const [grant, entry] of Object.entries(s.imports)) {
    c.exact(entry, ["runId", "evidenceHash", "findings", "status"]);
    if (
      !UUID.test(grant) ||
      !/^[1-9]\d*$/.test(entry.runId) ||
      !["complete", "held-evidence"].includes(entry.status) ||
      (entry.evidenceHash !== null && !c.HASH.test(entry.evidenceHash)) ||
      (entry.status === "complete" && entry.evidenceHash === null) ||
      !Array.isArray(entry.findings) ||
      entry.findings.length > 2 ||
      entry.findings.some((x) => !s.sources[grant]?.includes(x))
    )
      throw Error("Invalid source import receipt");
  }
  for (const [day, keys] of Object.entries(s.days))
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Array.isArray(keys) ||
      keys.length > 4 ||
      new Set(keys).size !== keys.length ||
      keys.some((k) => !s.records[k] || s.records[k].publication?.day !== day)
    )
      throw Error("Invalid retained publication day");
  for (const [grant, keys] of Object.entries(s.sources))
    if (
      !UUID.test(grant) ||
      !Array.isArray(keys) ||
      keys.length > 2 ||
      new Set(keys).size !== keys.length
    )
      throw Error("Invalid source finding limit");
  return s;
}
function validateComment(value) {
  if (value === null) return;
  c.exact(value, ["body", "context", "writeStarted", "id"]);
  if (
    !contextOK(value.context) ||
    typeof value.body !== "string" ||
    value.body.length > 5000 ||
    secretLike(value.body) ||
    typeof value.writeStarted !== "boolean" ||
    (value.id !== null && (!Number.isSafeInteger(value.id) || value.id < 1))
  )
    throw Error("Invalid finding comment intent");
}
function validateReplay(r) {
  c.exact(r, ["id", "key", "day", "head", "ciRunId", "context", "outcome", "evidenceHash"]);
  if (
    !c.HASH.test(r.id) ||
    !c.HASH.test(r.key) ||
    !c.SHA.test(r.head) ||
    !/^[1-9]\d*$/.test(r.ciRunId) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(r.day) ||
    !contextOK(r.context) ||
    r.id !== c.digest([r.key, r.context.runId, r.head]) ||
    !["intent", "ready", "held", "observed-resolved"].includes(r.outcome) ||
    (r.evidenceHash !== null && !c.HASH.test(r.evidenceHash)) ||
    (["ready", "observed-resolved"].includes(r.outcome) && r.evidenceHash === null)
  )
    throw Error("Invalid intake receipt");
  return r;
}
function issueText(r) {
  const x = r.candidate;
  const title = `[Discovery] ${x.oracle.kind} on ${x.oracle.route}`;
  const body = `Verified synthetic-app failure: ${x.oracle.kind} at ${x.oracle.route}.\n\nOriginal scan: ${x.source.head}\nOriginal RED test: ${x.file} (${x.mode}), SHA-256 ${x.testHash}\nOracle: ${JSON.stringify(x.oracle)}\nEvidence: https://github.com/${c.REPOSITORY}/actions/runs/${x.source.runId}\nArtifact: ${x.artifact.name} (id ${x.artifact.id})\nFinding SHA-256: ${x.findingHash}\n\nReported context (untrusted): ${x.summary}\n\nAcceptance: preserve the reproduced contract, prove RED before repair and GREEN afterward, pass independent review and protected CI. This is sandbox evidence; production deployment and live coverage remain separate. A current-main replay is required before coding admission.\n\n<!-- factory-discovery-finding:${x.fingerprint}:${r.generation}:${x.key} -->`;
  if (body.length > 20000 || secretLike(title + body)) throw Error("Unsafe finding ticket");
  return { title, body, criteriaHash: c.digest([title, body]) };
}
function originProof(r) {
  return {
    version: 1,
    key: r.candidate.key,
    candidateHash: c.digest(r.candidate),
    criteriaHash: r.publication.criteriaHash,
    issue: r.publication.issue,
  };
}
function validateOriginProof(p) {
  c.exact(p, ["version", "key", "candidateHash", "criteriaHash", "issue"]);
  if (
    p.version !== 1 ||
    [p.key, p.candidateHash, p.criteriaHash].some((x) => !c.HASH.test(x || "")) ||
    !Number.isSafeInteger(p.issue) ||
    p.issue < 1
  )
    throw Error("Invalid discovery finding proof");
  return p;
}
module.exports = {
  WORKFLOW,
  WORKFLOW_REF,
  STATES,
  contextOK,
  fingerprintFinding,
  sourceProof,
  candidateFromEvidence,
  validateCandidate,
  emptyFindings,
  validateFindings,
  issueText,
  originProof,
  validateOriginProof,
  validateReplay,
};
