const test = require("node:test");
const assert = require("node:assert/strict");
const c = require("../factory/discovery-contract.cjs");
const f = require("../factory/discovery-finding-contract.cjs");
const rc = require("../factory/discovery-recovery-contract.cjs");
const run = require("../factory/discovery-finding-run.cjs");
const o = require("../factory/discovery-oracles.cjs");
const pub = require("../factory/discovery-publication.cjs");
const fx = require("./helpers/finding-fixtures.cjs");
const saved = require("./fixtures/discovery-recovery-source.json");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const recoveryContext = {
  ...fx.context,
  workflowRef: rc.WORKFLOW_REF,
  runId: "500",
  ciRunId: "501",
};
function originalProof() {
  return {
    version: 1,
    head: rc.SOURCE.head,
    charter: "journeys",
    day: "2026-11-18",
    ciRunId: rc.SOURCE.ciRunId,
    key: rc.SOURCE.sweepHash,
    runId: rc.SOURCE.runId,
    runAttempt: 1,
    workflowSha: rc.SOURCE.head,
    workflowRef: c.WORKFLOW_REF,
  };
}
function recovered() {
  const registry = f.emptyFindings();
  const receipt = rc.reserve(registry, recoveryContext, "2026-11-18");
  const artifact = {
    id: 900,
    name: rc.artifactName(receipt.proof),
    workflowRunId: "500",
    digest: `sha256:${"d".repeat(64)}`,
  };
  rc.finish(registry, receipt.proof.id, artifact, recoveryContext);
  const report = structuredClone(saved.report);
  const findings = report.findings.map((finding, index) => {
    const original = structuredClone(saved.batches[index === 0 ? 0 : 2]);
    const expected =
      index === 0
        ? {
            id: "account",
            userId: "owner",
            bankName: "Synthetic bank",
            accountNumber: "1234",
            routingNumber: "5678",
            isDeleted: false,
          }
        : {
            id: "transaction",
            senderId: "sender",
            receiverId: "receiver",
            privacyLevel: "private",
            amount: 100,
            description: "Synthetic payment",
          };
    const owners = index === 0 ? ["owner"] : ["sender", "receiver"];
    const observation = o.observe(finding.oracle, 200, {
      expected,
      readerId: "reader",
      controls: owners.map((userId) => ({ userId, status: 200, resource: expected })),
      result: { present: true, denial: null, resource: expected },
    });
    return {
      version: 1,
      status: "verified",
      head: saved.head,
      grantId: saved.grantId,
      finding,
      original,
      proposedReplays: [original.result, structuredClone(original.result)],
      oracle: finding.oracle,
      fingerprint: c.digest([finding.oracle.kind, finding.oracle.route, observation.symptom]),
      replays: [
        { observation, networkIsolated: true },
        { observation: structuredClone(observation), networkIsolated: true },
      ],
    };
  });
  const bundle = {
    version: 1,
    head: saved.head,
    grantId: saved.grantId,
    source: "claude-subscription",
    fixture: false,
    sourceHash: saved.sourceHash,
    report,
    findings,
    actualBatches: saved.batches.map((x) => ({
      number: x.number,
      mode: x.mode,
      file: x.file,
      testHash: x.testHash,
      code: x.result.code,
    })),
    coverageComplete: false,
    publication: "not-installed",
    recovery: structuredClone(receipt.proof),
  };
  const controls = {
    tickets: {},
    grants: {
      [saved.grantId]: {
        id: saved.grantId,
        phase: "discover",
        slot: "discovery",
        status: "finished",
        outcome: "blocked",
        head: saved.head,
        runId: saved.runId,
        runAttempt: 1,
        ticket: 92,
      },
    },
  };
  const metadata = {
    ...artifact,
    expired: false,
    workflow_run: { id: 500, head_sha: recoveryContext.workflowSha },
  };
  return { registry, receipt, artifact, bundle, controls, metadata };
}
test("recovered candidates retain original source proof and separately identify replay provenance", () => {
  const x = recovered();
  for (let index = 0; index < 2; index++) {
    const candidate = f.candidateFromEvidence(x.bundle, index, x.artifact, originalProof());
    assert.deepEqual(f.sourceProof(candidate.source), originalProof());
    assert.deepEqual(candidate.source.recovery, x.receipt.proof);
    assert.equal(candidate.source.runId, saved.runId);
    assert.equal(candidate.artifact.workflowRunId, "500");
    assert.equal(f.validateCandidate(candidate), candidate);
  }
});
test("recovered report, latest RED, source proof and artifact substitution fail closed", () => {
  for (const mutate of [
    (x) => {
      x.bundle.report.findings[0].summary += "changed";
    },
    (x) => {
      x.bundle.findings[1].original = structuredClone(saved.batches[1]);
    },
    (x) => {
      x.artifact.workflowRunId = saved.runId;
    },
    (x) => {
      x.bundle.recovery.context.workflowSha = "e".repeat(40);
    },
  ]) {
    const x = recovered();
    mutate(x);
    assert.throws(() => f.candidateFromEvidence(x.bundle, 0, x.artifact, originalProof()));
  }
  const x = recovered(),
    candidate = f.candidateFromEvidence(x.bundle, 0, x.artifact, originalProof());
  for (const patch of [
    { ciRunId: "9" },
    { grantId: fx.grant },
    { runId: "9" },
    { key: "a".repeat(64) },
  ])
    assert.throws(() => f.sourceProof({ ...candidate.source, ...patch }));
  for (const patch of [
    { testHash: "a".repeat(64) },
    { title: "forged" },
    { findingHash: "a".repeat(64) },
    { summary: "forged" },
  ]) {
    const changed = { ...candidate, ...patch };
    changed.key = c.digest([changed.source.grantId, changed.findingHash]);
    assert.throws(() => f.validateCandidate(changed));
  }
});
test("recovery issue text adds its own replay link while legacy ticket text stays unchanged", () => {
  const x = recovered(),
    candidate = f.candidateFromEvidence(x.bundle, 0, x.artifact, originalProof());
  const row = { candidate, generation: 1 };
  assert.ok(
    f
      .issueText(row)
      .body.includes(
        "Recovery replay: https://github.com/haideearus/cypress-realworld-app/actions/runs/500"
      )
  );
  const legacy = f.candidateFromEvidence(fx.evidence(), 0, fx.artifact, fx.proof());
  const text = f.issueText({ candidate: legacy, generation: 1 }).body;
  assert.ok(!text.includes("Recovery replay:"));
  assert.ok(
    text.includes(
      "Evidence: https://github.com/haideearus/cypress-realworld-app/actions/runs/100\nArtifact:"
    )
  );
});
test("normal intake skips saved recovery sources and preserves their exact receipts", async () => {
  const x = recovered();
  const candidate = f.candidateFromEvidence(x.bundle, 0, x.artifact, originalProof());
  pub.stageFinding(x.registry, candidate);
  const store = fx.memoryStore(x.registry);
  const previous = store.state;
  const choice = await run.chooseSource({
    controls: x.controls,
    registry: x.registry,
    store,
    day: "2026-11-18",
    head: fx.head,
    api: { pages: async () => assert.fail("archived sources must not request artifacts") },
  });
  assert.equal(choice.sourceGrant, undefined);
  assert.deepEqual(store.state, previous);
});
test("a blocked ordinary source and a held recovery never become selectable", async () => {
  const x = recovered();
  x.registry.imports[saved.grantId].recoveries[0].outcome = "held";
  x.registry.imports[saved.grantId].recoveries[0].artifact = null;
  const choice = await run.chooseSource({
    controls: x.controls,
    registry: x.registry,
    day: "2026-11-18",
    head: fx.head,
    preview: true,
    api: {
      pages: async () => {
        assert.fail("held receipt must not request artifacts");
      },
    },
  });
  assert.equal(choice.sourceGrant, undefined);
});

