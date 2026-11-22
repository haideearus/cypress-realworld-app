const test = require("node:test"),
  assert = require("node:assert/strict");
const c = require("../factory/discovery-contract.cjs"),
  f = require("../factory/discovery-finding-contract.cjs");
const origin = require("../factory/discovery-origin.cjs");
const fx = require("./helpers/finding-fixtures.cjs");
function sourceFixture(functional = false) {
  const proof = functional ? fx.proof(fx.grant, "functional-feed") : fx.proof();
  const bundle = functional ? fx.functionalEvidence() : fx.evidence();
  const candidate = f.candidateFromEvidence(bundle, 0, fx.artifact, proof);
  const grant = {
    id: fx.grant,
    phase: "discover",
    slot: "discovery",
    status: "finished",
    outcome: "discovery_complete",
    head: fx.head,
    runId: "100",
    runAttempt: 1,
    ticket: 90,
  };
  const state = {
    grants: { [grant.id]: grant },
    tickets: {
      90: { origin: "discovery-sweep", status: "discovery_complete", discovery: proof },
    },
  };
  const registry = {
    sources: { [proof.key]: { status: "created", issue: 90, proof } },
  };
  const jobs = [
    {
      name: "discover",
      steps: [{ name: "Run the one reserved Claude discovery session", conclusion: "success" }],
    },
    {
      name: "replay",
      steps: [
        {
          name: "Rebuild baseline and replay twice without a model credential",
          conclusion: "success",
        },
      ],
    },
    { name: "finalize", steps: [] },
  ].map((j) => ({ ...j, status: "completed", conclusion: "success" }));
  const run = {
    id: 100,
    workflow_id: 10,
    path: ".github/workflows/factory-discovery.yml",
    run_attempt: 1,
    head_sha: fx.head,
    head_branch: "main",
    repository: { full_name: c.REPOSITORY },
    head_repository: { full_name: c.REPOSITORY },
    actor: { login: "haideearus", id: 101267861 },
    triggering_actor: { login: "haideearus", id: 101267861 },
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
  };
  const artifact = {
    ...fx.artifact,
    expired: false,
    size_in_bytes: 3000,
    workflow_run: { id: 100, head_sha: fx.head },
  };
  const api = {
    async pages() {
      return structuredClone(jobs);
    },
    async request(method, url) {
      assert.equal(method, "GET");
      if (url.endsWith("/issues/90"))
        return {
          user: { id: 41898282, login: "github-actions[bot]" },
          labels: [],
          body: require("../factory/discovery-run.cjs").sourceBody(proof),
        };
      if (url.endsWith("/actions/runs/100/attempts/1")) return structuredClone(run);
      if (url.endsWith("/actions/workflows/factory-discovery.yml"))
        return { id: 10, path: run.path };
      if (url.endsWith("/actions/runs/99"))
        return {
          path: ".github/workflows/factory-ci.yml",
          event: "push",
          head_sha: fx.head,
          head_branch: "main",
          status: "completed",
          conclusion: "success",
          repository: { full_name: c.REPOSITORY },
        };
      if (url.endsWith("/actions/artifacts/123")) return structuredClone(artifact);
      throw Error("Unexpected GET " + url);
    },
  };
  return {
    api,
    candidate,
    state,
    jobs,
    artifact,
    run,
    dependencies: { ledger: fx.memoryStore(state), discovery: fx.memoryStore(registry) },
  };
}
test("finished real discovery grant, exact audit source, successful model/replay and immutable artifact are all required", async () => {
  const x = sourceFixture();
  assert.equal(await origin.verifySource(x.api, x.candidate, x.dependencies), true);
  x.jobs[0].steps[0].conclusion = "skipped";
  assert.equal(await origin.verifySource(x.api, x.candidate, x.dependencies), false);
  x.jobs[0].steps[0].conclusion = "success";
  x.artifact.expired = true;
  assert.equal(await origin.verifySource(x.api, x.candidate, x.dependencies), false);
  x.artifact.expired = false;
  x.run.head_repository.full_name = "attacker/fork";
  assert.equal(await origin.verifySource(x.api, x.candidate, x.dependencies), false);
});
test("a cancelled or merely reserved discovery cannot be laundered as a verified finding", async () => {
  const x = sourceFixture();
  x.state.grants[fx.grant].outcome = "blocked";
  x.dependencies.ledger = fx.memoryStore(x.state);
  assert.equal(await origin.verifySource(x.api, x.candidate, x.dependencies), false);
});
test("bot identity and factory-ready label alone are not a trusted issue origin", async () => {
  const issue = {
    number: 77,
    user: { login: "github-actions[bot]", id: 41898282, type: "Bot" },
    labels: [{ name: "factory-ready" }],
  };
  assert.equal(
    await origin.verifyDiscoveryIssue({}, issue, { store: fx.memoryStore(f.emptyFindings()) }),
    null
  );
});
test("published receipt and current-head replay still require successful trusted jobs and unchanged issue criteria", async () => {
  const x = sourceFixture(true),
    s = f.emptyFindings(),
    pub = require("../factory/discovery-publication.cjs");
  pub.stageFinding(s, x.candidate);
  pub.claimPublication(
    s,
    x.candidate.key,
    "2026-11-17",
    fx.context,
    { enabled: true, automatic: true, discovery: true },
    false
  );
  const row = s.records[x.candidate.key];
  row.publication.issue = 77;
  row.publication.confirmation = fx.context;
  row.publication.writeStarted = true;
  row.status = "published";
  const receipt = require("../factory/discovery-intake.cjs").reserveReplay(
    s,
    x.candidate.key,
    "2026-11-17",
    fx.context,
    fx.head,
    "99"
  );
  receipt.outcome = "ready";
  receipt.evidenceHash = "e".repeat(64);
  row.intake = structuredClone(receipt);
  f.validateFindings(s);
  const issue = {
    number: 77,
    title: row.publication.title,
    body: row.publication.body,
    state: "open",
    user: { login: "github-actions[bot]", id: 41898282, type: "Bot" },
  };
  const api = {
    async pages() {
      return [
        {
          name: "publish",
          status: "completed",
          conclusion: "success",
          steps: [{ name: "Publish verified findings without a model", conclusion: "success" }],
        },
        {
          name: "replay",
          status: "completed",
          conclusion: "success",
          steps: [{ name: "Replay current main without credentials", conclusion: "success" }],
        },
        {
          name: "finalize",
          status: "completed",
          conclusion: "success",
          steps: [{ name: "Retain current-head intake or a visible hold", conclusion: "success" }],
        },
      ];
    },
    async request(method, url) {
      if (url.endsWith("/branches/main")) return { commit: { sha: x.currentHead || fx.head } };
      if (url.endsWith("/actions/workflows/factory-discovery-intake.yml"))
        return { id: 12, path: f.WORKFLOW };
      if (url.endsWith("/actions/runs/200/attempts/1"))
        return { ...x.run, id: 200, workflow_id: 12, path: f.WORKFLOW };
      return x.api.request(method, url);
    },
  };
  const options = { store: fx.memoryStore(s), verify: async () => true };
  assert.deepEqual(await origin.verifyDiscoveryIssue(api, issue, options), f.originProof(row));
  x.currentHead = "b".repeat(40);
  assert.equal(await origin.verifyDiscoveryIssue(api, issue, options), null);
  assert.ok(await origin.verifyDiscoveryIssue(api, issue, { ...options, requireCurrent: false }));
  issue.body += "edited";
  assert.equal(await origin.verifyDiscoveryIssue(api, issue, options), null);
});

