const assert = require("node:assert/strict");
const test = require("node:test");
const policy = require("../factory/policy.cjs");
const retry = require("../factory/delayed-retry.cjs");
const { AutomaticCoordinator, main: runAutomatic } = require("../factory/automation.cjs");
const { Controller, criteriaHash } = require("../factory/controller.cjs");

const oldHead = "a".repeat(40);
const newHead = "b".repeat(40);
const now = new Date("2026-11-19T12:00:00Z");
const run = {
  repository: policy.REPOSITORY,
  actor: policy.OWNER,
  triggeringActor: policy.OWNER,
  ref: "refs/heads/main",
  event: "schedule",
  workflowRef: policy.AUTOMATIC_WORKFLOW_REF,
  workflowSha: oldHead,
  runId: "81",
  runAttempt: 1,
  ticket: 120,
  phase: "code",
  slot: "cycle1",
  head: oldHead,
};
const config = {
  enabled: true,
  automatic: true,
  priorityRetry: true,
  appSlug: "factory-app",
  coding: 2,
  retries: 1,
  daily: 5,
  reviews: 2,
  minutes: 15,
  turns: 20,
  concurrent: 1,
  timezone: "Europe/Bucharest",
};

function blocked() {
  const initial = policy.emptyState(policy.REPOSITORY);
  const { state, grant } = policy.reserve(initial, run, config, now);
  state.tickets[120].automatic = {
    workflowRef: run.workflowRef,
    workflowSha: run.workflowSha,
    runId: run.runId,
    runAttempt: 1,
    appSlug: config.appSlug,
  };
  const next = policy.finish(state, grant.id, { status: "blocked" }, now);
  next.tickets[120].delayedRetry = retry.receipt(grant.id, 9001, now);
  return { next, grant };
}

test("retry becomes eligible at 30 minutes and consumes the normal limits on the original issue", () => {
  const { next, grant } = blocked();
  const request = { ...run, runId: "82", workflowSha: newHead, head: newHead, delayedRetry: true };
  const due = new Date("2026-11-19T12:30:00Z");
  assert.throws(() => policy.reserve(next, request, config, new Date(due.getTime() - 1)));
  assert.throws(() => policy.reserve(next, request, { ...config, priorityRetry: false }, due));
  assert.throws(() => policy.reserve(next, request, { ...config, retries: 0 }, due));
  const result = policy.reserve(next, request, config, due);
  assert.deepEqual(result.state.days, next.days);
  assert.deepEqual(result.state.grants[grant.id], next.grants[grant.id]);
  assert.deepEqual(result.state.tickets[120].automatic, next.tickets[120].automatic);
  assert.deepEqual([result.state.tickets[120].coding, result.state.tickets[120].retries], [2, 1]);
  assert.equal(
    policy.preflight(result.state, result.grant.id, request, config).id,
    result.grant.id
  );
  const stopped = policy.finish(result.state, result.grant.id, { status: "blocked" }, due);
  assert.throws(() => policy.reserve(stopped, { ...request, runId: "83" }, config, due));
});

test("historical blocked issues, other parents and published repairs remain ineligible", () => {
  const { next } = blocked();
  const due = new Date("2026-11-19T12:31:00Z");
  const archived = structuredClone(next);
  delete archived.tickets[120].delayedRetry;
  assert.equal(retry.due(archived, archived.tickets[120], 120, config, due), false);
  assert.equal(retry.due(next, { ...next.tickets[120], pr: 80 }, 120, config, due), false);
  assert.throws(() => policy.reserve(next, { ...run, delayedRetry: true }, config, due));
});

test("trusted job proof requires the exact failed marker and a visibly skipped Claude step", async () => {
  const steps = [
    { name: retry.HOLD_STEP, status: "completed", conclusion: "failure" },
    { name: retry.MODEL_STEP, status: "completed", conclusion: "skipped" },
  ];
  const job = {
    id: 9001,
    name: "cycle1 / coding / agent",
    run_id: 81,
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
    steps,
  };
  const api = { pages: async () => [job] };
  assert.equal(await retry.failedJob(api, run), 9001);
  steps[1].conclusion = "success";
  assert.equal(await retry.failedJob(api, run), null);
  steps[1].conclusion = "skipped";
  job.run_attempt = 2;
  assert.equal(await retry.failedJob(api, run), null);
});

