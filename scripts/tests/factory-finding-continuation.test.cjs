const test = require("node:test"),
  assert = require("node:assert/strict");
const p = require("../factory/policy.cjs"),
  c = require("../factory/discovery-contract.cjs");
const retry = require("../factory/finding-retry.cjs"),
  repair = require("../factory/discovery-repair.cjs");
const original = require("./fixtures/finding96-blocked.cjs"),
  blocked = require("./fixtures/finding96-context-block.json");
const { vars, context } = require("./helpers/factory-fixtures.cjs");
const head = "c".repeat(40),
  ctx = {
    ...context,
    ticket: 96,
    runId: "1100",
    head,
    workflowSha: head,
    workflowRef: p.AUTOMATIC_WORKFLOW_REF,
  };
const config = (changes) =>
  p.readConfig({
    ...vars,
    FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET: "5",
    FACTORY_MAX_AUTOMATIC_RETRIES: "4",
    FACTORY_AUTOMATION_ENABLED: "true",
    FACTORY_AUTOMERGE_ENABLED: "false",
    FACTORY_DISCOVERY_ENABLED: "false",
    FACTORY_GITHUB_APP_CLIENT_ID: "Iv1.fixture123456",
    FACTORY_GITHUB_APP_SLUG: original.ticket.automatic.appSlug,
    ...changes,
  });
function state() {
  const s = p.emptyState(p.REPOSITORY);
  s.tickets["96"] = {
    ...structuredClone(original.ticket),
    coding: 2,
    retries: 1,
    head: blocked.grant.head,
    findingRetry: structuredClone(blocked.retry),
  };
  s.grants[original.grant.id] = structuredClone(original.grant);
  s.grants[blocked.grant.id] = structuredClone(blocked.grant);
  s.days["2026-11-18"] = [96];
  return p.validateState(s);
}
const proof = () => ({
  version: 1,
  priorGrant: blocked.grant.id,
  runId: ctx.runId,
  runAttempt: 1,
  workflowSha: head,
  head,
  ciRunId: "1101",
  actor: p.OWNER,
  decision: "https://github.com/haideearus/cypress-realworld-app/issues/100",
});

test("continuation retains both grants and first receipt, consuming coding3/retry2 with its own parent and baseline", () => {
  const before = state(),
    result = p.reserve(before, { ...ctx, findingContinuation: proof() }, config());
  p.validateState(result.state);
  assert.equal(result.state.tickets["96"].coding, 3);
  assert.equal(result.state.tickets["96"].retries, 2);
  for (const id of [original.grant.id, blocked.grant.id])
    assert.deepEqual(result.state.grants[id], before.grants[id]);
  for (const field of ["finding", "automatic", "findingRetry"])
    assert.deepEqual(result.state.tickets["96"][field], before.tickets["96"][field]);
  assert.deepEqual(result.state.days, before.days);
  assert.equal(p.preflight(result.state, result.grant.id, ctx, config()).id, result.grant.id);
  assert.equal(repair.repairBaseline(result.state.tickets["96"]), head);
  assert.throws(
    () =>
      p.preflight(
        result.state,
        result.grant.id,
        { ...ctx, runId: blocked.grant.runId, workflowSha: blocked.grant.head },
        config()
      ),
    /provenance/
  );
  assert.throws(
    () => p.reserve(result.state, { ...ctx, findingContinuation: proof() }, config()),
    /continuation|active|reserved/i
  );
});

test("wrong ticket, parent, actor, mixed receipts, schedule and ordinary caps refuse continuation", () => {
  for (const change of [
    { ticket: 97 },
    { actor: "foreign" },
    { triggeringActor: "foreign" },
    { event: "schedule" },
    { runAttempt: 2 },
    { runId: blocked.grant.runId },
    { phase: "review" },
    { findingRetry: blocked.retry },
    { findingContinuation: { ...proof(), priorGrant: original.grant.id } },
    { findingContinuation: { ...proof(), head: "d".repeat(40) } },
  ])
    assert.throws(
      () => p.reserve(state(), { ...ctx, findingContinuation: proof(), ...change }, config()),
      /continuation|Invalid|Unauthorized/i
    );
  for (const change of [
    { FACTORY_ENABLED: "false" },
    { FACTORY_AUTOMATION_ENABLED: "false" },
    { FACTORY_AUTOMERGE_ENABLED: "true" },
    { FACTORY_DISCOVERY_ENABLED: "true" },
    { FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET: "2" },
    { FACTORY_MAX_AUTOMATIC_RETRIES: "1" },
  ])
    assert.throws(
      () => p.reserve(state(), { ...ctx, findingContinuation: proof() }, config(change)),
      /continuation|disabled|limit/i
    );
  const changed = state();
  changed.tickets["96"].findingRetry.ciRunId = "2";
  assert.throws(
    () => p.reserve(changed, { ...ctx, findingContinuation: proof() }, config()),
    /continuation/i
  );
});

