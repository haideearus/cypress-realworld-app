const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { GitHub, Ledger } = require("../factory/github.cjs");
const { main: run } = require("../factory/discovery-run.cjs");
const { main: worker } = require("../factory/discovery-worker.cjs");
const discovery = require("../factory/discovery-contract.cjs");
const policy = require("../factory/policy.cjs");
const { GitHubFixture, context, head, vars } = require("./helpers/factory-fixtures.cjs");

const admission = new Date("2026-11-17T01:20:00Z");
const variables = { ...vars, FACTORY_DISCOVERY_ENABLED: "true" };
const ledgerRef = "/git/ref/heads/factory/state";
const updateRef = "/git/refs/heads/factory/state";

function rateLimit() {
  return Response.json(
    { message: "API rate limit exceeded for installation." },
    {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(admission.getTime() / 1000 + 60),
      },
    }
  );
}

function mockGitHub(t, transport) {
  let now = admission.getTime();
  const waits = [];
  t.mock.method(globalThis, "fetch", (url, options) =>
    transport(url.pathname.replace(`/repos/${policy.REPOSITORY}`, ""), url, options)
  );
  return {
    waits,
    options: {
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    },
  };
}

test("discovery replay reads the current ledger ref after a quota wait on saved contents", async (t) => {
  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "factory-discovery-quota-"));
  t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bundle, "bundle.json"), "{}");
  const reads = [];
  const updatedHead = "b".repeat(40);
  let refReads = 0;
  let contentReads = 0;
  const mock = mockGitHub(t, (route, url, options) => {
    assert.equal(options.method, "GET");
    reads.push(route + url.search);
    if (route === ledgerRef)
      return Response.json({ object: { sha: ++refReads === 1 ? head : updatedHead } });
    if (contentReads++ === 0) return rateLimit();
    if (url.searchParams.get("ref") === head)
      return Response.json({
        type: "file",
        encoding: "base64",
        content: Buffer.from(JSON.stringify(policy.emptyState(policy.REPOSITORY))).toString(
          "base64"
        ),
      });
    // End before validating provenance or starting a replay container.
    return new Response(null, { status: 404 });
  });
  await assert.rejects(
    worker(
      {
        GH_TOKEN: "fixture-only",
        FACTORY_OPERATION: "replay",
        FACTORY_VARIABLES: JSON.stringify(variables),
        FACTORY_DISCOVERY_BUNDLE: bundle,
      },
      { githubOptions: mock.options }
    ),
    { status: 404 }
  );
  assert.deepEqual(reads, [
    ledgerRef,
    `/contents/state.json?ref=${head}`,
    `/contents/state.json?ref=${head}`,
    ledgerRef,
    `/contents/state.json?ref=${updatedHead}`,
  ]);
  assert.deepEqual(mock.waits, [61_500]);
});

test("discovery finalization retries a quota-rejected ledger write for the same grant", async (t) => {
  const fixture = new GitHubFixture();
  const ledger = new Ledger(new GitHub({ token: "fixture-only", fetch: fixture.fetch }));
  await ledger.initialize();
  const day = policy.dayKey(admission, "Europe/Bucharest");
  const sweep = {
    version: 1,
    head,
    charter: "functional-feed",
    day,
    key: discovery.sweepKey(head, "functional-feed", day),
    ciRunId: "99",
    runId: context.runId,
    runAttempt: 1,
    workflowSha: head,
    workflowRef: discovery.WORKFLOW_REF,
  };
  const { grant } = await ledger.update((state) =>
    policy.reserve(
      state,
      {
        ...context,
        workflowRef: discovery.WORKFLOW_REF,
        workflowSha: head,
        origin: "discovery-sweep",
        phase: "discover",
        slot: "discovery",
        discovery: sweep,
      },
      policy.readConfig(variables),
      admission
    )
  );
  const before = (await ledger.read()).state;
  const writes = [];
  const mock = mockGitHub(t, (route, url, options) => {
    if (route === "/actions/runs/100")
      return Response.json({
        id: 100,
        run_attempt: 1,
        path: ".github/workflows/factory-discovery.yml",
        head_sha: head,
        head_branch: "main",
        repository: { full_name: policy.REPOSITORY },
        actor: { login: policy.OWNER, id: 101267861 },
        triggering_actor: { login: policy.OWNER },
        event: "workflow_dispatch",
        status: "in_progress",
      });
    if (route === updateRef) {
      assert.equal(options.method, "PATCH");
      writes.push(JSON.parse(options.body));
      if (writes.length === 1) return rateLimit();
    }
    return fixture.fetch(url, options);
  });
  await run(
    {
      GH_TOKEN: "fixture-only",
      GITHUB_REPOSITORY: policy.REPOSITORY,
      GITHUB_ACTOR: policy.OWNER,
      GITHUB_TRIGGERING_ACTOR: policy.OWNER,
      GITHUB_REF: "refs/heads/main",
      GITHUB_WORKFLOW_REF: discovery.WORKFLOW_REF,
      GITHUB_WORKFLOW_SHA: head,
      GITHUB_RUN_ID: context.runId,
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_EVENT_NAME: context.event,
      FACTORY_OPERATION: "finish",
      FACTORY_INPUTS: JSON.stringify({ grantId: grant.id }),
      FACTORY_VARIABLES: JSON.stringify(variables),
      FACTORY_DISCOVERY_ASSESSMENT_COMPLETE: "true",
    },
    { githubOptions: mock.options }
  );
  const after = (await ledger.read()).state;
  assert.deepEqual(mock.waits, [61_500]);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(writes[1].force, false);
  assert.equal(after.active, null);
  assert.deepEqual(after.days, before.days);
  assert.deepEqual(after.grants, {
    ...before.grants,
    [grant.id]: { ...before.grants[grant.id], status: "finished", outcome: "discovery_complete" },
  });
});
