const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const c = require("../factory/discovery-contract.cjs");
const { renderJourney } = require("../factory/discovery-browser.cjs");
const { assessCandidates } = require("../factory/discovery-replay.cjs");
const { sourceBody } = require("../factory/discovery-run.cjs");
const { emptyMonitorState } = require("../factory/monitor-state.cjs");
const { verifyMonitorIssue } = require("../factory/monitor-origin.cjs");
const { publishFunctional } = require("../factory/functional-discovery.cjs");

const head = "a".repeat(40);
const grantId = "7f16a140-6b1a-4b49-8428-61ad5bafc171";
const image = "sha256:" + "a".repeat(64);
const journey = { pages: ["settings"], check: "settings-validation", variant: "invalid-email" };
const log =
  "\n  0 passing (8s)\n  1 failing\n\n  1) factory browser journey\n" +
  "       settings-validation / invalid-email:\n" +
  "     AssertionError: Timed out retrying after 4000ms: Browser journey [invalid-email]: expected false to equal true\n";
const fixed = { check: "form-validation", assertion: "settings-email-invalid" };
const bridge = () => require("../factory/discovery-browser-handoff.cjs");

function batch({ result = {}, ...fields } = {}) {
  const test = renderJourney(journey);
  const file = "settings.cy.ts";
  return {
    number: 1,
    mode: "cypress",
    file,
    test,
    testHash: c.digest(test),
    result: {
      mode: "cypress",
      file,
      image,
      code: 1,
      exitState: { status: "exited", exitCode: 1, oomKilled: false },
      log,
      logHash: c.digest(log),
      networkIsolated: true,
      ...result,
    },
    ...fields,
  };
}

test("only the latest isolated Cypress failure at the typed mapped assertion becomes a lead", () => {
  const { browserLeads } = bridge();
  assert.deepEqual(browserLeads({ batches: [batch()] }), [
    {
      batch: 1,
      journey,
      templateHash: c.digest(renderJourney(journey)),
      logHash: c.digest(log),
      marker: "invalid-email",
    },
  ]);
  const startup = log.replace(
    "AssertionError: Timed out retrying after 4000ms: ",
    "CypressError: "
  );
  for (const invalid of [
    { batches: [batch({ result: { code: 124 } })] },
    { batches: [batch({ result: { logHash: "b".repeat(64) } })] },
    { batches: [batch({ result: { log: startup, logHash: c.digest(startup) } })] },
    { batches: [batch({ test: renderJourney(journey) + "\n" })] },
    { batches: [batch(), batch({ number: 2, result: { code: 0 } })] },
    { batches: [batch()], browserFollowUp: true },
  ]) {
    assert.deepEqual(browserLeads(invalid), []);
  }
});

test("trusted replay retains approved browser evidence without a model-written finding report", async (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "browser-lead-replay-"));
  t.after(() => fs.rmdirSync(output));
  const bundle = {
    head,
    grantId,
    sourceHash: c.digest("checked-in tree"),
    report: { version: 1, head, grantId, checked: [], skipped: [], findings: [] },
    batches: [batch()],
  };
  const result = await assessCandidates({ bundle, image, output });
  assert.deepEqual(result.findings, []);
  assert.equal(result.browserLeads.length, 1);
  assert.equal(result.browserLeads[0].marker, "invalid-email");
  assert.equal(result.browserLeads[0].templateHash, result.actualBatches[0].testHash);
});