function setup(changes = {}) {
  let current = state();
  const calls = [];
  const text = require("../factory/discovery-finding-contract.cjs").issueText(original.record);
  const issue = {
    ...text,
    number: 96,
    state: "open",
    user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    labels: [{ name: "factory-ready" }],
  };
  const parent = {
    id: Number(blocked.grant.runId),
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
    head_sha: blocked.grant.head,
    head_branch: "main",
    path: ".github/workflows/factory-automatic.yml",
    event: "workflow_dispatch",
    repository: { full_name: p.REPOSITORY },
    head_repository: { full_name: p.REPOSITORY },
    actor: { login: p.OWNER, id: 101267861 },
    triggering_actor: { login: p.OWNER, id: 101267861 },
  };
  const jobs = [
    {
      name: "cycle1 / coding / agent",
      status: "completed",
      conclusion: "failure",
      steps: [
        { name: "Prove finding RED without model credentials", conclusion: "success" },
        {
          name: "Verify the durable reservation and prepare the isolated role",
          conclusion: "success",
        },
        {
          name: "Reject secrets in prepared context before the model sees it",
          conclusion: "failure",
        },
        { name: "Run the one reserved Claude subscription session", conclusion: "skipped" },
      ],
    },
  ];
  const api = {
    async request(m, u) {
      calls.push({ m, u });
      assert.equal(m, "GET");
      if (u.endsWith("/issues/96")) return structuredClone(issue);
      if (u.endsWith("/branches/main")) return { commit: { sha: head } };
      if (u.endsWith("/actions/runs/" + blocked.grant.runId)) return structuredClone(parent);
      if (u.includes("/actions/workflows/")) return { state: "disabled_manually" };
      if (u.endsWith("/git/ref/heads/agent/factory-96")) {
        const e = Error("missing");
        e.status = 404;
        throw e;
      }
      throw Error("Unexpected route " + u);
    },
    async pages(u) {
      calls.push({ m: "GET", u });
      if (u.includes(blocked.grant.runId + "/attempts/1/jobs")) return structuredClone(jobs);
      throw Error("Unexpected pages " + u);
    },
  };
  const deps = {
    ledger: {
      async read() {
        return { state: structuredClone(current) };
      },
      async update(fn) {
        const r = await fn(structuredClone(current));
        p.validateState(r.state);
        current = structuredClone(r.state);
        return r;
      },
    },
    verifyOrigin: async () => true,
    testedMain: async () => ({ head, ciRunId: "1101" }),
  };
  return {
    api,
    deps,
    jobs,
    parent,
    issue,
    calls,
    get current() {
      return structuredClone(current);
    },
    run(options = {}) {
      return retry.retryFinding(
        api,
        config(changes),
        ctx,
        { ticket: 96, dryRun: false, continuation: true, ...options },
        deps
      );
    },
  };
}

test("continuation preview is read-only with four switches off; explicit run grants only #96", async () => {
  const x = setup({ FACTORY_ENABLED: "false", FACTORY_AUTOMATION_ENABLED: "false" }),
    before = x.current;
  const result = await x.run({ dryRun: true });
  assert.equal(result.outcome, "finding-continuation-preview");
  assert.equal(result.continuationEligible, true);
  assert.equal(result.ready, false);
  assert.equal(result.modelCalls, 0);
  assert.deepEqual(x.current, before);
  assert.equal(
    x.calls.some((c) => /\/issues(?:\?|$)|\/issues\/97/.test(c.u)),
    false
  );
  const live = setup(),
    r = await live.run();
  assert.equal(r.ready, true);
  assert.equal(live.current.tickets["96"].coding, 3);
  await assert.rejects(live.run(), /continuation/i);
});

