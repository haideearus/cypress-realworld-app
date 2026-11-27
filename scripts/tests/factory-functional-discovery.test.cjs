const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const { emptyMonitorState } = require("../factory/monitor-state.cjs");
const { validateMonitorProof, proofFromIncident } = require("../factory/monitor-proof.cjs");
const p = require("../factory/policy.cjs");

const sha = "a".repeat(40);
const context = {
  repository: p.REPOSITORY,
  ref: "refs/heads/main",
  workflowRef: p.REPOSITORY + "/.github/workflows/factory-functional-discovery.yml@refs/heads/main",
  workflowSha: sha,
  sha,
  runId: "514",
  runAttempt: 1,
  eventName: "workflow_dispatch",
  actor: p.OWNER,
  triggeringActor: p.OWNER,
};

function publisherFixture() {
  const state = emptyMonitorState();
  const issues = new Map();
  let posts = 0;
  const store = {
    read: async () => ({ state: structuredClone(state), commit: null }),
    save: async (next) => {
      Object.assign(state, next);
      return "b".repeat(40);
    },
  };
  const api = {
    async request(method, route, body) {
      if (method === "GET" && route.endsWith("/branches/main")) return { commit: { sha } };
      if (method === "GET" && /\/issues\/\d+$/.test(route))
        return issues.get(Number(route.split("/").at(-1)));
      assert.equal(method, "POST");
      assert.match(route, /\/issues$/);
      assert.deepEqual(body.labels, ["factory-ready"]);
      posts++;
      const ticket = {
        number: 199 + posts,
        state: "open",
        title: body.title,
        body: body.body,
        user: { login: "github-actions[bot]", type: "Bot" },
      };
      issues.set(ticket.number, ticket);
      return ticket;
    },
  };
  return { api, store, state, posts: () => posts, ticket: (id = 200) => issues.get(id) };
}

test("browser discovery defaults to preview and separates tests from the publisher", () => {
  const workflow = yaml.load(
    fs.readFileSync(
      path.join(__dirname, "../../.github/workflows/factory-functional-discovery.yml"),
      "utf8"
    )
  );
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true);
  const rehearsal = p.REPOSITORY.endsWith("-settings-rehearsal");
  assert.deepEqual(workflow.on.workflow_run, {
    workflows: rehearsal ? ["Factory CI"] : ["Factory CI", "Proactive app discovery"],
    branches: ["main"],
    types: ["completed"],
  });
  assert.deepEqual(workflow.jobs.browser.permissions, {
    contents: "read",
    actions: "read",
    issues: "read",
  });
  const browserSteps = workflow.jobs.browser.steps;
  const preflight = browserSteps.find(
    (step) => step.name === "Verify functional discovery CI trigger"
  );
  assert.equal(preflight.env.FACTORY_FUNCTIONAL_OPERATION, "plan");
  assert.equal(workflow.on.workflow_dispatch.inputs.extended.default, false);
  if (rehearsal) assert.equal(workflow.on.schedule, undefined);
  else
    assert.ok(
      workflow.on.schedule.some(
        (entry) => entry.cron === "20 7 * * 0" && entry.timezone === "Europe/Bucharest"
      )
    );
  assert.ok(
    browserSteps.indexOf(preflight) <
      browserSteps.findIndex((step) => step.name === "Prepare the disposable application")
  );
  assert.deepEqual(
    browserSteps.filter((step) => step.env?.GITHUB_TOKEN),
    [preflight]
  );
  assert.equal(workflow.jobs.publish.needs, "browser");
  assert.equal(workflow.jobs.publish.permissions.issues, "write");
  assert.doesNotMatch(JSON.stringify(workflow), /CLAUDE|ANTHROPIC|RENDER_DEPLOY|MONITOR_PASSWORD/);

  const ci = yaml.load(
    fs.readFileSync(path.join(__dirname, "../../.github/workflows/factory-ci.yml"), "utf8")
  );
  const approvedCheckout = ci.jobs.app.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@")
  ).uses;
  assert.match(approvedCheckout, /^actions\/checkout@[0-9a-f]{40}$/);
  for (const job of [workflow.jobs.browser, workflow.jobs.publish]) {
    assert.deepEqual(
      job.steps.map((step) => step.uses).filter((uses) => uses?.startsWith("actions/checkout@")),
      [approvedCheckout]
    );
  }
});

