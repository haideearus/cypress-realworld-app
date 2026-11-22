const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  yaml = require("js-yaml");
const { fixture, sha } = require("./helpers/event-fixtures.cjs");
test("activity workflow observes lifecycle and issue metadata without model, App or deploy credentials", () => {
  const w = yaml.load(
    fs.readFileSync(`${__dirname}/../../.github/workflows/factory-activity.yml`, "utf8")
  );
  assert.deepEqual(w.on.workflow_run.types, ["in_progress", "completed"]);
  assert.match(w.jobs.observe.if, /github\.event\.action == 'completed'/);
  assert.match(
    w.jobs.observe.if,
    /github\.event\.action == 'in_progress' && github\.event\.workflow_run\.path == '.github\/workflows\/factory-deploy\.yml'/
  );
  assert.equal(w.on.workflow_run.workflows.includes("Factory activity"), false);
  assert.equal(w.on.workflow_run.workflows.includes("Factory event wake"), false);
  assert.equal(w.on.issue_comment, undefined);
  assert.deepEqual(w.jobs.observe.permissions, {
    contents: "write",
    actions: "read",
    issues: "write",
    "pull-requests": "read",
  });
  assert.ok(w.jobs.observe.if.includes("FACTORY_ACTIVITY_LOG_ENABLED"));
  assert.equal(JSON.stringify(w).includes("secrets."), false);
  assert.equal(
    w.jobs.observe.steps.find((s) => s.uses?.startsWith("actions/checkout@")).with.ref,
    "${{ github.workflow_sha }}"
  );
  assert.equal(w.on.workflow_dispatch.inputs.preview.default, true);
});
test("routine start events never call GitHub, while completion and deployment observations still run", async (t) => {
  const { main } = require("../factory/activity-observer.cjs");
  const { REPOSITORY } = require("../factory/wake-contract.cjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "activity-lifecycle-"));
  const eventPath = path.join(tmp, "event.json");
  t.after(() => {
    fs.unlinkSync(eventPath);
    fs.rmdirSync(tmp);
  });
  const api = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 403 }));
  const env = {
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: REPOSITORY + "/.github/workflows/factory-activity.yml@refs/heads/main",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_EVENT_NAME: "workflow_run",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_TOKEN: "fixture-only",
    FACTORY_VARIABLES: JSON.stringify({
      FACTORY_ACTIVITY_LOG_ENABLED: "true",
      FACTORY_ACTIVITY_ISSUE_NUMBER: "84",
    }),
  };
  const writeEvent = (action, workflow) =>
    fs.writeFileSync(
      eventPath,
      JSON.stringify({ action, workflow_run: { path: ".github/workflows/" + workflow } })
    );
  for (const action of ["requested", "in_progress"]) {
    writeEvent(action, "factory-ci.yml");
    assert.deepEqual(await main(env), { outcome: "ignored", modelCalls: 0 });
  }
  assert.equal(api.mock.callCount(), 0);
  writeEvent("completed", "factory-ci.yml");
  await assert.rejects(main(env), { status: 403 });
  writeEvent("in_progress", "factory-deploy.yml");
  await assert.rejects(main(env), { status: 403 });
  assert.equal(api.mock.callCount(), 2);
});

test("run/job observations distinguish actual model starts, failures before model and review verdicts", async () => {
  const { collectRunActivity } = require("../factory/activity-observer.cjs");
  const run = {
    id: 800,
    run_attempt: 1,
    path: ".github/workflows/factory-automatic.yml",
    head_sha: sha,
    actor: { login: "haideearus" },
    status: "completed",
    conclusion: "failure",
  };
  const s = fixture();
  s.ledger.state.grants = {
    g: {
      id: "g",
      ticket: 12,
      phase: "review",
      slot: "cycle1",
      runId: "800",
      runAttempt: 1,
      head: sha,
      status: "finished",
      outcome: "blocked",
    },
  };
  s.ledger.state.tickets = { 12: { status: "blocked", head: sha } };
  const jobs = [
    {
      id: 80,
      name: "cycle1 / review / agent",
      status: "completed",
      conclusion: "failure",
      steps: [
        {
          name: "Verify the durable reservation and prepare the isolated role",
          status: "completed",
          conclusion: "failure",
        },
        {
          name: "Run the one reserved Claude subscription session",
          status: "completed",
          conclusion: "skipped",
        },
      ],
    },
  ];
  let events = await collectRunActivity({ run, jobs, ledger: s.ledger });
  assert.equal(
    events.some((e) => e.kind === "review" && e.state === "started"),
    false
  );
  jobs[0].steps[1] = {
    name: "Run the one reserved Claude subscription session",
    status: "completed",
    conclusion: "success",
  };
  events = await collectRunActivity({ run, jobs, ledger: s.ledger });
  assert.equal(
    events.some((e) => e.kind === "review" && e.state === "started"),
    true
  );
  assert.equal(
    events.some((e) => e.kind === "review" && e.state === "blocked"),
    true
  );
  assert.equal(
    events.some((e) => e.kind === "review" && e.state === "passed"),
    false
  );
});
test("notification enqueue failure preserves work result, usage and approval", async () => {
  const { recordResult } = require("../factory/activity.cjs");
  const s = fixture(),
    before = structuredClone(s.ledger.state),
    result = { ready: false, ticket: 12, reason: "No eligible issue" };
  await recordResult(
    s.api,
    {
      ...s.context,
      workflowRef:
        s.context.repository + "/.github/workflows/factory-automatic.yml@refs/heads/main",
    },
    result,
    {
      FACTORY_VARIABLES: JSON.stringify({ FACTORY_ACTIVITY_LOG_ENABLED: "true" }),
      FACTORY_INPUTS: "{}",
      FACTORY_OPERATION: "auto_pick",
    }
  );
  assert.deepEqual(s.ledger.state, before);
  assert.deepEqual(result, { ready: false, ticket: 12, reason: "No eligible issue" });
});