function fixture() {
  const repository = { full_name: c.REPOSITORY };
  const actor = { login: "haideearus", id: 101267861, type: "User" };
  const workflow = { id: 20, path: ".github/workflows/factory-discovery.yml" };
  const run = {
    id: 31,
    workflow_id: workflow.id,
    path: workflow.path,
    repository,
    head_repository: repository,
    head_branch: "main",
    head_sha: head,
    run_attempt: 1,
    event: "schedule",
    status: "completed",
    conclusion: "success",
    actor,
    triggering_actor: actor,
  };
  const event = { action: "completed", repository, workflow, workflow_run: run };
  const context = {
    repository: c.REPOSITORY,
    ref: "refs/heads/main",
    workflowRef:
      c.REPOSITORY + "/.github/workflows/factory-functional-discovery.yml@refs/heads/main",
    workflowSha: head,
    sha: head,
    eventName: "workflow_run",
    runId: "41",
    runAttempt: 1,
    actor: actor.login,
    triggeringActor: actor.login,
  };
  const proof = {
    version: 1,
    head,
    charter: "functional-settings",
    day: "2026-11-23",
    ciRunId: "17",
    key: c.sweepKey(head, "functional-settings", "2026-11-23"),
    runId: String(run.id),
    runAttempt: 1,
    workflowSha: head,
    workflowRef: c.WORKFLOW_REF,
  };
  const grant = {
    id: grantId,
    phase: "discover",
    slot: "discovery",
    status: "finished",
    outcome: "discovery_complete",
    head,
    runId: proof.runId,
    runAttempt: 1,
    ticket: 89,
  };
  const audit = {
    number: grant.ticket,
    user: { login: "github-actions[bot]", id: 41898282 },
    body: sourceBody(proof),
    labels: [],
  };
  const controls = {
    grants: { [grantId]: grant },
    tickets: {
      [grant.ticket]: {
        origin: "discovery-sweep",
        status: "discovery_complete",
        discovery: proof,
      },
    },
    stop: false,
  };
  const ledger = { read: async () => ({ state: controls }) };
  const discovery = {
    read: async () => ({
      state: { sources: { [proof.key]: { status: "created", issue: grant.ticket, proof } } },
    }),
  };
  const artifact = {
    id: 54,
    name: `discovery-evidence-${grantId}`,
    digest: "sha256:" + "c".repeat(64),
    expired: false,
    size_in_bytes: 3000,
    workflow_run: { id: run.id, head_sha: head },
  };
  const ci = { ...run, path: ".github/workflows/factory-ci.yml", event: "push" };
  const state = emptyMonitorState();
  const issues = [];
  const store = {
    async read() {
      return { state: structuredClone(state), commit: null };
    },
    async save(next) {
      Object.assign(state, next);
      return "b".repeat(40);
    },
  };
  const fixture = {
    artifact,
    controls,
    context,
    event,
    grant,
    ledger,
    discovery,
    store,
    issues,
    run,
  };
  const job = (name, step) => ({
    name,
    status: "completed",
    conclusion: "success",
    steps: [{ name: step, conclusion: "success" }],
  });
  const monitorWorkflow = {
    id: 21,
    path: ".github/workflows/factory-functional-discovery.yml",
  };
  fixture.monitorJobs = [
    {
      ...job("browser", "Run approved browser checks"),
      steps: [
        { name: "Run approved browser checks", conclusion: "success" },
        { name: "Verify functional discovery CI trigger", conclusion: "success" },
      ],
    },
    job("publish", "Publish confirmed functional failure"),
  ];
  fixture.api = {
    async pages(path, key) {
      if (key === "artifacts" && path.endsWith("/runs/31/artifacts"))
        return fixture.artifact ? [fixture.artifact] : [];
      assert.match(path, /\/runs\/31\/attempts\/1\/jobs\?/);
      return [
        job("discover", "Run the one reserved Claude discovery session"),
        job("replay", "Rebuild baseline and replay twice without a model credential"),
        job("finalize"),
      ];
    },
    async request(method, path, body) {
      if (method === "POST" && path.endsWith("/issues")) {
        const issue = {
          number: 90,
          state: "open",
          ...body,
          user: { login: "github-actions[bot]", type: "Bot" },
        };
        issues.push(issue);
        return issue;
      }
      assert.equal(method, "GET");
      if (path.endsWith("/issues/89")) return audit;
      if (path.endsWith("/issues/90")) return issues[0];
      if (path.endsWith("/runs/31/attempts/1")) return fixture.run;
      if (path.endsWith("/runs/17")) return ci;
      if (path.endsWith("/workflows/factory-discovery.yml")) return workflow;
      if (path.endsWith("/artifacts/54")) return fixture.artifact;
      if (path.endsWith("/branches/main")) return { commit: { sha: fixture.mainHead ?? head } };
      if (path.endsWith("/git/ref/heads/factory/monitor-functional"))
        return { object: { sha: head } };
      if (path.endsWith(`/contents/monitor.json?ref=${head}`))
        return {
          type: "file",
          encoding: "base64",
          content: Buffer.from(JSON.stringify(state)).toString("base64"),
        };
      if (path.endsWith("/workflows/factory-functional-discovery.yml")) return monitorWorkflow;
      if (path.endsWith("/runs/41/attempts/1"))
        return {
          ...run,
          id: 41,
          event: "workflow_run",
          path: monitorWorkflow.path,
          workflow_id: monitorWorkflow.id,
        };
      if (path.endsWith("/runs/41/attempts/1/jobs?per_page=100"))
        return { jobs: fixture.monitorJobs };
      throw Error("Unexpected endpoint " + path);
    },
  };
  fixture.evidence = {
    version: 1,
    head,
    grantId,
    source: "claude-subscription",
    fixture: false,
    sourceHash: c.digest("checked-in tree"),
    actualBatches: [
      { number: 1, mode: "cypress", code: 1, networkIsolated: true, testHash: batch().testHash },
    ],
    browserLeads: [
      {
        batch: 1,
        journey,
        templateHash: batch().testHash,
        logHash: c.digest(log),
        marker: "invalid-email",
      },
    ],
  };
  return fixture;
}

