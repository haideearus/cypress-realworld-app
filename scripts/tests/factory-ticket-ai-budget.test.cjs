const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../factory/policy.cjs");
const { vars, context, head, FactoryFixture } = require("./helpers/factory-fixtures.cjs");
const { GitHub, Ledger } = require("../factory/github.cjs");
const { Controller } = require("../factory/controller.cjs");

const request = {
  ...context,
  event: "schedule",
  workflowRef: policy.AUTOMATIC_WORKFLOW_REF,
  workflowSha: head,
};
function config(limit, changes = {}) {
  return policy.readConfig({
    ...vars,
    FACTORY_AUTOMATION_ENABLED: "true",
    FACTORY_GITHUB_APP_CLIENT_ID: "Iv1.fixture123456",
    FACTORY_GITHUB_APP_SLUG: "fixture-factory",
    FACTORY_MAX_AI_SESSIONS_PER_TICKET: limit,
    ...changes,
  });
}
function coding(limit) {
  const saved = policy.reserve(policy.emptyState(policy.REPOSITORY), request, config(limit));
  saved.state.tickets["10"].automatic = {
    workflowRef: request.workflowRef,
    workflowSha: head,
    runId: request.runId,
    runAttempt: 1,
    appSlug: "fixture-factory",
  };
  return saved;
}
const review = { ...request, phase: "review", slot: "cycle1" };

test("the automatic ticket pins a shared lifetime budget before the first coding invocation", () => {
  const { state, grant } = coding("3");
  assert.equal(state.tickets["10"].aiSessionLimit, 3);
  assert.doesNotThrow(() => policy.preflight(state, grant.id, request, config("3")));
  for (const limit of ["0", "1"]) assert.throws(() => coding(limit), /ticket AI budget/);
  assert.throws(() => coding("16"), /Invalid FACTORY_MAX_AI_SESSIONS_PER_TICKET/);
  assert.throws(() => coding("3x"), /Invalid FACTORY_MAX_AI_SESSIONS_PER_TICKET/);
  assert.equal(config(undefined).aiSessions, 6);
});

test("a failed coding reservation stays spent and the final session is for independent review", () => {
  const first = coding("2");
  const failed = policy.finish(first.state, first.grant.id, { status: "blocked" });
  assert.throws(
    () => policy.reserve(failed, { ...request, slot: "cycle2" }, config("10")),
    /ticket AI budget/
  );
  assert.equal(failed.tickets["10"].coding, 1);
  assert.equal(failed.tickets["10"].reviews, 0);
  assert.equal(Object.keys(failed.grants).length, 1);
});

test("an interrupted review and its continuation share the original allowance", () => {
  const first = coding("3");
  const published = policy.finish(first.state, first.grant.id, {
    status: "awaiting_review",
    pr: 20,
  });
  const reserved = policy.reserve(published, review, config("8"));
  const interrupted = policy.finish(reserved.state, reserved.grant.id, {
    status: "awaiting_review",
  });
  assert.throws(() => policy.reserve(interrupted, review, config("8")), /already reserved/);
  const retry = { ...review, slot: "cycle2" };
  const resumed = policy.reserve(interrupted, retry, config("8"));
  assert.equal(resumed.state.tickets["10"].aiSessionLimit, 3);
  assert.equal(resumed.state.tickets["10"].coding, 1);
  assert.equal(resumed.state.tickets["10"].reviews, 2);
  assert.deepEqual(resumed.state.grants[reserved.grant.id], interrupted.grants[reserved.grant.id]);
  assert.doesNotThrow(() => policy.preflight(resumed.state, resumed.grant.id, retry, config("8")));
  assert.throws(
    () => policy.preflight(resumed.state, resumed.grant.id, retry, config("2")),
    /ticket AI budget/
  );
  const finished = policy.finish(resumed.state, resumed.grant.id, { status: "awaiting_review" });
  assert.throws(
    () => policy.reserve(finished, { ...review, slot: "cycle3" }, config("8")),
    /ticket AI budget/
  );
});

test("legacy automatic grants are counted on adoption without rewriting their history", () => {
  const first = coding("4");
  const published = policy.finish(first.state, first.grant.id, {
    status: "awaiting_review",
    pr: 20,
  });
  delete published.tickets["10"].aiSessionLimit;
  assert.doesNotThrow(() => policy.validateState(published));
  assert.throws(() => policy.reserve(published, review, config("1")), /ticket AI budget/);
  const next = policy.reserve(published, review, config("2"));
  assert.equal(next.state.tickets["10"].aiSessionLimit, 2);
  assert.deepEqual(next.state.grants[first.grant.id], published.grants[first.grant.id]);
  const forged = structuredClone(next.state);
  forged.tickets["10"].aiSessionLimit = 1;
  assert.throws(() => policy.validateState(forged), /ticket AI budget/);
});

test("exhausted correction allowance releases the active slot and keeps the existing PR", async () => {
  const fixture = new FactoryFixture();
  Object.assign(fixture.issues.get(10), {
    user: { login: policy.OWNER },
    labels: [{ name: "factory-ready" }],
  });
  fixture.ciConclusion = "failure";
  const api = new GitHub({ token: "fixture-only", fetch: fixture.fetch });
  const requestGitHub = api.request.bind(api);
  api.request = async (method, route, body) => {
    const response = await requestGitHub(method, route, body);
    if (/\/pulls(?:\/\d+)?$/.test(route) && !Array.isArray(response))
      response.user = { login: "fixture-factory[bot]", type: "Bot" };
    return response;
  };
  const ledger = new Ledger(api);
  await ledger.initialize();
  const controller = new Controller(api, config("2"), request, {
    maxPolls: 2,
    sleep: async () => {},
  });
  const code = await controller.admit(10);
  const published = await controller.publish(code.grantId, {
    kind: "code",
    grantId: code.grantId,
    base: code.head,
    files: [{ path: "src/example.ts", mode: "100644", content: "export const example = true;\n" }],
    evidence: "Regression failed before the change and passed after the change.",
  });
  const ci = await controller.ci(10);
  assert.equal(ci.passed, false);
  const result = await controller.assess(
    10,
    { coding: "success", publication: "success", ci: "success", review: "skipped" },
    ci.runId,
    undefined,
    undefined,
    "cycle1"
  );
  assert.equal(result.retry, false);
  const { state } = await ledger.read();
  assert.equal(state.tickets[10].status, "blocked");
  assert.equal(state.tickets[10].pr, published.pr);
  assert.equal(state.tickets[10].coding, 1);
  assert.equal(state.tickets[10].reviews, 0);
  assert.equal(state.active, null);
});
