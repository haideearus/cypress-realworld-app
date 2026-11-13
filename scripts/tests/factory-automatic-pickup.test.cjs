const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../factory/policy.cjs");
const { GitHub, Ledger, ROOT } = require("../factory/github.cjs");
const { vars, context, head, FactoryFixture } = require("./helpers/factory-fixtures.cjs");
let implementation;
try {
  implementation = require("../factory/automation.cjs");
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}

const automaticContext = {
  ...context,
  event: "schedule",
  workflowRef:
    "haideearus/cypress-realworld-app/.github/workflows/factory-automatic.yml@refs/heads/main",
  workflowSha: head,
};
const automaticVars = {
  ...vars,
  FACTORY_AUTOMATION_ENABLED: "true",
  FACTORY_AUTOMERGE_ENABLED: "true",
  FACTORY_GITHUB_APP_CLIENT_ID: "Iv1.fixture123456",
  FACTORY_GITHUB_APP_SLUG: "fixture-factory",
};
const issue = (number, changes = {}) => ({
  number,
  title: `Repair ${number}`,
  body: "Reproduce the application bug and add a failing regression before fixing it.",
  state: "open",
  user: { login: "haideearus" },
  labels: [{ name: "factory-ready" }],
  created_at: `2026-01-${String(number).padStart(2, "0")}T00:00:00Z`,
  ...changes,
});
async function setup(changes = {}, ctx = automaticContext) {
  const fixture = new FactoryFixture();
  fixture.issues = new Map([[10, issue(10)]]);
  fixture.issuePages = null;
  fixture.queueCalls = [];
  const inherited = fixture.fetch;
  fixture.fetch = async (url, options = {}) => {
    const u = new URL(url);
    if (u.pathname === `${ROOT}/issues` && (options.method || "GET") === "GET") {
      fixture.queueCalls.push(String(url));
      const page = Number(u.searchParams.get("page") || 1);
      const rows = fixture.issuePages
        ? fixture.issuePages[page - 1] || []
        : [...fixture.issues.values()];
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    return inherited(url, options);
  };
  const api = new GitHub({ token: "fixture-only", fetch: fixture.fetch });
  const ledger = new Ledger(api);
  await ledger.initialize();
  const config = policy.readConfig({ ...automaticVars, ...changes });
  const coordinator = new implementation.AutomaticCoordinator(api, config, ctx);
  fixture.calls.length = 0;
  return { fixture, api, ledger, config, coordinator };
}

test("automatic pickup coordinator exists", () => assert.ok(implementation));

test("disabled pickup returns before network access and creates no reservation", async () => {
  for (const changes of [{ FACTORY_ENABLED: "false" }, { FACTORY_AUTOMATION_ENABLED: "false" }]) {
    const { coordinator, fixture } = await setup(changes);
    const result = await coordinator.pick();
    assert.equal(result.ready, false);
    assert.match(result.reason, /disabled/i);
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.queueCalls.length, 0);
  }
});

test("explicit preview while disabled selects a proposal without writing or granting", async () => {
  const { coordinator, ledger, fixture } = await setup({
    FACTORY_ENABLED: "false",
    FACTORY_AUTOMATION_ENABLED: "false",
    FACTORY_GITHUB_APP_CLIENT_ID: undefined,
    FACTORY_GITHUB_APP_SLUG: undefined,
  });
  const before = (await ledger.read()).state;
  fixture.calls.length = 0;
  const result = await coordinator.pick({ dryRun: true });
  assert.equal(result.ready, false);
  assert.equal(result.preview, true);
  assert.equal(result.ticket, 10);
  assert.deepEqual((await ledger.read()).state, before);
  assert.equal(
    fixture.calls.some((call) => call.method !== "GET"),
    false
  );
});