test("a bot discovery artifact requires its exact successful main CI from the pinned App", async () => {
  const x = sourceFixture(true);
  const actor = { login: "haideearus-software-factory[bot]", id: 356310548, type: "Bot" };
  Object.assign(x.run, { event: "workflow_run", actor, triggering_actor: actor });
  const g = x.api.request;
  const ci = {
    id: 99,
    path: ".github/workflows/factory-ci.yml",
    event: "push",
    run_attempt: 1,
    head_sha: fx.head,
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    repository: { full_name: c.REPOSITORY },
    head_repository: { full_name: c.REPOSITORY },
    actor,
    triggering_actor: actor,
  };
  x.api.request = (method, url) => (url.endsWith("/actions/runs/99") ? ci : g(method, url));
  assert.equal(await origin.verifySource(x.api, x.candidate, x.dependencies), true);
  ci.triggering_actor = { ...actor, id: 123 };
  assert.equal(await origin.verifySource(x.api, x.candidate, x.dependencies), false);
});

function sweepClosureFixture({ finding = false, closed = false, eligible = true } = {}) {
  const source = sourceFixture(true);
  const { ROOT } = require("../factory/github.cjs");
  const { main } = require("../factory/discovery-finding-run.cjs");
  const issuePath = ROOT + "/issues/90";
  const proof = fx.proof(fx.grant, "functional-feed");
  const original = {
    number: 90,
    state: closed ? "closed" : "open",
    state_reason: closed ? "completed" : null,
    title: "Discovery sweep: functional-feed (2026-11-17)",
    body: require("../factory/discovery-run.cjs").sourceBody(proof),
    labels: [],
    user: { id: 41898282, login: "github-actions[bot]" },
  };
  const issue = structuredClone(original);
  const registry = f.emptyFindings();
  if (finding) {
    const publication = require("../factory/discovery-publication.cjs");
    publication.stageFinding(registry, source.candidate);
    const record = registry.records[source.candidate.key];
    if (finding === "ready") {
      publication.claimPublication(
        registry,
        source.candidate.key,
        proof.day,
        fx.context,
        { enabled: true, automatic: true, discovery: true },
        false
      );
      Object.assign(record.publication, {
        issue: 91,
        confirmation: fx.context,
        writeStarted: true,
      });
      record.status = "published";
      const receipt = require("../factory/discovery-intake.cjs").reserveReplay(
        registry,
        source.candidate.key,
        proof.day,
        fx.context,
        fx.head,
        proof.ciRunId
      );
      Object.assign(receipt, { outcome: "ready", evidenceHash: "a".repeat(64) });
      record.intake = structuredClone(receipt);
    } else record.status = "held-quota";
  }
  registry.imports[fx.grant] = {
    runId: "100",
    status: "complete",
    evidenceHash: "e".repeat(64),
    findings: finding ? [source.candidate.key] : [],
    ...(eligible
      ? {
          sweepClosure: { artifactId: 123, artifactDigest: fx.artifact.digest, status: "pending" },
        }
      : {}),
  };
  const updates = [];
  const api = {
    pages: source.api.pages,
    async request(method, url, body) {
      if (method === "PATCH") {
        assert.equal(url, issuePath);
        assert.deepEqual(body, { state: "closed", state_reason: "completed" });
        updates.push(body);
        Object.assign(issue, body);
        if (api.uncertain) throw Error("Lost PATCH response");
        return structuredClone(issue);
      }
      if (url === issuePath) return structuredClone(issue);
      if (url.endsWith("/actions/workflows/factory-discovery-intake.yml"))
        return { id: 11, path: f.WORKFLOW };
      if (url.endsWith("/actions/runs/300/attempts/1"))
        return {
          ...source.run,
          id: 300,
          workflow_id: 11,
          path: f.WORKFLOW,
          status: "in_progress",
          conclusion: null,
        };
      return source.api.request(method, url);
    },
  };
  const env = {
    GITHUB_REPOSITORY: c.REPOSITORY,
    GITHUB_ACTOR: "haideearus",
    GITHUB_TRIGGERING_ACTOR: "haideearus",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: f.WORKFLOW_REF,
    GITHUB_WORKFLOW_SHA: fx.head,
    GITHUB_RUN_ID: "300",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    FACTORY_OPERATION: "close-sweeps",
    FACTORY_INPUTS: JSON.stringify({ operation: "run", dry_run: false }),
    FACTORY_VARIABLES: JSON.stringify({
      ...require("./helpers/factory-fixtures.cjs").vars,
      FACTORY_DISCOVERY_ENABLED: "true",
      FACTORY_AUTOMATION_ENABLED: "true",
      FACTORY_GITHUB_APP_CLIENT_ID: "Iv1.fixture123456",
      FACTORY_GITHUB_APP_SLUG: "fixture-factory",
    }),
  };
  const store = fx.memoryStore(registry);
  const dependencies = { ...source.dependencies, api, store };
  return {
    ...source,
    issue,
    original,
    updates,
    api,
    env,
    store,
    execute: () => main(env, dependencies),
  };
}

