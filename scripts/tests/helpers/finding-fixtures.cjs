const c = require("../../factory/discovery-contract.cjs");
const o = require("../../factory/discovery-oracles.cjs");
const p = require("../../factory/policy.cjs");
const functional = require("../../factory/discovery-functional.cjs");
const head = "a".repeat(40);
const grant = "77777777-7777-4777-8777-777777777777";
const context = {
  repository: p.REPOSITORY,
  actor: p.OWNER,
  triggeringActor: p.OWNER,
  ref: "refs/heads/main",
  workflowRef: `${p.REPOSITORY}/.github/workflows/factory-discovery-intake.yml@refs/heads/main`,
  workflowSha: head,
  runId: "200",
  runAttempt: 1,
  event: "workflow_dispatch",
};
function evidence(kind = "protected-route", route = "/users", grantId = grant) {
  const oracle = { kind, route, authenticated: false, query: {} };
  const finding = {
    title: `Contract violation ${route}`,
    summary: "Synthetic account contract failure",
    test: "access.api.test.cjs",
    mode: "api",
    oracle,
  };
  const observation = o.observe(oracle, kind === "unexpected-server-error" ? 500 : 200, {
    users: [],
  });
  const result = {
    version: 1,
    image: "sha256:" + "a".repeat(64),
    mode: "api",
    file: finding.test,
    code: 1,
    log: "AssertionError: private route returned200",
    networkIsolated: true,
  };
  result.logHash = c.digest(result.log);
  const original = {
    number: 1,
    mode: "api",
    file: finding.test,
    test: "// bounded synthetic repro",
    testHash: c.digest("// bounded synthetic repro"),
    result,
  };
  const row = {
    finding,
    original,
    proposedReplays: [structuredClone(result), structuredClone(result)],
    version: 1,
    status: "verified",
    head,
    grantId,
    oracle,
    fingerprint: c.digest([kind, route, observation.symptom]),
    replays: [
      { observation: structuredClone(observation), networkIsolated: true, image: result.image },
      { observation: structuredClone(observation), networkIsolated: true, image: result.image },
    ],
  };
  return {
    version: 1,
    head,
    grantId,
    source: "claude-subscription",
    fixture: false,
    sourceHash: "b".repeat(64),
    report: {
      version: 1,
      head,
      grantId,
      checked: [route],
      skipped: ["live app"],
      findings: [finding],
    },
    findings: [row],
    actualBatches: [],
    coverageComplete: false,
    publication: "not-installed",
  };
}
function functionalEvidence(charter = "functional-feed", grantId = grant) {
  const oracle =
    charter === "functional-feed"
      ? {
          kind: "feed-pagination",
          route: "/transactions/public",
          authenticated: true,
          query: { page: 2, limit: 5 },
        }
      : {
          kind: "unexpected-server-error",
          route: "/users/search",
          authenticated: true,
          query: { q: "Test User" },
        };
  const bundle = evidence("unexpected-server-error", oracle.route, grantId);
  const row = bundle.findings[0];
  const finding = functional.describeFinding(charter, { ...row.finding, oracle });
  bundle.report.findings = [finding];
  row.finding = finding;
  row.oracle = oracle;
  row.original.test = functional.proposal(charter, oracle);
  row.original.testHash = c.digest(row.original.test);
  const observation = o.observe(oracle, charter === "functional-feed" ? 200 : 500, {});
  row.fingerprint = c.digest([oracle.kind, oracle.route, observation.symptom]);
  row.replays.forEach((replay) => (replay.observation = structuredClone(observation)));
  return bundle;
}
function proof(g = grant, charter = "session") {
  const v = {
    version: 1,
    head,
    charter,
    day: "2026-11-17",
    ciRunId: "99",
    key: "",
    runId: "100",
    runAttempt: 1,
    workflowSha: head,
    workflowRef: c.WORKFLOW_REF,
  };
  v.key = c.sweepKey(head, v.charter, v.day);
  return v;
}
const artifact = {
  id: 123,
  name: `discovery-evidence-${grant}`,
  workflowRunId: "100",
  digest: "sha256:" + "c".repeat(64),
};
function memoryStore(initial) {
  let data = structuredClone(initial);
  return {
    async read() {
      return { state: structuredClone(data), commit: head };
    },
    async update(fn) {
      const r = await fn(structuredClone(data));
      if (r.state?.records && r.state?.replays && r.state?.imports)
        require("../../factory/discovery-finding-contract.cjs").validateFindings(r.state);
      data = structuredClone(r.state);
      return r;
    },
    get state() {
      return structuredClone(data);
    },
  };
}
module.exports = {
  head,
  grant,
  context,
  evidence,
  functionalEvidence,
  proof,
  artifact,
  memoryStore,
};
