const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../factory/policy.cjs");
const { Controller, runtimeContext } = require("../factory/controller.cjs");
const { GitHub, Ledger } = require("../factory/github.cjs");
const { vars, context, FactoryFixture } = require("./helpers/factory-fixtures.cjs");

const workflowRef =
  "haideearus/cypress-realworld-app/.github/workflows/factory-automatic.yml@refs/heads/main";
const workflowSha = "b".repeat(40);
const automaticContext = { ...context, event: "schedule", workflowRef, workflowSha };
const appSlug = "factory-fixture";
const automaticVars = {
  ...vars,
  FACTORY_AUTOMATION_ENABLED: "true",
  FACTORY_AUTOMERGE_ENABLED: "true",
  FACTORY_GITHUB_APP_CLIENT_ID: "Iv1.fixture12345",
  FACTORY_GITHUB_APP_SLUG: appSlug,
};
const now = new Date("2026-11-13T12:00:00.000Z");

async function setup(changes = {}, ctx = automaticContext) {
  const fixture = new FactoryFixture();
  Object.assign(fixture.issues.get(10), {
    user: { login: policy.OWNER },
    labels: [{ name: "factory-ready" }],
  });
  const state = { publisher: `${appSlug}[bot]`, calls: [] };
  const api = new GitHub({
    token: "fixture-only",
    fetch: async (url, options = {}) => {
      const path = new URL(url).pathname;
      state.calls.push({ method: options.method || "GET", path });
      const response = await fixture.fetch(url, options);
      if (
        response.ok &&
        /\/pulls(?:\/\d+)?$/.test(path) &&
        ((options.method || "GET") === "GET" || options.method === "POST")
      ) {
        const body = await response.json();
        if (!Array.isArray(body)) body.user = { login: state.publisher };
        return new Response(JSON.stringify(body), { status: response.status });
      }
      return response;
    },
  });
  const ledger = new Ledger(api);
  await ledger.initialize();
  const config = policy.readConfig({ ...automaticVars, ...changes });
  const controller = new Controller(api, config, ctx, { sleep: async () => {}, maxPolls: 2 });
  return { fixture, api, ledger, config, controller, state };
}
function bundle(grant) {
  return {
    kind: "code",
    grantId: grant.grantId,
    base: grant.head,
    files: [{ path: "src/repair.ts", mode: "100644", content: "export const repaired = true;\n" }],
    evidence: "RED: route assertion failed before repair. GREEN: route assertion passed.",
  };
}

test("automatic settings are opt-in strict booleans and retain legacy configuration", () => {
  const legacy = policy.readConfig(vars);
  assert.equal(legacy.automatic, false);
  assert.equal(legacy.autoMerge, false);
  const live = policy.readConfig(automaticVars);
  assert.equal(live.automatic, true);
  assert.equal(live.autoMerge, true);
  assert.equal(live.appSlug, appSlug);
  assert.equal(live.appClientId, "Iv1.fixture12345");
  for (const key of ["FACTORY_AUTOMATION_ENABLED", "FACTORY_AUTOMERGE_ENABLED"])
    for (const value of [true, false, "TRUE", "1", "", 0])
      assert.throws(
        () => policy.readConfig({ ...automaticVars, [key]: value }),
        /automatic|automation|merge|boolean/i
      );
});

test("live automatic settings require public App identity while disabled installation stays readable", () => {
  for (const key of ["FACTORY_GITHUB_APP_CLIENT_ID", "FACTORY_GITHUB_APP_SLUG"])
    assert.throws(() => policy.readConfig({ ...automaticVars, [key]: undefined }), /App/i);
  assert.doesNotThrow(() =>
    policy.readConfig({ ...vars, FACTORY_ENABLED: "false", FACTORY_AUTOMATION_ENABLED: "true" })
  );
  for (const [key, value] of [
    ["FACTORY_GITHUB_APP_CLIENT_ID", "123"],
    ["FACTORY_GITHUB_APP_CLIENT_ID", "ghp_" + "x".repeat(40)],
    ["FACTORY_GITHUB_APP_SLUG", "factory[bot]"],
    ["FACTORY_GITHUB_APP_SLUG", "../factory"],
    ["FACTORY_GITHUB_APP_SLUG", "Factory"],
  ])
    assert.throws(
      () => policy.readConfig({ ...automaticVars, FACTORY_ENABLED: "false", [key]: value }),
      /App/i
    );
});