test("pickup ignores foreign/unlabelled/closed/PR candidates and takes the oldest owner issue", async () => {
  const { coordinator, fixture, ledger } = await setup();
  fixture.issues = new Map([
    [9, issue(9, { user: { login: "stranger" } })],
    [8, issue(8, { labels: [] })],
    [7, issue(7, { state: "closed" })],
    [6, issue(6, { pull_request: { url: "fixture-pr" } })],
    [12, issue(12)],
    [10, issue(10)],
  ]);
  const result = await coordinator.pick();
  assert.equal(result.ready, true);
  assert.equal(result.ticket, 10);
  const state = (await ledger.read()).state;
  assert.equal(Object.keys(state.grants).length, 1);
  assert.equal(state.tickets["10"].coding, 1);
  assert.equal(state.tickets["10"].automatic.runId, automaticContext.runId);
  assert.equal(state.tickets["10"].automatic.appSlug, "fixture-factory");
  assert.ok(fixture.queueCalls[0].includes("labels=factory-ready"));
});

test("previously consumed tickets are not restarted and their grants are preserved", async () => {
  const { coordinator, fixture, ledger, config } = await setup();
  const old = policy.reserve(policy.emptyState(policy.REPOSITORY), context, config);
  const blocked = policy.finish(old.state, old.grant.id, { status: "blocked" });
  await ledger.update(() => ({ state: blocked }));
  fixture.issues.set(11, issue(11));
  const result = await coordinator.pick();
  assert.equal(result.ticket, 11);
  const state = (await ledger.read()).state;
  assert.deepEqual(state.grants[old.grant.id], blocked.grants[old.grant.id]);
  assert.equal(state.tickets["10"].coding, 1);
  assert.equal(state.tickets["10"].status, "blocked");
});

test("a second tick cannot admit another issue while a ticket is active", async () => {
  const { coordinator, fixture, api, config, ledger } = await setup();
  await coordinator.pick();
  fixture.issues.set(11, issue(11));
  const second = new implementation.AutomaticCoordinator(api, config, {
    ...automaticContext,
    runId: "101",
  });
  assert.equal((await second.pick()).ready, false);
  assert.equal(Object.keys((await ledger.read()).state.grants).length, 1);
});

test("concurrent pickup attempts consume exactly one lifetime grant", async () => {
  const { coordinator, api, config, ledger } = await setup();
  const second = new implementation.AutomaticCoordinator(api, config, {
    ...automaticContext,
    runId: "101",
  });
  const results = await Promise.all([coordinator.pick(), second.pick()]);
  assert.equal(results.filter((result) => result.ready).length, 1);
  const state = (await ledger.read()).state;
  assert.equal(Object.keys(state.grants).length, 1);
  assert.equal(state.tickets["10"].coding, 1);
});

test("pickup respects current admission budgets without an automatic retry loop", async () => {
  for (const change of [
    { FACTORY_MAX_TICKETS_PER_DAY: "0" },
    { FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET: "0" },
  ]) {
    const { coordinator, ledger } = await setup(change);
    const result = await coordinator.pick();
    assert.equal(result.ready, false);
    assert.match(result.reason, /limit|budget/i);
    assert.equal(Object.keys((await ledger.read()).state.grants).length, 0);
  }
});

test("queue scanning is bounded even when all server-returned records are ineligible", async () => {
  const { coordinator, fixture } = await setup();
  fixture.issuePages = Array.from({ length: 6 }, () =>
    Array.from({ length: 100 }, (_, i) => issue(i + 1, { user: { login: "stranger" } }))
  );
  const result = await coordinator.pick({ dryRun: true });
  assert.equal(result.ready, false);
  assert.equal(result.ticket, undefined);
  assert.equal(fixture.queueCalls.length, 5);
  assert.equal(
    fixture.calls.some((call) => call.method !== "GET"),
    false
  );
});

test("preview and live pickup reject other workflow identities and malformed mode values", async () => {
  const { coordinator } = await setup({}, { ...automaticContext, workflowRef: "foreign.yml" });
  await assert.rejects(coordinator.pick({ dryRun: true }), /authoriz|workflow|trusted/i);
  const valid = await setup();
  await assert.rejects(valid.coordinator.pick({ dryRun: "yes" }), /preview|dry|boolean/i);
});