const issue = (number, priority = false) => ({
  number,
  state: "open",
  title: `Issue ${number}`,
  body: "A functional UI failure",
  created_at: new Date(now.getTime() + number * 1000).toISOString(),
  labels: [{ name: "factory-ready" }, ...(priority ? [{ name: "factory-priority" }] : [])],
  user: { login: policy.OWNER },
});

test("priority work wins over an older ordinary issue, while the disabled flag leaves FIFO", async () => {
  const standard = issue(121);
  const urgent = issue(122, true);
  const api = { request: async () => [standard, urgent] };
  const state = policy.emptyState(policy.REPOSITORY);
  assert.equal((await new AutomaticCoordinator(api, config, run).candidate(state)).number, 122);
  const legacy = new AutomaticCoordinator(api, { ...config, priorityRetry: false }, run);
  assert.equal((await legacy.candidate(state)).number, 121);
});

test("rechecks the queue before writing any retry reservation", async () => {
  const { next } = blocked();
  const ready = issue(120);
  next.tickets[120].criteriaHash = criteriaHash(ready);
  const context = { ...run, runId: "82", workflowSha: newHead, head: newHead };
  const api = {
    request: async (method, route) => {
      assert.equal(method, "GET");
      if (route.endsWith("/branches/main")) return { commit: { sha: newHead } };
      if (route.endsWith("/issues/120")) return ready;
      if (route.endsWith("/git/ref/heads/agent/factory-120"))
        throw Object.assign(new Error("Missing branch"), { status: 404 });
      throw Error("Unexpected request");
    },
  };
  const coordinator = new AutomaticCoordinator(api, config, context);
  coordinator.controller.rejectDrillIssue = async () => {};
  coordinator.ledger.update = async () => assert.fail("Retry must stay queued");
  coordinator.candidate = async () => issue(121, true);
  assert.match(
    (await coordinator.reserveDelayed(ready, next, oldHead)).reason,
    /New work is ready/
  );
});

function currentCoding() {
  const { next } = blocked();
  const failed = Object.values(next.grants)[0];
  delete next.tickets[120].delayedRetry;
  next.tickets[120].status = "coding";
  failed.status = "reserved";
  delete failed.outcome;
  next.active = { ticket: 120, runId: run.runId, runAttempt: 1 };
  return { next, failed };
}

test("the assessment closes the original grant and queues only a verified pre-model failure", async () => {
  const { next, failed } = currentCoding();
  const steps = [
    { name: retry.HOLD_STEP, status: "completed", conclusion: "failure" },
    { name: retry.MODEL_STEP, status: "completed", conclusion: "skipped" },
  ];
  const api = {
    pages: async () => [
      {
        id: 9001,
        run_id: 81,
        run_attempt: 1,
        name: "cycle1 / coding / agent",
        status: "completed",
        conclusion: "failure",
        steps,
      },
    ],
  };
  const controller = new Controller(api, config, run);
  let written;
  controller.ledger.update = async (write) => {
    written = (await write(next)).state;
  };
  await controller.assess(
    120,
    { coding: "failure", publication: "skipped", ci: "skipped" },
    null,
    null,
    null,
    "cycle1"
  );
  policy.validateState(written);
  assert.equal(written.grants[failed.id].outcome, "blocked");
  assert.equal(written.tickets[120].coding, 1);
  assert.equal(written.tickets[120].delayedRetry.jobId, 9001);
  assert.equal(written.active, null);
});

test("unavailable optional retry proof releases the original slot with no retry receipt", async () => {
  const { next, failed } = currentCoding();
  const controller = new Controller(
    {
      pages: async () => {
        throw Object.assign(new Error("Temporary failure"), { status: 503 });
      },
    },
    config,
    run
  );
  let written;
  controller.ledger.update = async (write) => {
    written = (await write(next)).state;
  };
  await controller.assess(
    120,
    { coding: "failure", publication: "skipped", ci: "skipped" },
    null,
    null,
    null,
    "cycle1"
  );
  policy.validateState(written);
  assert.equal(written.tickets[120].delayedRetry, undefined);
  assert.equal(written.grants[failed.id].outcome, "blocked");
  assert.equal(written.active, null);
});