test("preview, disabled, and inconclusive runs publish no ticket", async () => {
  const { publishFunctional } = require("../factory/functional-discovery.cjs");
  const s = publisherFixture();
  const args = {
    ...s,
    context,
    status: "confirmed_failure",
    check: "settings",
    assertion: "settings-profile",
    enabled: true,
    dryRun: true,
  };
  assert.equal((await publishFunctional(args)).outcome, "preview");
  assert.equal(
    (await publishFunctional({ ...args, enabled: false, dryRun: false })).outcome,
    "disabled"
  );
  assert.equal(
    (
      await publishFunctional({
        ...args,
        dryRun: false,
        status: "inconclusive",
        check: "",
        assertion: "",
      })
    ).outcome,
    "inconclusive"
  );
  assert.equal(s.posts(), 0);
  assert.deepEqual(s.state, emptyMonitorState());
});

test("a first successful current-main CI push by the factory can publish the same finding only once", async () => {
  const { publishFunctional } = require("../factory/functional-discovery.cjs");
  const { FACTORY_APP } = require("../factory/discovery-contract.cjs");
  const app = { login: FACTORY_APP, id: 356310548, type: "Bot" };
  const repository = { full_name: p.REPOSITORY };
  const workflow = { id: 33, path: ".github/workflows/factory-ci.yml" };
  const source = {
    id: 513,
    workflow_id: workflow.id,
    path: workflow.path,
    repository,
    head_repository: repository,
    head_branch: "main",
    head_sha: sha,
    run_attempt: 1,
    event: "push",
    status: "completed",
    conclusion: "success",
    actor: app,
    triggering_actor: app,
  };
  const event = { action: "completed", repository, workflow, workflow_run: source };
  const verify = {
    name: "verify",
    run_id: source.id,
    run_attempt: 1,
    head_sha: sha,
    status: "completed",
    conclusion: "success",
  };
  const s = publisherFixture();
  let recordedRun = source;
  let jobs = [verify];
  let mainHead = sha;
  const api = {
    async request(method, route, body) {
      if (route.endsWith("/actions/workflows/factory-ci.yml")) return workflow;
      if (route.endsWith("/actions/runs/513/attempts/1")) return recordedRun;
      if (route.endsWith("/actions/runs/513/attempts/1/jobs?per_page=100")) return { jobs };
      if (route.endsWith("/branches/main")) return { commit: { sha: mainHead } };
      return s.api.request(method, route, body);
    },
  };
  const args = {
    ...s,
    api,
    context: {
      ...context,
      eventName: "workflow_run",
      actor: FACTORY_APP,
      triggeringActor: FACTORY_APP,
    },
    event,
    status: "confirmed_failure",
    check: "settings",
    assertion: "settings-profile",
    enabled: true,
    dryRun: false,
  };
  for (const invalid of [
    { event: "pull_request" },
    { run_attempt: 2 },
    { head_sha: "b".repeat(40) },
    { head_repository: { full_name: "someone/other" } },
    { conclusion: "failure" },
  ]) {
    await assert.rejects(
      publishFunctional({ ...args, event: { ...event, workflow_run: { ...source, ...invalid } } })
    );
  }
  await assert.rejects(publishFunctional({ ...args, dryRun: true }));
  recordedRun = { ...source, actor: { ...app, id: 1 } };
  await assert.rejects(publishFunctional(args));
  recordedRun = source;
  jobs = [{ ...verify, conclusion: "skipped" }];
  await assert.rejects(publishFunctional(args));
  jobs = [verify];
  mainHead = "c".repeat(40);
  await assert.rejects(publishFunctional(args), /stale for current main/);
  assert.equal(s.posts(), 0);
  mainHead = sha;
  assert.equal((await publishFunctional(args)).issue, 200);
  assert.equal((await publishFunctional(args)).outcome, "incident_existing");
  assert.equal(s.posts(), 1);
});