async function reviewedAutomatic(setupResult, mergeStatus) {
  const { coordinator, ledger, config } = setupResult;
  const admitted = await coordinator.pick();
  await ledger.update((state) => {
    const published = policy.finish(state, admitted.grantId, {
      status: "awaiting_review",
      head,
      pr: 20,
    });
    const reviewed = policy.reserve(
      published,
      { ...automaticContext, phase: "review", head },
      config
    );
    const next = policy.finish(reviewed.state, reviewed.grant.id, {
      status: "reviewed",
      head,
      pr: 20,
      verdict: "pass",
      evidence: `https://github.com/${policy.REPOSITORY}/actions/runs/${automaticContext.runId}`,
    });
    if (mergeStatus) {
      next.tickets["10"].merge = {
        status: mergeStatus,
        head,
        pr: 20,
        at: "2026-11-13T00:00:00.000Z",
        runId: automaticContext.runId,
        runAttempt: 1,
        ...(mergeStatus === "merged" ? { mergeCommit: "b".repeat(40) } : {}),
      };
      if (mergeStatus === "intent")
        next.active = { ticket: 10, runId: automaticContext.runId, runAttempt: 1 };
    }
    return { state: next };
  });
}

test("reviewed automatic PRs take priority over admitting a newer issue", async () => {
  const s = await setup();
  await reviewedAutomatic(s);
  s.fixture.issues.set(11, issue(11));
  const before = (await s.ledger.read()).state;
  const result = await s.coordinator.pick();
  assert.equal(result.ready, false);
  assert.equal(result.kind, "merge");
  assert.equal(result.ticket, 10);
  assert.deepEqual((await s.ledger.read()).state, before);
});

test("an uncertain merge lock is surfaced for reconciliation instead of admitting another model", async () => {
  const s = await setup();
  await reviewedAutomatic(s, "intent");
  s.fixture.issues.set(11, issue(11));
  const before = (await s.ledger.read()).state;
  const result = await s.coordinator.pick();
  assert.equal(result.kind, "merge");
  assert.equal(result.ticket, 10);
  assert.equal(result.ready, false);
  assert.deepEqual((await s.ledger.read()).state, before);
});

test("reconciled merged and closed records allow the next issue without replaying old grants", async () => {
  for (const status of ["merged", "closed"]) {
    const s = await setup();
    await reviewedAutomatic(s, status);
    s.fixture.issues.set(11, issue(11));
    const before = (await s.ledger.read()).state;
    const result = await s.coordinator.pick();
    assert.equal(result.ticket, 11);
    assert.equal(result.ready, true);
    const after = (await s.ledger.read()).state;
    assert.deepEqual(after.tickets["10"], before.tickets["10"]);
    for (const [id, grant] of Object.entries(before.grants))
      assert.deepEqual(after.grants[id], grant);
  }
});

test("disabled automatic CLI does not need a GitHub token and still rejects paid-provider auth", async () => {
  const env = {
    GITHUB_REPOSITORY: automaticContext.repository,
    GITHUB_ACTOR: automaticContext.actor,
    GITHUB_TRIGGERING_ACTOR: automaticContext.triggeringActor,
    GITHUB_REF: automaticContext.ref,
    GITHUB_EVENT_NAME: automaticContext.event,
    GITHUB_RUN_ID: automaticContext.runId,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF: automaticContext.workflowRef,
    GITHUB_WORKFLOW_SHA: automaticContext.workflowSha,
    FACTORY_VARIABLES: JSON.stringify({ ...automaticVars, FACTORY_ENABLED: "false" }),
    FACTORY_INPUTS: '{"dry_run":false}',
    FACTORY_OPERATION: "auto_pick",
  };
  assert.equal((await implementation.main(env)).ready, false);
  await assert.rejects(
    implementation.main({ ...env, ANTHROPIC_API_KEY: "fixture-not-real" }),
    /subscription/i
  );
});
