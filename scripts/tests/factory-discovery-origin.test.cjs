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