test("bad skipped-model/RED/scan proof and stale or unpaused state never reserve continuation", async () => {
  for (const mutate of [
    (x) => (x.jobs[0].steps[0].conclusion = "failure"),
    (x) => (x.jobs[0].steps[1].conclusion = "skipped"),
    (x) => (x.jobs[0].steps[2].conclusion = "success"),
    (x) => (x.jobs[0].steps[3].conclusion = "success"),
    (x) => x.jobs[0].steps.push({ ...x.jobs[0].steps[2] }),
    (x) => (x.parent.run_attempt = 2),
    (x) => (x.parent.status = "in_progress"),
    (x) => (x.issue.body += "changed"),
  ]) {
    const x = setup(),
      before = x.current;
    mutate(x);
    await assert.rejects(x.run());
    assert.deepEqual(x.current, before);
  }
  const x = setup(),
    read = x.api.request;
  x.api.request = async (m, u) =>
    u.endsWith("/branches/main") ? { commit: { sha: "d".repeat(40) } } : read(m, u);
  await assert.rejects(x.run(), /main|changed/i);
  const y = setup(),
    get = y.api.request;
  y.api.request = async (m, u) =>
    u.includes("/actions/workflows/") ? { state: "active" } : get(m, u);
  await assert.rejects(y.run(), /paused/);
});

test("continuation dispatch preview cannot write activity metadata", async (t) => {
  let writes = 0;
  t.mock.method(require("../factory/trusted-wake.cjs"), "loadWakeContext", async () => ctx);
  t.mock.method(retry, "retryFinding", async (_api, _cfg, _ctx, inputs) => {
    assert.equal(inputs.continuation, true);
    return { ready: false, outcome: "finding-continuation-preview", ticket: 96, modelCalls: 0 };
  });
  t.mock.method(require("../factory/activity.cjs"), "recordResult", async () => {
    writes++;
  });
  await require("../factory/automation.cjs").main({
    GH_TOKEN: "fixture-only",
    FACTORY_OPERATION: "auto_pick",
    FACTORY_VARIABLES: JSON.stringify({ ...vars, FACTORY_ENABLED: "false" }),
    FACTORY_INPUTS: JSON.stringify({ operation: "continue-finding", ticket: "96", dry_run: true }),
  });
  assert.equal(writes, 0);
});

test("continuation honors durable stop and preserves another ticket, old receipts and review gate", () => {
  const stopped = state();
  stopped.stop = {
    id: "11111111-1111-4111-8111-111111111111",
    actor: p.OWNER,
    at: "2026-11-18T17:00:00.000Z",
    reason: "Owner emergency stop",
    previous: {
      FACTORY_ENABLED: "true",
      FACTORY_AUTOMATION_ENABLED: "true",
      FACTORY_AUTOMERGE_ENABLED: "false",
    },
  };
  assert.throws(
    () => p.reserve(stopped, { ...ctx, findingContinuation: proof() }, config()),
    /stopped/
  );
  const busy = state();
  busy.active = { ticket: 96, runId: blocked.grant.runId, runAttempt: 1 };
  assert.throws(
    () => p.reserve(busy, { ...ctx, findingContinuation: proof() }, config()),
    /continuation/
  );
  const before = state(),
    other = p.reserve(
      p.emptyState(p.REPOSITORY),
      { ...context, ticket: 97, runId: "700" },
      config()
    );
  const done = p.finish(other.state, other.grant.id, { status: "blocked" });
  before.tickets["97"] = done.tickets["97"];
  before.grants[other.grant.id] = done.grants[other.grant.id];
  before.days["2026-11-18"].push(97);
  const result = p.reserve(before, { ...ctx, findingContinuation: proof() }, config());
  assert.deepEqual(result.state.tickets["97"], before.tickets["97"]);
  assert.deepEqual(result.state.grants[other.grant.id], before.grants[other.grant.id]);
  assert.equal(p.reviewGate(result.state, { number: 1000, head }).ok, false);
  for (const mutate of [
    (s) => (s.tickets["96"].findingRetry.head = "d".repeat(40)),
    (s) => (s.grants[blocked.grant.id].outcome = "reviewed"),
    (s) => (s.tickets["96"].findingContinuation.runId = "2000"),
    (s) => (s.tickets["97"].findingContinuation = proof()),
    (s) => delete s.tickets["96"].findingRetry,
  ]) {
    const changed = structuredClone(result.state);
    mutate(changed);
    assert.throws(() => p.validateState(changed));
  }
});