test("live finding intake closes a completed empty sweep once and preserves its evidence", async () => {
  const x = sweepClosureFixture();
  const result = await x.execute();
  assert.deepEqual(result.sweepsClosed, [90]);
  assert.deepEqual(x.issue, { ...x.original, state: "closed", state_reason: "completed" });
  assert.equal(x.store.state.imports[fx.grant].evidenceHash, "e".repeat(64));
  assert.equal(x.store.state.imports[fx.grant].sweepClosure.artifactDigest, fx.artifact.digest);
  assert.deepEqual((await x.execute()).sweepsClosed, []);
  assert.equal(x.updates.length, 1);
});

test("a settled replay closes its source sweep while leaving the separate repair ticket and evidence intact", async () => {
  const x = sweepClosureFixture({ finding: "ready" });
  const records = x.store.state.records;
  assert.deepEqual((await x.execute()).sweepsClosed, [90]);
  assert.deepEqual(x.store.state.records, records);
  assert.equal(x.updates.length, 1);
});

test("a pending handoff, held or legacy import, preview, altered issue or expired evidence leaves the sweep open", async () => {
  for (const prepare of [
    () => sweepClosureFixture({ finding: true }),
    () => sweepClosureFixture({ eligible: false }),
    () => {
      const x = sweepClosureFixture();
      x.env.FACTORY_INPUTS = JSON.stringify({ operation: "run", dry_run: true });
      return x;
    },
    () => {
      const x = sweepClosureFixture();
      x.issue.labels = [{ name: "factory-ready" }];
      return x;
    },
    () => {
      const x = sweepClosureFixture();
      x.artifact.expired = true;
      return x;
    },
  ]) {
    const x = prepare();
    assert.deepEqual((await x.execute()).sweepsClosed, []);
    assert.equal(x.issue.state, "open");
    assert.equal(x.updates.length, 0);
  }
});

