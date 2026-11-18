const test = require("node:test"),
  assert = require("node:assert/strict");
const p = require("../factory/policy.cjs"),
  c = require("../factory/discovery-contract.cjs");
const retry = require("../factory/finding-retry.cjs"),
  repair = require("../factory/discovery-repair.cjs");
const first = require("./fixtures/finding96-blocked.cjs"),
  second = require("./fixtures/finding96-context-block.json"),
  third = require("./fixtures/finding96-output-block.json");
const { vars, context } = require("./helpers/factory-fixtures.cjs");
const head = "c".repeat(40),
  ctx = {
    ...context,
    ticket: 96,
    runId: "1500",
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
    FACTORY_GITHUB_APP_SLUG: first.ticket.automatic.appSlug,
    ...changes,
  });
function state() {
  const s = p.emptyState(p.REPOSITORY);
  s.tickets["96"] = {
    ...structuredClone(first.ticket),
    coding: 3,
    retries: 2,
    head: third.grant.head,
    findingRetry: structuredClone(second.retry),
    findingContinuation: structuredClone(third.continuation),
  };
  for (const g of [first.grant, second.grant, third.grant]) s.grants[g.id] = structuredClone(g);
  s.days["2026-11-18"] = [96];
  return p.validateState(s);
}
const proof = () => ({
  version: 1,
  priorGrant: third.grant.id,
  runId: ctx.runId,
  runAttempt: 1,
  workflowSha: head,
  head,
  ciRunId: "1501",
  actor: p.OWNER,
  decision: "https://github.com/haideearus/cypress-realworld-app/issues/103",
});
const request = () => ({ ...ctx, findingOutputRecovery: proof() });

test("output recovery retains three failed grants and both receipts while charging coding4/retry3", () => {
  const before = state(),
    r = p.reserve(before, request(), config());
  p.validateState(r.state);
  assert.equal(r.state.tickets["96"].coding, 4);
  assert.equal(r.state.tickets["96"].retries, 3);
  for (const [id, g] of Object.entries(before.grants)) assert.deepEqual(r.state.grants[id], g);
  for (const field of ["finding", "automatic", "findingRetry", "findingContinuation"])
    assert.deepEqual(r.state.tickets["96"][field], before.tickets["96"][field]);
  assert.deepEqual(r.state.days, before.days);
  assert.equal(repair.repairBaseline(r.state.tickets["96"]), head);
  assert.equal(p.preflight(r.state, r.grant.id, ctx, config()).id, r.grant.id);
  assert.throws(
    () =>
      p.preflight(
        r.state,
        r.grant.id,
        { ...ctx, runId: third.grant.runId, workflowSha: third.grant.head },
        config()
      ),
    /provenance/i
  );
  assert.throws(() => p.reserve(r.state, request(), config()), /recovery|active|reserved/i);
});

test("recovery identity, historical immutability, ordinary caps and enablement fail closed", () => {
  for (const change of [
    { ticket: 97 },
    { actor: "foreign" },
    { triggeringActor: "foreign" },
    { event: "schedule" },
    { runAttempt: 2 },
    { runId: third.grant.runId },
    { phase: "review" },
    { findingContinuation: third.continuation },
    { findingRetry: second.retry },
    { recovery: {} },
    { findingOutputRecovery: { ...proof(), priorGrant: second.grant.id } },
    { findingOutputRecovery: { ...proof(), head: "a".repeat(40) } },
  ])
    assert.throws(() => p.reserve(state(), { ...request(), ...change }, config()));
  for (const change of [
    { FACTORY_ENABLED: "false" },
    { FACTORY_AUTOMATION_ENABLED: "false" },
    { FACTORY_AUTOMERGE_ENABLED: "true" },
    { FACTORY_DISCOVERY_ENABLED: "true" },
    { FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET: "3" },
    { FACTORY_MAX_AUTOMATIC_RETRIES: "2" },
  ])
    assert.throws(() => p.reserve(state(), request(), config(change)));
  for (const mutate of [
    (s) => (s.grants[third.grant.id].outcome = "reviewed"),
    (s) => (s.tickets["96"].findingContinuation.ciRunId = "9"),
    (s) => (s.tickets["96"].findingRetry.ciRunId = "9"),
    (s) => (s.tickets["96"].pr = 999),
    (s) => (s.tickets["96"].branch = "existing"),
    (s) => (s.tickets["96"].findingRedHash = "a".repeat(64)),
  ]) {
    const s = state();
    mutate(s);
    assert.throws(() => p.reserve(s, request(), config()));
  }
});