test("only the exact trusted owner workflow authorizes scheduled execution", () => {
  assert.equal(policy.AUTOMATIC_WORKFLOW_REF, workflowRef);
  assert.equal(typeof policy.isAutomaticContext, "function");
  assert.equal(policy.isAutomaticContext(automaticContext), true);
  assert.doesNotThrow(() => policy.authorize(automaticContext));
  assert.doesNotThrow(() => policy.authorize({ ...automaticContext, event: "workflow_dispatch" }));
  assert.doesNotThrow(() => policy.authorize(context));
  for (const change of [
    { repository: "attacker/cypress-realworld-app" },
    { actor: "github-actions[bot]" },
    { triggeringActor: "attacker" },
    { ref: "refs/heads/agent/untrusted" },
    { workflowRef: undefined },
    { workflowRef: workflowRef.replace("factory-automatic.yml", "factory-ci.yml") },
    { workflowSha: "not-a-sha" },
    { workflowSha: [workflowSha] },
    { event: "pull_request_target" },
  ]) {
    assert.equal(policy.isAutomaticContext({ ...automaticContext, ...change }), false);
    assert.throws(() => policy.authorize({ ...automaticContext, ...change }), /Unauthorized/i);
  }
  assert.throws(
    () => policy.authorize({ ...automaticContext, event: "workflow_dispatch", workflowSha: "bad" }),
    /Unauthorized/i
  );
});

test("runtime context carries unmodified workflow identity from trusted environment fields", () => {
  const ctx = runtimeContext({
    GITHUB_REPOSITORY: policy.REPOSITORY,
    GITHUB_ACTOR: policy.OWNER,
    GITHUB_TRIGGERING_ACTOR: policy.OWNER,
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_RUN_ID: "100",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF: workflowRef,
    GITHUB_WORKFLOW_SHA: workflowSha,
  });
  assert.equal(ctx.workflowRef, workflowRef);
  assert.equal(ctx.workflowSha, workflowSha);
  assert.equal(ctx.actor, policy.OWNER);
});

test("automatic reservation and preflight honor the automation kill switch", async () => {
  const c = await setup();
  const disabled = policy.readConfig({ ...automaticVars, FACTORY_AUTOMATION_ENABLED: "false" });
  assert.throws(
    () => policy.reserve(policy.emptyState(policy.REPOSITORY), automaticContext, disabled, now),
    /automatic|automation|disabled/i
  );
  const saved = await c.controller.admit(10);
  const { state } = await c.ledger.read();
  assert.doesNotThrow(() => policy.preflight(state, saved.grantId, automaticContext, c.config));
  assert.throws(
    () => policy.preflight(state, saved.grantId, automaticContext, disabled),
    /automatic|automation|disabled/i
  );
  const changed = { ...automaticContext, workflowSha: "c".repeat(40) };
  assert.throws(
    () => policy.preflight(state, saved.grantId, changed, c.config),
    /automatic|provenance/i
  );
  assert.doesNotThrow(() =>
    policy.reserve(policy.emptyState(policy.REPOSITORY), context, disabled, now)
  );
});

test("automatic admission persists provenance tied to its first coding grant", async () => {
  const c = await setup();
  const saved = await c.controller.admit(10);
  const state = (await new Ledger(c.api).read()).state;
  assert.deepEqual(state.tickets["10"].automatic, {
    workflowRef,
    workflowSha,
    runId: "100",
    runAttempt: 1,
    appSlug,
  });
  assert.equal(state.tickets["10"].coding, 1);
  assert.equal(state.tickets["10"].retries, 0);
  assert.equal(state.grants[saved.grantId].runId, "100");
  assert.doesNotThrow(() => policy.validateState(state));
});