test("only a verified fixed check can publish a deduplicated functional repair ticket", async () => {
  const { publishFunctional, publicationSummary } = require("../factory/functional-discovery.cjs");
  const s = publisherFixture();
  const args = {
    ...s,
    context,
    status: "confirmed_failure",
    check: "form-validation",
    assertion: "settings-email-invalid",
    enabled: true,
    dryRun: false,
  };
  await assert.rejects(publishFunctional({ ...args, check: "arbitrary probe" }));
  await assert.rejects(publishFunctional({ ...args, assertion: "sign-in-form" }));
  await assert.rejects(publishFunctional({ ...args, context: { ...context, runAttempt: 2 } }));
  await assert.rejects(
    publishFunctional({
      ...args,
      api: { request: async () => ({ commit: { sha: "f".repeat(40) } }) },
    }),
    /current main/i
  );
  const created = await publishFunctional(args);
  assert.equal(created.issue, 200);
  assert.equal((await publishFunctional(args)).outcome, "incident_existing");
  assert.equal(s.posts(), 1);
  assert.equal(s.ticket().title, "Functional discovery: Settings form validation failed");
  assert.match(s.ticket().body, /form-validation/);
  assert.match(s.ticket().body, /Failed assertion: settings-email-invalid/);
  assert.equal(validateMonitorProof(proofFromIncident(s.state.incidents[s.state.active])), true);
  assert.equal(typeof publicationSummary, "function", "the publisher needs an Actions summary");
  assert.ok(
    publicationSummary(created).includes(
      `Ready ticket published — [#200](https://github.com/${p.REPOSITORY}/issues/200)`
    )
  );
  assert.match(publicationSummary(created), /settings-email-invalid/);
});

test("repeated Settings failures update one evidence comment without altering admission criteria", async () => {
  const { publishFunctional } = require("../factory/functional-discovery.cjs");
  const s = publisherFixture();
  const comments = [];
  const writes = [];
  const bot = { login: "github-actions[bot]", type: "Bot" };
  const api = {
    async request(method, route, payload) {
      if (route.includes("/comments?")) return structuredClone(comments);
      if (route.endsWith("/issues/200/comments") || route.endsWith("/issues/comments/901")) {
        writes.push(method);
        const note = { id: 901, user: bot, ...payload };
        if (method === "POST") comments.push(note);
        else
          Object.assign(
            comments.find((entry) => entry.id === 901),
            note
          );
        return note;
      }
      return s.api.request(method, route, payload);
    },
  };
  const run = (runId, assertion = "settings-email-invalid") =>
    publishFunctional({
      ...s,
      api,
      context: { ...context, runId },
      status: "confirmed_failure",
      check: "form-validation",
      assertion,
      enabled: true,
      dryRun: false,
    });
  assert.equal((await run("514")).issue, 200);
  const criteria = s.ticket().body;
  await run("514");
  await run("515");
  assert.deepEqual(writes, ["POST"]);
  const spoof = { ...comments[0], id: 900, user: { login: "someone", type: "User" } };
  comments.unshift(spoof);
  await run("515");
  await run("517", "settings-save-disabled");
  await run("518");
  await run("516");
  assert.deepEqual(writes, ["POST", "PATCH"]);
  assert.match(comments[1].body, /actions\/runs\/518\b/);
  assert.equal(s.posts(), 1);
  assert.equal(s.ticket().body, criteria);
  s.ticket().state = "closed";
  await run("520");
  assert.equal(writes.length, 2);
});