function setup(changes = {}) {
  let current = state();
  const calls = [];
  const issue = {
    ...require("../factory/discovery-finding-contract.cjs").issueText(first.record),
    number: 96,
    state: "open",
    labels: [{ name: "factory-ready" }],
  };
  const parent = {
    id: Number(third.grant.runId),
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
    head_sha: third.grant.head,
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
        ...[
          "Prove finding RED without model credentials",
          "Verify the durable reservation and prepare the isolated role",
          "Reject secrets in prepared context before the model sees it",
          "Run the one reserved Claude subscription session",
          "Validate and collect only the role output",
          "Prove finding GREEN without model credentials",
        ].map((name) => ({ name, conclusion: "success" })),
        { name: "Reject secret-bearing role output before upload", conclusion: "failure" },
      ],
    },
  ];
  const api = {
    async request(m, u) {
      calls.push({ m, u });
      assert.equal(m, "GET");
      if (u.endsWith("/issues/96")) return structuredClone(issue);
      if (u.endsWith("/branches/main")) return { commit: { sha: head } };
      if (u.endsWith("/actions/runs/" + third.grant.runId)) return structuredClone(parent);
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
      if (u.includes(third.grant.runId + "/attempts/1/jobs")) return structuredClone(jobs);
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
    testedMain: async () => ({ head, ciRunId: "1501" }),
  };
  return {
    api,
    calls,
    jobs,
    parent,
    issue,
    get current() {
      return structuredClone(current);
    },
    run(options = {}) {
      return retry.retryFinding(
        api,
        config(changes),
        ctx,
        { ticket: 96, dryRun: false, outputRecovery: true, ...options },
        deps
      );
    },
  };
}

test("four-false recovery preview has zero writes and no queue or #97 reads; explicit in-memory admission consumes one slot", async () => {
  const x = setup({ FACTORY_ENABLED: "false", FACTORY_AUTOMATION_ENABLED: "false" }),
    before = x.current;
  const r = await x.run({ dryRun: true });
  assert.equal(r.outcome, "finding-output-recovery-preview");
  assert.equal(r.outputRecoveryEligible, true);
  assert.equal(r.ready, false);
  assert.equal(r.modelCalls, 0);
  assert.deepEqual(x.current, before);
  assert.equal(
    x.calls.some((c) => /\/issues(?:\?|$)|\/issues\/97/.test(c.u)),
    false
  );
  const y = setup(),
    admitted = await y.run();
  assert.equal(admitted.ready, true);
  assert.equal(y.current.tickets["96"].coding, 4);
  await assert.rejects(y.run());
  await assert.rejects(setup().run({ continuation: true }));
});

test("failure evidence, duplicate or extra models, edited ticket, stale main and active workflow cannot reserve", async () => {
  for (const mutate of [
    ...[0, 1, 2, 3, 4, 5].map((i) => (x) => (x.jobs[0].steps[i].conclusion = "skipped")),
    (x) => (x.jobs[0].steps[6].conclusion = "success"),
    (x) => x.jobs[0].steps.push({ ...x.jobs[0].steps[6] }),
    (x) =>
      x.jobs.push({
        name: "other model",
        status: "completed",
        conclusion: "success",
        steps: [
          { name: "Run the one reserved Claude subscription session", conclusion: "success" },
        ],
      }),
    (x) => (x.parent.run_attempt = 2),
    (x) => (x.parent.status = "in_progress"),
    (x) => (x.issue.body += "edited"),
  ]) {
    const x = setup(),
      before = x.current;
    mutate(x);
    await assert.rejects(x.run());
    assert.deepEqual(x.current, before);
  }
  for (const changed of ["main", "workflow", "branch"]) {
    const x = setup(),
      get = x.api.request;
    x.api.request = async (m, u) =>
      changed === "main" && u.endsWith("/branches/main")
        ? { commit: { sha: "a".repeat(40) } }
        : changed === "workflow" && u.includes("/actions/workflows/")
          ? { state: "active" }
          : changed === "branch" && u.endsWith("/git/ref/heads/agent/factory-96")
            ? { object: { sha: head } }
            : get(m, u);
    await assert.rejects(x.run());
  }
});