test("functional publication refuses a directly supplied legacy grant and preserves recovery history", async (t) => {
  const x = recovered();
  x.controls.tickets[92] = { origin: "discovery-sweep", discovery: originalProof() };
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "recovered-publication-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(folder).startsWith("recovered-publication-"));
    fs.rmSync(folder, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(folder, "evidence.json"), JSON.stringify(x.bundle));
  const origin = require("../factory/discovery-origin.cjs"),
    discovery = require("../factory/discovery-run.cjs");
  const originals = {
    producer: origin.producer,
    verifySource: origin.verifySource,
    publishFinding: pub.publishFinding,
    appendDuplicates: pub.appendDuplicates,
    testedMain: discovery.testedMain,
  };
  t.after(() => {
    origin.producer = originals.producer;
    origin.verifySource = originals.verifySource;
    pub.publishFinding = originals.publishFinding;
    pub.appendDuplicates = originals.appendDuplicates;
    discovery.testedMain = originals.testedMain;
  });
  origin.producer = async () => {};
  origin.verifySource = async () => assert.fail("legacy source must not reach verification");
  pub.publishFinding = async () => {};
  pub.appendDuplicates = async () => {};
  discovery.testedMain = async () => ({ head: fx.head, ciRunId: "99" });
  const store = fx.memoryStore(x.registry);
  const vars = {
    ...require("./helpers/factory-fixtures.cjs").vars,
    FACTORY_AUTOMATION_ENABLED: "true",
    FACTORY_DISCOVERY_ENABLED: "true",
    FACTORY_GITHUB_APP_CLIENT_ID: "Iv1.fixture123",
    FACTORY_GITHUB_APP_SLUG: "fixture-app",
  };
  const env = {
    GITHUB_REPOSITORY: c.REPOSITORY,
    GITHUB_ACTOR: "haideearus",
    GITHUB_TRIGGERING_ACTOR: "haideearus",
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF: f.WORKFLOW_REF,
    GITHUB_WORKFLOW_SHA: fx.head,
    GITHUB_RUN_ID: "600",
    GITHUB_RUN_ATTEMPT: "1",
    FACTORY_OPERATION: "publish",
    FACTORY_VARIABLES: JSON.stringify(vars),
    FACTORY_FINDING_INPUT: folder,
    FACTORY_INPUTS: JSON.stringify({ sourceGrant: saved.grantId, artifactId: 900 }),
  };
  const api = {
    request: async () => assert.fail("legacy source must not request artifacts"),
  };
  const previous = store.state;
  await assert.rejects(
    run.main(env, { api, ledger: { read: async () => ({ state: x.controls }) }, store }),
    /Functional discovery charter required/
  );
  assert.deepEqual(store.state, previous);
  assert.equal(x.controls.grants[saved.grantId].outcome, "blocked");
});
