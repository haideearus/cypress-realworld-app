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
  assert.doesNotMatch(w.jobs.observe.if, /Automatic factory \/ timer/);
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

test("deployment start journals one approval notice and never waits for Render", async (t) => {
  const { main } = require("../factory/activity-observer.cjs");
  const activity = require("../factory/activity.cjs");
  const { ActivityStore } = require("../factory/activity-store.cjs");
  const { GitHub, Ledger } = require("../factory/github.cjs");
  const { repository, MemoryStore } = require("./helpers/event-fixtures.cjs");
  const observer = `${repository}/.github/workflows/factory-activity.yml@refs/heads/main`;
  const deploy = ".github/workflows/factory-deploy.yml";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "activity-deploy-"));
  const eventPath = path.join(tmp, "event.json");
  t.after(() => {
    fs.unlinkSync(eventPath);
    fs.rmdirSync(tmp);
  });
  const run = {
    id: 800,
    run_attempt: 1,
    path: deploy,
    workflow_id: 81,
    head_sha: sha,
    head_branch: "main",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    actor: { login: "haideearus", id: 101267861 },
    status: "in_progress",
    conclusion: null,
  };
  const writeEvent = (action) =>
    fs.writeFileSync(eventPath, JSON.stringify({ action, workflow_run: run }));
  const env = {
    GITHUB_REPOSITORY: repository,
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: observer,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_EVENT_NAME: "workflow_run",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_TOKEN: "fixture-only",
    FACTORY_VARIABLES: JSON.stringify({
      FACTORY_ACTIVITY_LOG_ENABLED: "true",
      FACTORY_ACTIVITY_ISSUE_NUMBER: "84",
    }),
  };
  const store = new MemoryStore(activity.emptyActivity());
  t.mock.method(ActivityStore.prototype, "read", () => store.read());
  t.mock.method(Ledger.prototype, "read", async () => ({
    state: require("../factory/policy.cjs").emptyState(repository),
    commit: sha,
  }));
  t.mock.method(activity, "journal", async () => {});
  const publish = t.mock.method(activity, "publishActivity", async () => {});
  t.mock.method(GitHub.prototype, "request", async (method, route) => {
    assert.equal(method, "GET");
    if (route.endsWith("/actions/workflows/factory-deploy.yml")) return { id: 81, path: deploy };
    if (route.endsWith("/actions/runs/800/attempts/1")) return structuredClone(run);
    if (route.includes("factory-monitor.yml/runs?")) return { workflow_runs: [] };
    if (route.endsWith("/actions/runs/800/approvals"))
      return run.status === "completed"
        ? [{ user: run.actor, state: "approved", environments: [{ name: "production" }] }]
        : [];
    throw Error(`Unexpected fixture request ${route}`);
  });
  const job = { id: 82, name: `Deploy tested commit ${sha}`, status: "waiting" };
  // GitHub can deliver in_progress before the dependent deploy job even exists.
  let jobs = [{ id: 81, name: "prepare", status: "in_progress" }];
  const pages = t.mock.method(GitHub.prototype, "pages", async () => structuredClone(jobs));
  writeEvent("in_progress");
  await main(env, { sleep: () => assert.fail("the activity runner must not poll for approval") });
  assert.equal(pages.mock.callCount(), 1);
  assert.equal(publish.mock.callCount(), 1);
  const first = publish.mock.calls[0].arguments[0].event;
  assert.equal(first.kind, "deployment");
  assert.equal(first.state, "pending");

  jobs = [job];
  await main(env);
  assert.equal(publish.mock.callCount(), 2);
  assert.equal(publish.mock.calls[1].arguments[0].event.id, first.id);

  run.status = "completed";
  run.conclusion = "success";
  job.status = "completed";
  job.conclusion = "success";
  await main(env);
  assert.equal(publish.mock.callCount(), 2);
  writeEvent("completed");
  await main(env);
  const terminal = publish.mock.calls.slice(2).map((call) => call.arguments[0].event.state);
  assert.deepEqual(terminal, ["success", "success", "approved"]);
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
test("timer completions keep idle ticks quiet and report real coding and merge outcomes", async () => {
  const { collectRunActivity } = require("../factory/activity-observer.cjs");
  const timer = {
    id: 801,
    run_attempt: 1,
    path: ".github/workflows/factory-automatic.yml",
    head_sha: sha,
    actor: { login: "haideearus" },
    event: "workflow_dispatch",
    display_title: "Automatic factory / timer 1795687380000",
    status: "completed",
    conclusion: "success",
  };
  const { ledger } = fixture();
  const observe = (options = {}) =>
    collectRunActivity({ run: timer, jobs: [], ledger, ...options });
  assert.deepEqual(await observe(), []);

  ledger.state.grants.g = {
    id: "g",
    ticket: 12,
    phase: "code",
    slot: "cycle1",
    runId: String(timer.id),
    runAttempt: 1,
    head: sha,
  };
  const events = await observe({
    jobs: [{ id: 82, name: "cycle1 / coding / agent", status: "completed", conclusion: "success" }],
  });
  assert.ok(events.some((e) => e.kind === "coding" && e.subject === 12));

  delete ledger.state.grants.g;
  ledger.state.tickets[12] = {
    pr: 301,
    merge: { status: "merged", runId: String(timer.id), runAttempt: 1, mergeCommit: sha },
  };
  const mergeEvents = await observe();
  assert.ok(
    mergeEvents.some((e) => e.kind === "merge" && e.state === "merged" && e.subject === 12)
  );
  ledger.state.tickets[12].merge.runAttempt = 2;
  assert.deepEqual(await observe(), []);
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