test("pickup and event wake accept a sign-in accessibility issue only with its retained workflow proof", async () => {
  const { publishFunctional } = require("../factory/functional-discovery.cjs");
  const { verifyMonitorIssue } = require("../factory/monitor-origin.cjs");
  const { classifySignal } = require("../factory/wake-controller.cjs");
  const { AutomaticCoordinator } = require("../factory/automation.cjs");
  const {
    WORKFLOW_PATH,
    WORKFLOW_FILE,
    PROBE_MODE,
  } = require("../factory/functional-discovery-contract.cjs");
  const s = publisherFixture();
  await publishFunctional({
    ...s,
    context,
    status: "confirmed_failure",
    check: "sign-in-accessibility",
    assertion: "sign-in-username-label",
    enabled: true,
    dryRun: false,
  });
  const issue = {
    ...s.ticket(),
    labels: [{ name: "factory-ready" }],
    created_at: "2026-11-19T00:00:00.000Z",
  };
  const run = {
    id: 514,
    path: WORKFLOW_PATH,
    workflow_id: 37,
    repository: { full_name: p.REPOSITORY },
    head_repository: { full_name: p.REPOSITORY },
    head_branch: "main",
    head_sha: sha,
    run_attempt: 1,
    event: "workflow_dispatch",
    actor: { login: p.OWNER, id: 101267861 },
    triggering_actor: { login: p.OWNER, id: 101267861 },
    status: "completed",
    conclusion: "success",
  };
  const job = (name, step) => ({
    name,
    status: "completed",
    conclusion: "success",
    steps: [{ name: step, conclusion: "success" }],
  });
  let jobs = [
    job("browser", "Run approved browser checks"),
    job("publish", "Publish confirmed functional failure"),
  ];
  const api = {
    async request(method, route) {
      assert.equal(method, "GET");
      if (route.endsWith("/git/ref/heads/factory/monitor-functional")) return { object: { sha } };
      if (route.endsWith(`/contents/monitor.json?ref=${sha}`))
        return {
          type: "file",
          encoding: "base64",
          content: Buffer.from(JSON.stringify(s.state)).toString("base64"),
        };
      if (route.endsWith(`/actions/workflows/${WORKFLOW_FILE}`))
        return { id: run.workflow_id, path: WORKFLOW_PATH };
      if (route.endsWith("/actions/runs/514/attempts/1")) return run;
      if (route.endsWith("/actions/runs/514/attempts/1/jobs?per_page=100")) return { jobs };
      if (route.endsWith("/issues/200")) return issue;
      if (route.includes("/issues?state=open&labels=factory-ready")) return [issue];
      throw Error(`Unexpected fixture GET ${route}`);
    },
  };
  const ledgerState = p.emptyState(p.REPOSITORY);
  const ledger = { read: async () => ({ state: ledgerState }) };
  const producer = {
    repository: { full_name: p.REPOSITORY },
    action: "completed",
    workflow_run: run,
  };
  const wake = () =>
    classifySignal({ api, event: producer, context: { event: "workflow_run" }, ledger });
  const coordinator = new AutomaticCoordinator(api, { discovery: false }, {});
  assert.equal((await verifyMonitorIssue(api, issue)).probeMode, PROBE_MODE);
  assert.equal((await coordinator.candidate(ledgerState)).number, 200);
  assert.equal((await wake()).kind, "monitor");
  assert.equal((await wake()).lane, "app");
  assert.equal(await verifyMonitorIssue(api, { ...issue, body: "Edited issue" }), null);
  issue.state = "closed";
  assert.equal(await wake(), null);
  issue.state = "open";
  issue.labels = [];
  assert.equal(await wake(), null);
  issue.labels = [{ name: "factory-ready" }];

  const { FACTORY_APP } = require("../factory/discovery-contract.cjs");
  const factoryApp = { login: FACTORY_APP, id: 356310548, type: "Bot" };
  run.event = "workflow_run";
  run.actor = run.triggering_actor = factoryApp;
  assert.equal(await verifyMonitorIssue(api, issue), null);
  jobs[0].steps.push({ name: "Verify functional discovery CI trigger", conclusion: "success" });
  assert.equal((await verifyMonitorIssue(api, issue)).probeMode, PROBE_MODE);
  assert.equal((await coordinator.candidate(ledgerState)).number, 200);
  assert.equal((await wake()).kind, "monitor");
  run.actor = { ...factoryApp, id: 1 };
  assert.equal(await verifyMonitorIssue(api, issue), null);
  run.actor = factoryApp;

  jobs = [jobs[1]];
  assert.equal(await verifyMonitorIssue(api, issue), null);
  assert.equal(await coordinator.candidate(ledgerState), null);
  assert.equal(await wake(), null);
});