test("automatic admission requires an owner-created ready issue and never restarts an admitted ticket", async () => {
  for (const mutate of [
    (issue) => {
      issue.user.login = "attacker";
    },
    (issue) => {
      issue.labels = [];
    },
    (issue) => {
      issue.labels = [{ name: "Factory-ready" }];
    },
  ]) {
    const c = await setup();
    mutate(c.fixture.issues.get(10));
    const before = (await c.ledger.read()).state;
    await assert.rejects(c.controller.admit(10), /automatic|eligible|ready|owner/i);
    assert.deepEqual((await c.ledger.read()).state, before);
  }
  const c = await setup();
  const saved = await c.controller.admit(10);
  await c.controller.block(10, "Fixture failure");
  const before = (await c.ledger.read()).state;
  await assert.rejects(c.controller.admit(10), /automatic|admitted|existing/i);
  await assert.rejects(c.controller.admit(10, { recover: true }), /automatic|recovery/i);
  assert.deepEqual((await c.ledger.read()).state, before);
  assert.equal(before.grants[saved.grantId].status, "finished");
});

test("disabled automatic admission makes no reservation", async () => {
  const c = await setup({ FACTORY_AUTOMATION_ENABLED: "false" });
  const before = (await c.ledger.read()).state;
  assert.equal((await c.controller.admit(10)).ready, false);
  assert.deepEqual((await c.ledger.read()).state, before);
});

test("automatic provenance rejects malformed or unbound metadata without changing legacy histories", async () => {
  const c = await setup();
  await c.controller.admit(10);
  const original = (await c.ledger.read()).state;
  for (const change of [
    { workflowRef: "foreign" },
    { workflowSha: "bad" },
    { workflowSha: [workflowSha] },
    { runId: "200" },
    { runAttempt: 2 },
    { appSlug: "factory[bot]" },
    { extra: true },
  ]) {
    const state = structuredClone(original);
    state.tickets["10"].automatic = { ...state.tickets["10"].automatic, ...change };
    assert.throws(() => policy.validateState(state), /automatic|provenance/i);
  }
  const legacy = policy.reserve(
    policy.emptyState(policy.REPOSITORY),
    context,
    policy.readConfig(vars),
    now
  );
  assert.doesNotThrow(() => policy.validateState(legacy.state));
});

test("automatic publication refuses the wrong App author without accepting publication proof", async () => {
  const c = await setup();
  const grant = await c.controller.admit(10);
  c.state.publisher = "github-actions[bot]";
  await assert.rejects(c.controller.publish(grant.grantId, bundle(grant)), /App|publisher/i);
  const state = (await c.ledger.read()).state;
  assert.equal(state.tickets["10"].pr, null);
  assert.equal(state.grants[grant.grantId].status, "reserved");
});

test("automatic publication and retry retain App provenance and reject changed existing PR authors", async () => {
  const c = await setup();
  const grant = await c.controller.admit(10);
  const published = await c.controller.publish(grant.grantId, bundle(grant));
  const before = (await c.ledger.read()).state;
  assert.equal(before.tickets["10"].pr, published.pr);
  const nextContext = { ...automaticContext, slot: "cycle2", head: published.head };
  const retry = await c.ledger.update((state) => policy.reserve(state, nextContext, c.config, now));
  assert.deepEqual(retry.state.tickets["10"].automatic, before.tickets["10"].automatic);
  c.controller.context = { ...automaticContext };
  c.state.publisher = "attacker";
  const writesBefore = c.state.calls.filter((call) => call.method !== "GET").length;
  await assert.rejects(
    c.controller.publish(retry.grant.id, bundle({ grantId: retry.grant.id, head: published.head })),
    /App|publisher/i
  );
  assert.equal(c.state.calls.filter((call) => call.method !== "GET").length, writesBefore);
});

