const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  yaml = require("js-yaml");
const { fixture, sha } = require("./helpers/event-fixtures.cjs");
test("activity workflow observes lifecycle and issue metadata without model, App or deploy credentials", () => {
  const w = yaml.load(
    fs.readFileSync(`${__dirname}/../../.github/workflows/factory-activity.yml`, "utf8")
  );
  assert.deepEqual(w.on.workflow_run.types, ["requested", "in_progress", "completed"]);
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