test("another confirmed assertion cannot mark the active functional incident recovered", async () => {
  const { publishFunctional } = require("../factory/functional-discovery.cjs");
  const { ASSERTIONS } = require("../factory/functional-discovery-contract.cjs");
  const s = publisherFixture();
  const run = (status, check, assertion = ASSERTIONS[check]?.[0] || "") =>
    publishFunctional({ ...s, context, status, check, assertion, enabled: true, dryRun: false });
  await run("confirmed_failure", "sign-in");
  const first = s.state.active;
  assert.equal(
    (await run("confirmed_failure", "settings")).outcome,
    "another_functional_incident_active"
  );
  assert.equal(s.state.incidents[first].functionalCheck, "sign-in");
  assert.equal(s.state.incidents[first].recovered, false);
  await run("confirmed_failure", "sign-in");
  assert.equal(s.state.incidents[first].recovered, false);
  assert.equal(
    (await run("confirmed_failure", "sign-in", "sign-in-route")).outcome,
    "another_functional_incident_active"
  );
  assert.equal(s.state.incidents[first].functionalAssertion, "sign-in-form");
  assert.equal(s.state.incidents[first].recovered, false);
  s.ticket().state = "closed";
  assert.equal(
    (await run("confirmed_failure", "settings")).outcome,
    "another_functional_incident_active"
  );
  assert.equal(s.state.incidents[first].recovered, false);
  s.ticket().state = "open";
  await run("healthy", "");
  assert.equal(s.state.incidents[first].recovered, true);
  assert.equal(
    (await run("confirmed_failure", "settings")).outcome,
    "another_functional_incident_active"
  );
  assert.equal(s.state.incidents[first].recovered, true);
  assert.equal(s.posts(), 1);

  s.ticket().state = "closed";
  assert.equal((await run("confirmed_failure", "settings")).issue, 201);
  assert.equal(s.state.incidents[s.state.active].functionalCheck, "settings");
  assert.equal(s.state.incidents[first].recovered, true);
  assert.equal(s.posts(), 2);
});

test("only a repeated named onboarding failure produces one ready repair ticket", async () => {
  const { verifyFunctionalChecks } = require("../factory/functional-browser.cjs");
  const { publishFunctional } = require("../factory/functional-discovery.cjs");
  const s = publisherFixture();
  const failure = {
    status: "failed",
    failures: { "bank-account-onboarding": "onboarding-save-rejected" },
  };
  const result = await verifyFunctionalChecks(async () => failure);
  const options = { ...s, context, enabled: true, ...result };
  assert.equal((await publishFunctional({ ...options, dryRun: true })).outcome, "preview");
  assert.equal(s.posts(), 0);
  assert.equal((await publishFunctional({ ...options, dryRun: false })).issue, 200);
  assert.equal(
    (await publishFunctional({ ...options, dryRun: false })).outcome,
    "incident_existing"
  );
  assert.equal(s.posts(), 1);
  assert.match(s.ticket().body, /Failed assertion: onboarding-save-rejected/);
});

test("a weekly-only failure publishes a ready ticket and a short run cannot claim recovery", async () => {
  const { publishFunctional, selectCoverage } = require("../factory/functional-discovery.cjs");
  const s = publisherFixture();
  const args = {
    ...s,
    context,
    status: "confirmed_failure",
    check: "request-decline",
    assertion: "request-decline-balances",
    enabled: true,
    dryRun: false,
  };
  assert.equal(await selectCoverage(s.store, false), false);
  await assert.rejects(publishFunctional(args), /coverage/);
  assert.equal(s.posts(), 0);
  const created = await publishFunctional({ ...args, extended: true });
  assert.equal(created.outcome, "incident_created");
  assert.equal(created.issue, 200);
  assert.match(s.ticket().body, /request-decline-balances/);
  assert.equal(await selectCoverage(s.store, false), true);
  const healthy = { ...args, status: "healthy", check: "", assertion: "" };
  assert.equal((await publishFunctional(healthy)).outcome, "required_probe_missing");
  assert.equal(s.state.incidents[s.state.active].recovered, false);
  assert.equal((await publishFunctional({ ...healthy, extended: true })).outcome, "recovered");
  assert.equal(s.state.incidents[s.state.active].recovered, true);
  assert.equal(s.posts(), 1);
});

test("passing the active weekly assertion twice records recovery even when another check fails", async () => {
  const { publishFunctional } = require("../factory/functional-discovery.cjs");
  const s = publisherFixture();
  const args = {
    ...s,
    context,
    status: "confirmed_failure",
    check: "request-decline",
    assertion: "request-decline-balances",
    enabled: true,
    dryRun: false,
    extended: true,
  };
  await publishFunctional(args);
  const differentFailure = {
    ...args,
    check: "request-acceptance",
    assertion: "request-acceptance-notification",
  };
  await assert.rejects(
    publishFunctional({ ...differentFailure, passedChecks: ["request-acceptance"] }),
    /passed browser checks/
  );
  const result = await publishFunctional({
    ...differentFailure,
    passedChecks: ["request-decline"],
  });
  assert.equal(result.outcome, "recovered");
  assert.equal(s.state.incidents[s.state.active].recovered, true);
  assert.equal(s.posts(), 1);
});
