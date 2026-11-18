const test = require("node:test");
const assert = require("node:assert/strict");
const c = require("../factory/discovery-contract.cjs");
const saved = require("./fixtures/discovery-recovery-source.json");
let origin = {};
try {
  origin = require("../factory/discovery-recovery-origin.cjs");
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}
const SOURCE = {
  head: saved.head,
  grantId: saved.grantId,
  runId: saved.runId,
  ticket: 92,
  runAttempt: 1,
  ciRunId: "44193429894",
  sweepHash: "a08fb48436040bc3ad2e14967e84098e6e98ab708f2f8913ce89860538721639",
  artifactId: 14380786056,
  artifactName: `discovery-${saved.grantId}`,
  artifactDigest: "sha256:8fee701b78e201e4a32782633da6163c613b2350320614257aafa477e8ff0a05",
  artifactSize: 4281,
  bundleHash: c.digest(saved),
  sourceHash: saved.sourceHash,
  reportHash: c.digest(saved.report),
};
const WORKFLOW = ".github/workflows/factory-discovery-recovery.yml";
const owner = { login: "haideearus", id: 101267861 };
function context(runId = "500", workflowSha = "b".repeat(40)) {
  return {
    repository: c.REPOSITORY,
    actor: owner.login,
    triggeringActor: owner.login,
    ref: "refs/heads/main",
    event: "workflow_dispatch",
    workflowRef: `${c.REPOSITORY}/${WORKFLOW}@refs/heads/main`,
    workflowSha,
    runId,
    runAttempt: 1,
    ciRunId: runId === "500" ? "501" : "503",
  };
}
function producer(ctx, path = WORKFLOW, workflowId = 20) {
  return {
    id: Number(ctx.runId),
    workflow_id: workflowId,
    path,
    run_attempt: 1,
    head_sha: ctx.workflowSha,
    head_branch: "main",
    repository: { full_name: c.REPOSITORY },
    head_repository: { full_name: c.REPOSITORY },
    actor: { ...owner },
    triggering_actor: { ...owner },
    event: ctx.event,
    status: "completed",
    conclusion: "success",
  };
}
function job(run, name, step) {
  return {
    name,
    run_id: run.id,
    run_attempt: 1,
    head_sha: run.head_sha,
    status: "completed",
    conclusion: "success",
    steps: [{ name: step, status: "completed", conclusion: "success" }],
  };
}
function fixture() {
  const proof = {
    version: 1,
    head: SOURCE.head,
    charter: "journeys",
    day: "2026-11-18",
    ciRunId: SOURCE.ciRunId,
    key: SOURCE.sweepHash,
    runId: SOURCE.runId,
    runAttempt: 1,
    workflowSha: SOURCE.head,
    workflowRef: c.WORKFLOW_REF,
  };
  const state = {
    days: { [proof.day]: [92] },
    grants: {
      [SOURCE.grantId]: {
        id: SOURCE.grantId,
        ticket: 92,
        phase: "discover",
        slot: "discovery",
        status: "finished",
        outcome: "blocked",
        head: SOURCE.head,
        runId: SOURCE.runId,
        runAttempt: 1,
      },
    },
    tickets: {
      92: {
        origin: "discovery-sweep",
        status: "blocked",
        discovery: proof,
        head: SOURCE.head,
        coding: 0,
        reviews: 0,
        retries: 0,
        pr: null,
        approval: null,
      },
    },
  };
  const registry = {
    sources: { [proof.key]: { status: "created", issue: 92, proof: structuredClone(proof) } },
  };
  const audit = {
    number: 92,
    user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    labels: [],
    body: require("../factory/discovery-run.cjs").sourceBody(proof),
  };
  const original = producer(
    { runId: SOURCE.runId, workflowSha: SOURCE.head, event: "workflow_dispatch" },
    ".github/workflows/factory-discovery.yml",
    10
  );
  original.conclusion = "failure";
  const ctx = context();
  const recoveryProof = {
    version: 1,
    id: c.digest([SOURCE.grantId, ctx.runId, ctx.workflowSha]),
    source: SOURCE,
    context: ctx,
  };
  const artifact = {
    id: 910,
    name: `discovery-recovery-${recoveryProof.id}`,
    workflowRunId: ctx.runId,
    digest: "sha256:" + "d".repeat(64),
  };
  const receipt = {
    proof: recoveryProof,
    day: "2026-11-18",
    outcome: "assessed",
    artifact,
    confirmation: structuredClone(ctx),
  };
  const finding = saved.report.findings[0];
  const findingHash = c.digest(finding);
  const candidate = {
    key: c.digest([SOURCE.grantId, findingHash]),
    fingerprint: c.digest([finding.oracle.kind, finding.oracle.route, "other-bank-account-access"]),
    source: { ...proof, grantId: SOURCE.grantId, recovery: structuredClone(recoveryProof) },
    artifact: { ...artifact },
    evidenceHash: "e".repeat(64),
    findingHash,
    testHash: saved.batches[0].testHash,
    redLogHash: saved.batches[0].result.logHash,
    oracleHash: require("../factory/discovery-oracles.cjs").oracleHash(finding.oracle),
    title: finding.title,
    summary: finding.summary,
    mode: finding.mode,
    file: finding.test,
    oracle: finding.oracle,
  };
  const store = { imports: { [SOURCE.grantId]: { runId: SOURCE.runId, recoveries: [receipt] } } };
  const runs = {
    [SOURCE.runId]: original,
    500: producer(ctx),
    502: producer(context("502", "c".repeat(40))),
  };
  const jobs = {
    [SOURCE.runId]: [job(original, "discover", "Run the one reserved Claude discovery session")],
    500: [
      job(runs["500"], "replay", "Replay saved privacy candidates without a model"),
      job(runs["500"], "finalize", "Retain recovered proof or a visible hold"),
    ],
    502: [job(runs["502"], "select", "Verify source and reserve or reconcile recovery")],
  };
  const ci = (id, head) => ({
    ...producer(
      { runId: id, workflowSha: head, event: "push" },
      ".github/workflows/factory-ci.yml",
      30
    ),
  });
  const cis = {
    [SOURCE.ciRunId]: ci(SOURCE.ciRunId, SOURCE.head),
    501: ci("501", ctx.workflowSha),
    503: ci("503", "c".repeat(40)),
  };
  const originalArtifact = {
    id: SOURCE.artifactId,
    name: SOURCE.artifactName,
    digest: SOURCE.artifactDigest,
    size_in_bytes: SOURCE.artifactSize,
    expired: false,
    workflow_run: { id: Number(SOURCE.runId), head_sha: SOURCE.head },
  };
  const recoveryArtifact = {
    ...artifact,
    expired: false,
    size_in_bytes: 2000,
    workflow_run: { id: 500, head_sha: ctx.workflowSha },
  };
  const requests = [];
  const api = {
    async request(method, url) {
      assert.equal(method, "GET", "provenance verification must never mutate GitHub");
      requests.push(url);
      if (url.endsWith("/issues/92")) return structuredClone(audit);
      const workflow = url.match(/\/actions\/workflows\/(.+)$/)?.[1];
      if (workflow)
        return {
          id: workflow === "factory-discovery.yml" ? 10 : workflow === "factory-ci.yml" ? 30 : 20,
          path: `.github/workflows/${workflow}`,
        };
      const runId = url.match(/\/actions\/runs\/(\d+)(?:\/attempts\/1)?$/)?.[1];
      if (runId && (runs[runId] || cis[runId])) return structuredClone(runs[runId] || cis[runId]);
      if (url.endsWith(`/actions/artifacts/${SOURCE.artifactId}`))
        return structuredClone(originalArtifact);
      if (url.endsWith("/actions/artifacts/910")) return structuredClone(recoveryArtifact);
      throw Error("Unexpected offline GET " + url);
    },
    async pages(url, key) {
      assert.equal(key, "jobs");
      const runId = url.match(/\/actions\/runs\/(\d+)\/attempts\/1\/jobs/)?.[1];
      assert.ok(jobs[runId], "Unexpected job provenance request");
      return structuredClone(jobs[runId]);
    },
  };
  const memory = (value) => ({
    async read() {
      return { state: structuredClone(value) };
    },
  });
  const dependencies = { ledger: memory(state), discovery: memory(registry), store: memory(store) };
  return {
    api,
    proof,
    state,
    registry,
    audit,
    original,
    ctx,
    receipt,
    candidate,
    store,
    runs,
    jobs,
    cis,
    originalArtifact,
    recoveryArtifact,
    dependencies,
    requests,
  };
}