test("malformed sweep sources cannot permanently exhaust the bounded closure pass", async () => {
  const x = sweepClosureFixture();
  const heldGrants = [];
  await x.store.update((state) => {
    for (const id of [201, 202, 203, 204]) {
      const grant = `10000000-0000-4000-8000-000000000${id}`;
      heldGrants.push(grant);
      state.imports[grant] = structuredClone(state.imports[fx.grant]);
    }
    return { state };
  });
  assert.deepEqual((await x.execute()).sweepsClosed, []);
  assert.ok(
    heldGrants.every((grant) => x.store.state.imports[grant].sweepClosure.status === "held")
  );
  assert.deepEqual((await x.execute()).sweepsClosed, [90]);
});

test("a lost successful closure response reconciles without repeating the write", async () => {
  const x = sweepClosureFixture();
  x.api.uncertain = true;
  assert.deepEqual((await x.execute()).sweepsClosed, [90]);
  assert.deepEqual((await x.execute()).sweepsClosed, []);
  assert.equal(x.updates.length, 1);
});

test("a browser observation can prevent sweep closure even when API intake has no findings", () => {
  const { browserEvidenceSettled } = require("../factory/discovery-sweep-closure.cjs");
  assert.equal(browserEvidenceSettled({ findings: [] }), true);
  assert.equal(
    browserEvidenceSettled({
      findings: [],
      actualBatches: [{ mode: "cypress", code: 0, networkIsolated: true }],
    }),
    true
  );
  for (const evidence of [
    { browserFollowUp: true },
    { actualBatches: [{ mode: "cypress", code: 1, networkIsolated: true }] },
    { actualBatches: [{ mode: "cypress", code: 0, networkIsolated: false }] },
    { actualBatches: [{ mode: "cypress", code: 0 }] },
  ])
    assert.equal(browserEvidenceSettled({ findings: [], ...evidence }), false);
});
