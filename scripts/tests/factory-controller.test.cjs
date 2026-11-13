const test = require("node:test");
const assert = require("node:assert/strict");
const { readConfig } = require("../factory/policy.cjs");
const { GitHub, Ledger } = require("../factory/github.cjs");
const { vars, context, FactoryFixture } = require("./helpers/factory-fixtures.cjs");
let implementation;
try {
  implementation = require("../factory/controller.cjs");
} catch (e) {
  if (e.code !== "MODULE_NOT_FOUND") throw e;
}
async function setup(overrides = {}) {
  const fixture = new FactoryFixture();
  const api = new GitHub({ token: "fixture-only", fetch: fixture.fetch });
  const ledger = new Ledger(api);
  await ledger.initialize();
  const controller = new implementation.Controller(
    api,
    readConfig({ ...vars, ...overrides }),
    context,
    { sleep: async () => {}, maxPolls: 2 }
  );
  return { fixture, api, ledger, controller };
}
function bundle(grant) {
  return {
    kind: "code",
    grantId: grant.grantId,
    base: grant.head,
    files: [{ path: "src/example.ts", mode: "100644", content: "export const fixed = true;\n" }],
    evidence: "Failing regression before; passing regression after.",
  };
}
test("trusted controller exists", () => assert.ok(implementation, "missing trusted controller"));
test("disabled admission never reserves usage or writes a patch", async () => {
  const { controller, ledger, fixture } = await setup({ FACTORY_ENABLED: "false" });
  assert.equal((await controller.admit(10)).ready, false);
  assert.equal((await ledger.read()).state.active, null);
  assert.equal(fixture.prs.length, 0);
});
test("fixture ticket progresses through coding publication CI and a fresh review", async () => {
  const { controller, ledger, fixture } = await setup();
  const grant = await controller.admit(10);
  const published = await controller.publish(grant.grantId, bundle(grant));
  assert.equal(published.pr, 20);
  assert.equal(fixture.prs.length, 1);
  const ci = await controller.ci(10);
  assert.equal(ci.passed, true);
  const review = await controller.reserveReview(10, ci.runId, "cycle1");
  assert.notEqual(review.grantId, grant.grantId);
  const result = await controller.assess(
    10,
    { coding: "success", publication: "success", ci: "success", review: "success" },
    ci.runId,
    review.grantId,
    {
      kind: "review",
      grantId: review.grantId,
      base: published.head,
      result: {
        head: published.head,
        verdict: "pass",
        summary: "No blocking findings",
        findings: [],
      },
    },
    "cycle1"
  );
  assert.equal(result.retry, false);
  assert.equal((await ledger.read()).state.tickets["10"].status, "reviewed");
  assert.equal(fixture.checks.at(-1).conclusion, "success");
  assert.equal(fixture.checks.at(-1).head_sha, published.head);
});
test("forbidden patch consumes its attempt but creates no PR or privileged execution", async () => {
  const { controller, fixture, ledger } = await setup();
  const grant = await controller.admit(10);
  const input = bundle(grant);
  input.files[0].path = ".github/workflows/factory-agents.yml";
  await assert.rejects(controller.publish(grant.grantId, input), /path|policy/i);
  assert.equal(fixture.prs.length, 0);
  assert.equal((await ledger.read()).state.tickets["10"].coding, 1);
});
test("CI failure permits only the single remaining coding attempt", async () => {
  const { controller, fixture, ledger } = await setup();
  fixture.ciConclusion = "failure";
  const g = await controller.admit(10);
  await controller.publish(g.grantId, bundle(g));
  const ci = await controller.ci(10);
  assert.equal(ci.passed, false);
  const retry = await controller.assess(
    10,
    { coding: "success", publication: "success", ci: "success", review: "skipped" },
    ci.runId,
    "",
    null,
    "cycle1"
  );
  assert.equal(retry.retry, true);
  assert.equal((await ledger.read()).state.tickets["10"].coding, 2);
  const state = (await ledger.read()).state;
  assert.equal(state.tickets["10"].retries, 1);
});
test("a failed model job is blocked without retrying a possible subscription quota error", async () => {
  const { controller, ledger } = await setup();
  await controller.admit(10);
  const result = await controller.assess(
    10,
    { coding: "failure", publication: "skipped", ci: "skipped", review: "skipped" },
    0,
    "",
    null,
    "cycle1"
  );
  assert.equal(result.retry, false);
  const { state } = await ledger.read();
  assert.equal(state.active, null);
  assert.equal(state.tickets["10"].coding, 1);
});
test("stale PR head cannot reserve or publish a passing review", async () => {
  const { controller, fixture } = await setup();
  const g = await controller.admit(10);
  await controller.publish(g.grantId, bundle(g));
  const ci = await controller.ci(10);
  fixture.prHeadOverride = "c".repeat(40);
  await assert.rejects(controller.reserveReview(10, ci.runId, "cycle1"), /head/i);
  await controller.gate(20);
  assert.equal(fixture.checks.at(-1).conclusion, "failure");
});
test("cancellation releases only completed prior runs and preserves consumed counters", async () => {
  const { controller, api, ledger, fixture } = await setup();
  await controller.admit(10);
  fixture.activeRunStatus = "in_progress";
  const recovery = new implementation.Controller(
    api,
    readConfig({ ...vars, FACTORY_ENABLED: "false" }),
    { ...context, runId: "101" },
    { sleep: async () => {}, maxPolls: 2 }
  );
  await recovery.cancel();
  const { state } = await ledger.read();
  assert.equal(state.active, null);
  assert.equal(state.tickets["10"].coding, 1);
});
test("orphaned publication branches are refused before another coding attempt is spent", async () => {
  const { controller, fixture, ledger } = await setup();
  fixture.branchHeads.set("agent/factory-10", "d".repeat(40));
  await assert.rejects(controller.admit(10), /branch|publication/i);
  assert.deepEqual((await ledger.read()).state.tickets, {});
});
test("GitHub credentials in coding evidence never reach a PR", async () => {
  const { controller, fixture } = await setup();
  const grant = await controller.admit(10);
  const input = bundle(grant);
  input.evidence = "ghs_" + "X".repeat(40);
  await assert.rejects(controller.publish(grant.grantId, input), /artifact/i);
  assert.equal(fixture.prs.length, 0);
});
test("CI waits for its correlated dispatch despite an older successful same-head run", async () => {
  const { controller, fixture, api, ledger } = await setup();
  const grant = await controller.admit(10);
  await controller.publish(grant.grantId, bundle(grant));
  await api.request(
    "POST",
    "/repos/haideearus/cypress-realworld-app/actions/workflows/factory-ci.yml/dispatches",
    { ref: "agent/factory-10" }
  );
  fixture.hideNewRunPolls = 1;
  const ci = await controller.ci(10);
  assert.equal(ci.runId, 502);
  const saved = (await ledger.read()).state.tickets["10"].ci;
  assert.equal(saved.runId, 502);
  assert.equal(fixture.runs.at(-1).display_title, `Factory CI / ${saved.requestId}`);
});
test("review admission refuses a different CI run even at the exact same head", async () => {
  const { controller, api } = await setup();
  const grant = await controller.admit(10);
  await controller.publish(grant.grantId, bundle(grant));
  await controller.ci(10);
  await api.request(
    "POST",
    "/repos/haideearus/cypress-realworld-app/actions/workflows/factory-ci.yml/dispatches",
    { ref: "agent/factory-10" }
  );
  await assert.rejects(
    controller.reserveReview(10, 502, "cycle1"),
    /CI.*(reservation|dispatch|run)/i
  );
});
function existingPR(fixture) {
  fixture.branchHeads.set("agent/owner-harness", "d".repeat(40));
  fixture.prs.push({
    number: 30,
    branch: "agent/owner-harness",
    state: "open",
    user: { login: "haideearus" },
  });
}
test("owner-authored harness PR obtains the same exact-head gate with a bounded review only", async () => {
  const { controller, fixture, ledger } = await setup();
  existingPR(fixture);
  const grant = await controller.admitPR(10, 30);
  assert.equal(grant.phase, "review");
  assert.equal((await ledger.read()).state.tickets["10"].coding, 0);
  const ci = await controller.ci(10);
  const result = await controller.assessPR(
    10,
    { ci: "success", review: "success" },
    ci.runId,
    grant.grantId,
    {
      kind: "review",
      grantId: grant.grantId,
      base: grant.head,
      result: { head: grant.head, verdict: "pass", summary: "No blocking findings", findings: [] },
    }
  );
  assert.equal(result.reviewed, true);
  assert.equal(fixture.checks.at(-1).conclusion, "success");
  const state = (await ledger.read()).state;
  assert.equal(state.active, null);
  assert.equal(state.tickets["10"].reviews, 1);
  assert.equal(state.tickets["10"].coding, 0);
});
test("existing PR review stays disabled and rejects PRs outside the owner maintenance path", async () => {
  const disabled = await setup({ FACTORY_ENABLED: "false" });
  assert.equal((await disabled.controller.admitPR(10, 30)).ready, false);
  assert.deepEqual((await disabled.ledger.read()).state.tickets, {});
  const { controller, fixture } = await setup();
  existingPR(fixture);
  fixture.prs[0].user.login = "outsider";
  await assert.rejects(controller.admitPR(10, 30), /owner/i);
});
test("failed CI and stale PRs cannot produce owner review approval or an automatic coding retry", async () => {
  const { controller, fixture, ledger } = await setup();
  existingPR(fixture);
  const grant = await controller.admitPR(10, 30);
  fixture.ciConclusion = "failure";
  const ci = await controller.ci(10);
  const result = await controller.assessPR(
    10,
    { ci: "success", review: "skipped" },
    ci.runId,
    grant.grantId,
    null
  );
  assert.equal(result.retry, false);
  assert.equal((await ledger.read()).state.tickets["10"].reviews, 1);
  assert.equal((await ledger.read()).state.active, null);
  await controller.gate(30);
  assert.equal(fixture.checks.at(-1).conclusion, "failure");
  fixture.prHeadOverride = "e".repeat(40);
  await assert.rejects(
    controller.assessPR(10, { ci: "success", review: "success" }, ci.runId, grant.grantId, null),
    /head/i
  );
});
test("configuration smoke operation needs no token, ledger, owner event or network", async () => {
  const result = await implementation.main({
    FACTORY_OPERATION: "validate",
    FACTORY_VARIABLES: JSON.stringify({
      ...vars,
      FACTORY_ENABLED: "false",
      FACTORY_MAX_TURNS_PER_RUN: "50",
      FACTORY_MAX_TICKETS_PER_DAY: "5",
    }),
  });
  assert.equal(result.validated, true);
  assert.equal(result.enabled, false);
  assert.equal(result.ready, false);
});
test("configuration smoke operation preserves strict limits and subscription-only authentication", async () => {
  await assert.rejects(
    implementation.main({
      FACTORY_OPERATION: "validate",
      FACTORY_VARIABLES: JSON.stringify({ ...vars, FACTORY_MAX_TICKETS_PER_DAY: "6" }),
    }),
    /approved limit/i
  );
  await assert.rejects(
    implementation.main({
      FACTORY_OPERATION: "validate",
      FACTORY_VARIABLES: JSON.stringify(vars),
      ANTHROPIC_API_KEY: "forbidden-paid-auth",
    }),
    /subscription/i
  );
});