test("original recovery source verifier exists", () =>
  assert.equal(typeof origin.verifyOriginal, "function", "missing recovery origin verifier"));
test("original provenance returns only the pinned artifact and unchanged original proof", async () => {
  const x = fixture();
  assert.deepEqual(await origin.verifyOriginal(x.api, x.dependencies), {
    artifact: x.originalArtifact,
    proof: x.proof,
  });
  assert.equal(x.state.grants[SOURCE.grantId].outcome, "blocked");
});
test("a blocked consumed source cannot be replaced by a successful, cancelled or refunded source", async () => {
  for (const mutate of [
    (x) => (x.state.grants[SOURCE.grantId].status = "reserved"),
    (x) => (x.state.grants[SOURCE.grantId].outcome = "discovery_complete"),
    (x) => (x.state.grants[SOURCE.grantId].slot = "coding"),
    (x) => (x.state.grants[SOURCE.grantId].runId = "1"),
    (x) => (x.state.tickets[92].status = "discovery_complete"),
    (x) => (x.state.tickets[92].coding = 1),
    (x) => (x.state.days[x.proof.day] = []),
    (x) => (x.registry.sources[x.proof.key].status = "intent"),
    (x) => (x.registry.sources[x.proof.key].issue = 91),
    (x) => (x.audit.body += "edited"),
    (x) => (x.audit.user.id = 1),
    (x) => x.audit.labels.push({ name: "factory-ready" }),
  ]) {
    const x = fixture();
    mutate(x);
    await assert.rejects(
      origin.verifyOriginal(x.api, x.dependencies),
      /source|original|audit|grant|usage/i
    );
  }
});
test("original failed run still requires the exact real model job, trusted workflow and original push CI", async () => {
  for (const mutate of [
    (x) => (x.original.conclusion = "success"),
    (x) => (x.original.conclusion = "cancelled"),
    (x) => (x.original.run_attempt = 2),
    (x) => (x.original.head_repository.full_name = "attacker/fork"),
    (x) => (x.original.triggering_actor.id = 1),
    (x) => (x.original.workflow_id = 2),
    (x) => (x.jobs[SOURCE.runId][0].conclusion = "failure"),
    (x) => (x.jobs[SOURCE.runId][0].steps[0].conclusion = "skipped"),
    (x) => x.jobs[SOURCE.runId].push(structuredClone(x.jobs[SOURCE.runId][0])),
    (x) => (x.cis[SOURCE.ciRunId].event = "workflow_dispatch"),
    (x) => (x.cis[SOURCE.ciRunId].conclusion = "failure"),
    (x) => (x.cis[SOURCE.ciRunId].head_sha = "a".repeat(40)),
  ]) {
    const x = fixture();
    mutate(x);
    await assert.rejects(
      origin.verifyOriginal(x.api, x.dependencies),
      /source|original|producer|job|CI/i
    );
  }
});
test("original artifact metadata pins id, digest, byte size, run and app revision", async () => {
  for (const patch of [
    { id: 1 },
    { expired: true },
    { name: "other" },
    { digest: "sha256:" + "a".repeat(64) },
    { size_in_bytes: SOURCE.artifactSize + 1 },
    { workflow_run: { id: 1, head_sha: SOURCE.head } },
  ]) {
    const x = fixture();
    Object.assign(x.originalArtifact, patch);
    await assert.rejects(origin.verifyOriginal(x.api, x.dependencies), /artifact/i);
  }
});
test("recovery producer verifies owner, manual trusted main, attempt and helper push CI", async () => {
  const x = fixture();
  assert.deepEqual(await origin.verifyProducer(x.api, x.ctx), x.runs["500"]);
  x.runs["500"].status = "in_progress";
  x.runs["500"].conclusion = null;
  assert.equal(
    (await origin.verifyProducer(x.api, x.ctx, { complete: false })).status,
    "in_progress"
  );
  for (const patch of [
    { actor: "other" },
    { event: "schedule" },
    { runAttempt: 2 },
    { workflowRef: c.WORKFLOW_REF },
  ])
    await assert.rejects(
      origin.verifyProducer(x.api, { ...x.ctx, ...patch }, { complete: false }),
      /recovery|producer/i
    );
  x.cis["501"].event = "workflow_dispatch";
  await assert.rejects(origin.verifyProducer(x.api, x.ctx, { complete: false }), /CI/i);
});
test("an assessed durable receipt verifies replay, same-run finalization and exact recovered artifact", async () => {
  const x = fixture();
  const actual = await origin.verifyReceipt(x.api, x.candidate, x.dependencies);
  assert.deepEqual(actual.artifact, x.recoveryArtifact);
  assert.deepEqual(actual.receipt, x.receipt);
  assert.deepEqual(actual.proof, x.proof);
});
test("failed finalization can be reconciled by a later successful select without repeating replay", async () => {
  const x = fixture();
  x.runs["500"].conclusion = "failure";
  x.jobs["500"][1].conclusion = "failure";
  x.receipt.confirmation = context("502", "c".repeat(40));
  assert.ok(await origin.verifyReceipt(x.api, x.candidate, x.dependencies));
  x.jobs["502"][0].conclusion = "failure";
  await assert.rejects(
    origin.verifyReceipt(x.api, x.candidate, x.dependencies),
    /confirmation|finaliz|reconcil/i
  );
});
test("a receipt cannot fabricate replay, confirmation, source identity or an artifact", async () => {
  for (const mutate of [
    (x) => (x.receipt.outcome = "held"),
    (x) => (x.receipt.confirmation = null),
    (x) => (x.store.imports[SOURCE.grantId].recoveries = []),
    (x) => (x.jobs["500"][0].conclusion = "failure"),
    (x) => (x.jobs["500"][0].steps[0].conclusion = "skipped"),
    (x) => (x.jobs["500"][1].conclusion = "failure"),
    (x) => (x.runs["500"].conclusion = "cancelled"),
    (x) => (x.runs["500"].conclusion = "failure"),
    (x) => (x.candidate.source.head = "a".repeat(40)),
    (x) => (x.candidate.source.recovery.context.workflowSha = "a".repeat(40)),
    (x) => (x.candidate.artifact.digest = "sha256:" + "a".repeat(64)),
    (x) => (x.recoveryArtifact.expired = true),
    (x) => (x.recoveryArtifact.size_in_bytes = 4 * 1024 * 1024 + 1),
    (x) => (x.recoveryArtifact.workflow_run.head_sha = SOURCE.head),
  ]) {
    const x = fixture();
    mutate(x);
    await assert.rejects(origin.verifyReceipt(x.api, x.candidate, x.dependencies));
  }
});
