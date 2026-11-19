const test = require("node:test"),
  assert = require("node:assert/strict");
const f = require("../factory/discovery-finding-contract.cjs"),
  c = require("../factory/discovery-contract.cjs");
const pub = require("../factory/discovery-publication.cjs"),
  fx = require("./helpers/finding-fixtures.cjs");
function runner() {
  if (!process.env.FACTORY_FINDING_TEST_OLD_RUNNER)
    return require("../factory/discovery-finding-run.cjs");
  const filename = require.resolve("../factory/discovery-finding-run.cjs"),
    Module = require("node:module");
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(require("node:path").dirname(filename));
  mod._compile(
    require("node:child_process").execFileSync(
      "git",
      ["show", "481f77d:scripts/factory/discovery-finding-run.cjs"],
      { encoding: "utf8" }
    ),
    filename
  );
  return mod.exports;
}
const config = { enabled: true, automatic: true, discovery: true };
function env() {
  return {
    GITHUB_REPOSITORY: c.REPOSITORY,
    GITHUB_ACTOR: "haideearus",
    GITHUB_TRIGGERING_ACTOR: "haideearus",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: f.WORKFLOW_REF,
    GITHUB_WORKFLOW_SHA: fx.head,
    GITHUB_RUN_ID: "300",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    FACTORY_INPUTS: JSON.stringify({ operation: "run", dry_run: false }),
    FACTORY_VARIABLES: JSON.stringify({
      ...require("./helpers/factory-fixtures.cjs").vars,
      FACTORY_DISCOVERY_ENABLED: "true",
      FACTORY_AUTOMATION_ENABLED: "true",
      FACTORY_GITHUB_APP_CLIENT_ID: "Iv1.fixture123456",
      FACTORY_GITHUB_APP_SLUG: "fixture-factory",
    }),
  };
}
function run(id, status = "in_progress") {
  return {
    id,
    run_attempt: 1,
    workflow_id: 10,
    path: f.WORKFLOW,
    head_branch: "main",
    head_sha: fx.head,
    repository: { full_name: c.REPOSITORY },
    head_repository: { full_name: c.REPOSITORY },
    actor: { login: "haideearus", id: 101267861 },
    triggering_actor: { login: "haideearus", id: 101267861 },
    event: "workflow_dispatch",
    status,
    conclusion: status === "completed" ? "success" : null,
  };
}
function producerRequest(method, url) {
  if (method === "GET" && url.endsWith("/actions/runs/300/attempts/1")) return run(300);
  if (method === "GET" && url.endsWith("/actions/runs/200/attempts/1"))
    return run(200, "completed");
  if (method === "GET" && url.endsWith("/actions/workflows/factory-discovery-intake.yml"))
    return { id: 10, path: f.WORKFLOW };
  throw Error("Unexpected producer request " + method + " " + url);
}
function candidate(route = "/users", grant = fx.grant, runId = "100") {
  const proof = fx.proof();
  proof.runId = runId;
  return f.candidateFromEvidence(
    fx.evidence("protected-route", route, grant),
    0,
    { ...fx.artifact, name: `discovery-evidence-${grant}`, workflowRunId: runId },
    proof
  );
}
test("an expired first source is retained as held and cannot wedge a later valid finding", async () => {
  function functionalCandidate(charter, grant, runId) {
    const proof = fx.proof(grant, charter);
    proof.runId = runId;
    return f.candidateFromEvidence(
      fx.functionalEvidence(charter, grant),
      0,
      { ...fx.artifact, name: `discovery-evidence-${grant}`, workflowRunId: runId },
      proof
    );
  }
  const state = f.emptyFindings(),
    one = functionalCandidate("functional-feed", fx.grant, "100"),
    two = functionalCandidate(
      "functional-directory",
      "88888888-8888-4888-8888-888888888888",
      "101"
    );
  pub.stageFinding(state, one);
  pub.stageFinding(state, two);
  const store = fx.memoryStore(state);
  const controls = {
    stop: null,
    tickets: {
      90: { discovery: { charter: one.source.charter } },
      91: { discovery: { charter: two.source.charter } },
    },
    grants: Object.fromEntries(
      [one, two].map((x, i) => [
        x.source.grantId,
        {
          id: x.source.grantId,
          phase: "discover",
          status: "finished",
          outcome: "discovery_complete",
          runId: x.source.runId,
          ticket: 90 + i,
        },
      ])
    ),
  };
  const api = {
    request: producerRequest,
    async pages(url) {
      return url.includes("/runs/100/")
        ? [{ name: one.artifact.name, expired: true }]
        : [{ id: 124, name: two.artifact.name, expired: false }];
    },
  };
  const result = await runner().main(env(), { api, ledger: fx.memoryStore(controls), store });
  assert.equal(result.sourceGrant, two.source.grantId);
  assert.equal(store.state.records[one.key].status, "held-evidence");
  assert.equal(store.state.imports[one.source.grantId].status, "held-evidence");
  assert.equal(store.state.sources[one.source.grantId].length, 1);
});
test("lost resolution comment response is reconciled once and closes the preserved issue on a later run", async () => {
  const state = f.emptyFindings(),
    one = candidate();
  pub.stageFinding(state, one);
  const row = pub.claimPublication(state, one.key, "2026-11-17", fx.context, config, false);
  row.publication.issue = 77;
  row.publication.writeStarted = true;
  row.publication.confirmation = fx.context;
  row.status = "published";
  const receipt = require("../factory/discovery-intake.cjs").reserveReplay(
    state,
    one.key,
    "2026-11-17",
    fx.context,
    fx.head,
    "99"
  );
  receipt.outcome = "observed-resolved";
  receipt.evidenceHash = "e".repeat(64);
  row.intake = structuredClone(receipt);
  row.status = "observed-resolved";
  const store = fx.memoryStore(state),
    ledger = fx.memoryStore({ stop: null, grants: {}, tickets: {} });
  const issue = {
    number: 77,
    state: "open",
    title: row.publication.title,
    body: row.publication.body,
    user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
  };
  const comments = [];
  let posts = 0;
  const api = {
    async request(method, url, body) {
      if (method === "GET" && url.includes("/comments?")) return comments;
      if (method === "POST" && url.endsWith("/comments")) {
        posts++;
        comments.push({ id: 1, body: body.body, user: issue.user });
        throw Error("lost comment response");
      }
      if (method === "GET" && url.endsWith("/issues/77")) return structuredClone(issue);
      if (method === "PATCH" && url.endsWith("/issues/77")) {
        issue.state = body.state;
        return issue;
      }
      return producerRequest(method, url);
    },
    async pages() {
      return [
        {
          name: "replay",
          status: "completed",
          conclusion: "success",
          steps: [{ name: "Replay current main without credentials", conclusion: "success" }],
        },
      ];
    },
  };
  await assert.rejects(
    () => pub.noteResolution({ api, store, ledger, key: one.key, context: fx.context, config }),
    /lost/
  );
  assert.equal(store.state.records[one.key].comment.writeStarted, true);
  await runner().main(env(), { api, ledger, store });
  assert.equal(issue.state, "open");
  await runner().main(
    {
      ...env(),
      FACTORY_INPUTS: JSON.stringify({
        operation: "reconcile",
        dry_run: false,
        finding_key: one.key,
      }),
    },
    { api, ledger, store }
  );
  assert.equal(posts, 1);
  assert.equal(issue.state, "closed");
  assert.equal(store.state.records[one.key].resolutionClosed, true);
});
test("verified protected merge preserves old receipts and permits only descendant recurrence evidence", async () => {
  const state = f.emptyFindings(),
    one = candidate();
  pub.stageFinding(state, one);
  const row = pub.claimPublication(state, one.key, "2026-11-17", fx.context, config, false);
  row.publication.issue = 77;
  row.status = "published";
  const store = fx.memoryStore(state),
    head = "b".repeat(40),
    merge = "c".repeat(40);
  const ledger = fx.memoryStore({
    stop: null,
    tickets: {
      77: {
        pr: 78,
        head,
        criteriaHash: row.publication.criteriaHash,
        finding: { origin: f.originProof(row) },
        ci: { passed: true },
        approval: { head },
        merge: { status: "merged", mergeCommit: merge },
      },
    },
  });
  let status = "ahead";
  const api = {
    async request(method, url) {
      assert.equal(method, "GET");
      if (url.endsWith("/pulls/78"))
        return {
          number: 78,
          merged: true,
          state: "closed",
          head: { sha: head, repo: { full_name: c.REPOSITORY } },
          base: { ref: "main", repo: { full_name: c.REPOSITORY } },
          merge_commit_sha: merge,
        };
      return { status, merge_base_commit: { sha: merge } };
    },
  };
  await pub.recordMergedRepairs({ api, store, ledger, context: fx.context });
  const recorded = store.state.records[one.key];
  assert.equal(recorded.status, "repair-merged");
  assert.equal(recorded.publication.issue, 77);
  assert.equal(await pub.recurrenceAllowed(api, recorded, one), true);
  status = "behind";
  assert.equal(await pub.recurrenceAllowed(api, recorded, one), false);
});