test("a version-two delayed reservation preserves another ticket's active slot", () => {
  const { next } = blocked();
  const concurrent = { ...config, concurrent: 2 };
  next.version = 2;
  delete next.active;
  next.activeTickets = {};
  const other = policy.reserve(
    next,
    {
      ...run,
      ticket: 121,
      runId: "80",
      event: "workflow_dispatch",
      workflowRef: `${policy.REPOSITORY}/.github/workflows/factory-agents.yml@refs/heads/main`,
    },
    concurrent,
    now
  );
  const recovered = policy.reserve(
    other.state,
    {
      ...run,
      runId: "82",
      head: newHead,
      workflowSha: newHead,
      delayedRetry: true,
    },
    concurrent,
    new Date("2026-11-19T12:30:00Z")
  );
  policy.validateState(recovered.state);
  assert.deepEqual(recovered.state.activeTickets[121], other.state.activeTickets[121]);
  assert.deepEqual(recovered.state.grants[other.grant.id], other.grant);
  assert.equal(recovered.state.activeTickets[120].runId, "82");
});

test("priority preview with the activity journal enabled only reads GitHub", async (t) => {
  const state = policy.emptyState(policy.REPOSITORY);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push([options.method, url.pathname]);
    if (url.pathname.endsWith("/git/ref/heads/factory/state"))
      return Response.json({ object: { sha: oldHead } });
    if (url.pathname.endsWith("/contents/state.json"))
      return Response.json({
        type: "file",
        encoding: "base64",
        content: Buffer.from(JSON.stringify(state)).toString("base64"),
      });
    if (url.pathname.endsWith("/issues")) return Response.json([issue(121), issue(122, true)]);
    throw Error("Unexpected GitHub request");
  });
  const result = await runAutomatic({
    FACTORY_VARIABLES: JSON.stringify({
      FACTORY_ENABLED: "false",
      FACTORY_AUTOMATION_ENABLED: "false",
      FACTORY_AUTOMERGE_ENABLED: "false",
      FACTORY_PRIORITY_RETRY_ENABLED: "true",
      FACTORY_ACTIVITY_LOG_ENABLED: "true",
      FACTORY_ACTIVITY_ISSUE_NUMBER: "84",
      FACTORY_MAX_TICKETS_PER_DAY: "5",
      FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET: "2",
      FACTORY_MAX_REVIEWS_PER_TICKET: "2",
      FACTORY_MAX_AUTOMATIC_RETRIES: "1",
      FACTORY_MAX_CONCURRENT_TICKETS: "1",
      FACTORY_RUN_TIMEOUT_MINUTES: "15",
      FACTORY_MAX_TURNS_PER_RUN: "20",
      FACTORY_TIMEZONE: "Europe/Bucharest",
      FACTORY_APP_URL: "https://haide-software-factory.onrender.com",
    }),
    FACTORY_INPUTS: '{"dry_run":true}',
    FACTORY_OPERATION: "auto_pick",
    GH_TOKEN: "test-only",
    GITHUB_REPOSITORY: run.repository,
    GITHUB_ACTOR: run.actor,
    GITHUB_REF: run.ref,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF: run.workflowRef,
    GITHUB_WORKFLOW_SHA: run.workflowSha,
    GITHUB_RUN_ID: run.runId,
    GITHUB_RUN_ATTEMPT: "1",
  });
  assert.equal(result.ready, false);
  assert.match(result.reason, /#122/);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(([method]) => method === "GET"));
});

test("receipt-backed bot tickets can be reconsidered after a proven pre-model gateway failure", () => {
  const { next } = blocked();
  const due = new Date("2026-11-19T12:31:00Z");
  const t = next.tickets[120];
  assert.equal(retry.due(next, { ...t, monitor: { issue: 120 } }, 120, config, due), true);
  const finding = { ...t, finding: { intake: { head: oldHead } } };
  assert.equal(retry.due(next, finding, 120, config, due), false);
  assert.equal(retry.due(next, finding, 120, { ...config, discovery: true }, due), true);
});

test("a labeled bot ticket cannot retry from stale discovery replay or an unknown origin", async () => {
  const { next } = blocked();
  const candidate = { ...issue(120), user: { login: "github-actions[bot]", type: "Bot" } };
  const t = { ...next.tickets[120], criteriaHash: criteriaHash(candidate) };
  const coordinator = new AutomaticCoordinator(
    { request: async () => assert.fail("Stale or unknown provenance never makes a request") },
    { ...config, discovery: true },
    { ...run, runId: "82", workflowSha: newHead }
  );

  assert.equal(await coordinator.verifyDelayedIssue(candidate, t), false);
  assert.equal(
    await coordinator.verifyDelayedIssue(candidate, {
      ...t,
      finding: { intake: { head: oldHead } },
    }),
    false
  );
});