test("recovery preview dispatch is activity-write-free", async (t) => {
  let writes = 0;
  t.mock.method(require("../factory/trusted-wake.cjs"), "loadWakeContext", async () => ctx);
  t.mock.method(retry, "retryFinding", async (_a, _b, _c, inputs) => {
    assert.equal(inputs.outputRecovery, true);
    return { ready: false, outcome: "finding-output-recovery-preview", ticket: 96, modelCalls: 0 };
  });
  t.mock.method(require("../factory/activity.cjs"), "recordResult", async () => {
    writes++;
  });
  await require("../factory/automation.cjs").main({
    GH_TOKEN: "fixture-only",
    FACTORY_OPERATION: "auto_pick",
    FACTORY_VARIABLES: JSON.stringify({ ...vars, FACTORY_ENABLED: "false" }),
    FACTORY_INPUTS: JSON.stringify({ operation: "recover-finding", ticket: "96", dry_run: true }),
  });
  assert.equal(writes, 0);
});

test("recovery preserves #97, stop protection and complete history across publication, review and final ordinary cycle", () => {
  const s = state(),
    other = p.reserve(
      p.emptyState(p.REPOSITORY),
      { ...context, ticket: 97, runId: "700" },
      config()
    );
  const done = p.finish(other.state, other.grant.id, { status: "blocked" });
  s.tickets["97"] = done.tickets["97"];
  s.grants[other.grant.id] = done.grants[other.grant.id];
  s.days["2026-11-18"].push(97);
  const r = p.reserve(s, request(), config());
  assert.deepEqual(r.state.tickets["97"], s.tickets["97"]);
  assert.deepEqual(r.state.grants[other.grant.id], s.grants[other.grant.id]);
  assert.equal(p.reviewGate(r.state, { number: 1000, head }).ok, false);
  for (const mutate of [
    (x) => (x.tickets["96"].findingOutputRecovery.runId = "5000"),
    (x) => (x.tickets["97"].findingOutputRecovery = proof()),
    (x) => delete x.tickets["96"].findingContinuation,
    (x) => (x.grants[third.grant.id].outcome = "reviewed"),
  ]) {
    const bad = structuredClone(r.state);
    mutate(bad);
    assert.throws(() => p.validateState(bad));
  }
  const published = "d".repeat(40);
  const awaiting = p.finish(r.state, r.grant.id, {
    status: "awaiting_review",
    head: published,
    pr: 1000,
  });
  const review = p.reserve(awaiting, { ...ctx, head: published, phase: "review" }, config());
  const requested = p.finish(review.state, review.grant.id, {
    status: "retry",
    head: published,
    pr: 1000,
  });
  const final = p.reserve(requested, { ...ctx, head: published, slot: "cycle2" }, config());
  assert.equal(final.state.tickets["96"].coding, 5);
  assert.equal(final.state.tickets["96"].retries, 4);
  p.validateState(final.state);
  const exhausted = p.finish(final.state, final.grant.id, {
    status: "retry",
    head: published,
    pr: 1000,
  });
  assert.throws(
    () => p.reserve(exhausted, { ...ctx, head: published, slot: "cycle3" }, config()),
    /limit/i
  );
  const stop = state();
  stop.stop = {
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
  assert.throws(() => p.reserve(stop, request(), config()), /stopped/);
});