test("browser plan requires exact completed sweep and canonical template evidence", async () => {
  const { selectBrowserLead } = bridge();
  const f = fixture();
  const loadEvidence = async () => f.evidence;
  const select = () => selectBrowserLead(f.api, f.context, f.event, { ...f, loadEvidence });
  const selected = await select();
  assert.equal(selected.check, fixed.check);
  assert.equal(selected.assertion, fixed.assertion);
  assert.equal(selected.artifactDigest, f.artifact.digest);
  f.grant.status = "started";
  assert.equal(await select(), null);
  f.grant.status = "finished";
  f.evidence.browserLeads[0].templateHash = c.digest("unapproved code");
  await assert.rejects(select());
  f.evidence.browserLeads[0].templateHash = batch().testHash;
  f.artifact = undefined;
  assert.equal(await select(), null);
});

test("publication requires the exact matched repeat and shares one incident with fixed discovery", async () => {
  const { selectBrowserLead } = bridge();
  const f = fixture();
  const browserSource = await selectBrowserLead(f.api, f.context, f.event, {
    ...f,
    loadEvidence: async () => f.evidence,
  });
  const args = {
    ...f,
    browserSource,
    discoveryEnabled: true,
    status: "confirmed_failure",
    enabled: true,
    dryRun: false,
    ...fixed,
  };
  const held = (change) => publishFunctional({ ...args, ...change });
  assert.equal((await held({ browserSource: null })).outcome, "inconclusive");
  assert.equal((await held({ assertion: "settings-email-required" })).outcome, "inconclusive");
  assert.equal((await held({ discoveryEnabled: false })).outcome, "disabled");
  f.controls.stop = true;
  assert.equal((await held({})).outcome, "disabled");
  f.controls.stop = false;
  let reads = 0;
  assert.equal(
    (
      await held({
        ledger: { read: async () => ({ state: { ...f.controls, stop: ++reads >= 2 } }) },
      })
    ).outcome,
    "disabled"
  );
  assert.equal(f.issues.length, 0);
  f.mainHead = "b".repeat(40);
  await assert.rejects(held({}), /stale for current main/);
  f.mainHead = head;
  await assert.rejects(held({ browserSource: { ...browserSource, artifactDigest: image } }));
  assert.equal(f.issues.length, 0);
  assert.equal((await held({})).outcome, "incident_created");
  assert.equal((await held({})).outcome, "incident_existing");
  assert.equal(
    (
      await held({
        browserSource: null,
        context: { ...f.context, eventName: "schedule", runId: "42" },
      })
    ).outcome,
    "incident_existing"
  );
  assert.equal(f.issues.length, 1);
  assert.match(f.issues[0].body, /actions\/runs\/31/);
  assert.ok(f.issues[0].body.includes(f.artifact.digest));
  assert.deepEqual(f.issues[0].labels, ["factory-ready"]);
  const pickup = () => verifyMonitorIssue(f.api, f.issues[0]);
  assert.equal((await pickup()).probeMode, "functional-browser");
  f.monitorJobs[0].steps[1].conclusion = "skipped";
  assert.equal(await pickup(), null);
});

test("a different active fixed browser incident holds the matched sweep failure", async () => {
  const { selectBrowserLead } = bridge();
  const f = fixture();
  const args = { ...f, enabled: true, dryRun: false, status: "confirmed_failure" };
  const fixedIncident = await publishFunctional({
    ...args,
    context: { ...f.context, eventName: "schedule", runId: "42" },
    check: "sign-in",
    assertion: "sign-in-form",
  });
  const browserSource = await selectBrowserLead(f.api, f.context, f.event, {
    ...f,
    loadEvidence: async () => f.evidence,
  });
  const result = await publishFunctional({
    ...args,
    ...fixed,
    browserSource,
    discoveryEnabled: true,
  });
  assert.equal(result.outcome, "another_functional_incident_active");
  assert.equal(result.issue, fixedIncident.issue);
  assert.equal(f.issues.length, 1);
});

test("archive bytes must match the registered source digest before extraction", () => {
  const { decodeBrowserArchive } = bridge();
  // A single evidence.json entry in a normal ZIP archive, containing {"version":1}.
  const expected = Buffer.from(
    "UEsDBBQAAAAIAAAAIQAzmjBxDwAAAA0AAAANAAAAZXZpZGVuY2UuanNvbqtWKkstKs7Mz1OyMqwFAFBLAQIUABQAAAAIAAAAIQAzmjBxDwAAAA0AAAANAAAAAAAAAAAAAACAAQAAAABldmlkZW5jZS5qc29uUEsFBgAAAAABAAEAOwAAADoAAAAAAA==",
    "base64"
  );
  const digest = "sha256:" + createHash("sha256").update(expected).digest("hex");
  assert.throws(() =>
    decodeBrowserArchive(Buffer.concat([expected, Buffer.from("changed")]), digest)
  );
  assert.deepEqual(decodeBrowserArchive(expected, digest), { version: 1 });
});