test("automatic merge metadata is tied to the recorded publication and canonical audit fields", async () => {
  const c = await setup();
  const grant = await c.controller.admit(10);
  await c.controller.publish(grant.grantId, bundle(grant));
  const state = (await c.ledger.read()).state;
  const t = state.tickets["10"];
  const intent = {
    status: "intent",
    head: t.head,
    pr: t.pr,
    at: now.toISOString(),
    runId: "200",
    runAttempt: 1,
  };
  for (const merge of [
    intent,
    { ...intent, status: "closed" },
    { ...intent, status: "merged", mergeCommit: "d".repeat(40) },
  ])
    assert.doesNotThrow(() => policy.validateState({ ...state, tickets: { 10: { ...t, merge } } }));
  for (const change of [
    { status: "pending" },
    { head: "c".repeat(40) },
    { pr: t.pr + 1 },
    { at: "yesterday" },
    { at: "2026-11-13" },
    { runId: "0" },
    { runId: 200 },
    { runAttempt: 0 },
    { status: "merged" },
    { status: "merged", mergeCommit: ["d".repeat(40)] },
    { mergeCommit: "d".repeat(40) },
    { extra: true },
  ])
    assert.throws(
      () =>
        policy.validateState({
          ...state,
          tickets: { 10: { ...t, merge: { ...intent, ...change } } },
        }),
      /merge/i
    );
  const legacy = policy.reserve(
    policy.emptyState(policy.REPOSITORY),
    context,
    policy.readConfig(vars),
    now
  ).state;
  legacy.tickets["10"].merge = intent;
  assert.throws(() => policy.validateState(legacy), /merge/i);
});

test("simultaneous automatic admissions consume one grant and one daily admission", async () => {
  const c = await setup();
  const results = await Promise.allSettled([c.controller.admit(10), c.controller.admit(10)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const state = (await c.ledger.read()).state;
  assert.equal(state.tickets["10"].coding, 1);
  assert.equal(Object.keys(state.grants).length, 1);
  assert.equal(
    Object.values(state.days)
      .flat()
      .filter((ticket) => ticket === 10).length,
    1
  );
});

test("manual owner recovery preserves the first automatic admission provenance", async () => {
  const c = await setup();
  await c.controller.admit(10);
  await c.controller.block(10, "Synthetic provider interruption");
  const before = (await c.ledger.read()).state;
  const manual = new Controller(c.api, policy.readConfig(vars), { ...context, runId: "101" });
  await manual.admit(10);
  const state = (await c.ledger.read()).state;
  assert.deepEqual(state.tickets["10"].automatic, before.tickets["10"].automatic);
  for (const [id, grant] of Object.entries(before.grants))
    assert.deepEqual(state.grants[id], grant);
  assert.equal(state.tickets["10"].coding, 2);
  assert.equal(state.tickets["10"].retries, 1);
});

test("a pending automatic merge that appears after the snapshot prevents new automatic admission", async () => {
  const c = await setup();
  const first = await c.controller.admit(10);
  await c.controller.publish(first.grantId, bundle(first));
  await c.controller.block(10, "Synthetic CI interruption");
  c.fixture.issues.set(11, {
    ...structuredClone(c.fixture.issues.get(10)),
    number: 11,
    title: "Next repair",
  });
  const request = c.api.request.bind(c.api);
  let recovered = false;
  c.api.request = async (method, path, body) => {
    if (!recovered && method === "GET" && path.endsWith("/git/ref/heads/agent/factory-11")) {
      recovered = true;
      // Automatic admit has read its initial ledger snapshot. Complete an owner
      // recovery before its final reservation mutation using the real controller.
      const owner = new Controller(
        c.api,
        c.config,
        { ...context, runId: "101" },
        {
          sleep: async () => {},
          maxPolls: 2,
        }
      );
      const code = await owner.admit(10);
      const published = await owner.publish(code.grantId, bundle(code));
      const ci = await owner.ci(10);
      const review = await owner.reserveReview(10, ci.runId, "cycle1");
      await owner.assess(
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
            summary: "Fixture review",
            findings: [],
          },
        },
        "cycle1"
      );
    }
    return request(method, path, body);
  };
  await assert.rejects(c.controller.admit(11), /Pending automatic merge must be reconciled/);
  const state = (await c.ledger.read()).state;
  assert.equal(recovered, true);
  assert.equal(state.tickets["10"].status, "reviewed");
  assert.equal(state.tickets["10"].merge, undefined);
  assert.equal(state.tickets["11"], undefined);
  assert.equal(state.active, null);
  assert.equal(Object.keys(state.grants).length, 3);
  const owner = new Controller(c.api, c.config, { ...context, runId: "102" });
  assert.equal((await owner.admit(11)).ready, true, "manual owner admission remains unchanged");
});
