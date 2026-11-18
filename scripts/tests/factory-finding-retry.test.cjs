const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../factory/policy.cjs");
const { ROOT } = require("../factory/github.cjs");
const { vars, context } = require("./helpers/factory-fixtures.cjs");
const original = require("./fixtures/finding96-blocked.cjs");
let retry = {};
try {
  retry = require("../factory/finding-retry.cjs");
} catch (e) {
  if (e.code !== "MODULE_NOT_FOUND") throw e;
}
const head = "b".repeat(40);
const ctx = {
  ...context,
  ticket: 96,
  workflowRef: p.AUTOMATIC_WORKFLOW_REF,
  workflowSha: head,
  head,
  runId: "900",
  runAttempt: 1,
};
const config = (changes) =>
  p.readConfig({
    ...vars,
    FACTORY_AUTOMATION_ENABLED: "true",
    FACTORY_AUTOMERGE_ENABLED: "false",
    FACTORY_DISCOVERY_ENABLED: "false",
    FACTORY_GITHUB_APP_CLIENT_ID: "Iv1.fixture123456",
    FACTORY_GITHUB_APP_SLUG: original.ticket.automatic.appSlug,
    ...changes,
  });
function state() {
  const s = p.emptyState(p.REPOSITORY);
  s.tickets["96"] = structuredClone(original.ticket);
  s.grants[original.grant.id] = structuredClone(original.grant);
  s.days["2026-11-18"] = [96];
  return p.validateState(s);
}
function proof() {
  return {
    version: 1,
    priorGrant: original.grant.id,
    runId: ctx.runId,
    runAttempt: 1,
    workflowSha: head,
    head,
    ciRunId: "901",
    actor: p.OWNER,
    decision: "https://github.com/haideearus/cypress-realworld-app/issues/98",
  };
}

test("one explicit retry retains the old grant, origin, day and limits, charging coding=2 and retries=1", () => {
  const before = state(),
    saved = structuredClone(before);
  const result = p.reserve(before, { ...ctx, findingRetry: proof() }, config());
  assert.equal(result.state.tickets["96"].coding, 2);
  assert.equal(result.state.tickets["96"].retries, 1);
  assert.deepEqual(before, saved);
  assert.deepEqual(result.state.grants[original.grant.id], saved.grants[original.grant.id]);
  assert.deepEqual(result.state.days, saved.days);
  assert.deepEqual(result.state.tickets["96"].automatic, saved.tickets["96"].automatic);
  assert.deepEqual(result.state.tickets["96"].finding, saved.tickets["96"].finding);
  p.validateState(result.state);
  assert.equal(p.preflight(result.state, result.grant.id, ctx, config()).id, result.grant.id);
  assert.throws(
    () =>
      p.preflight(result.state, result.grant.id, { ...ctx, runId: original.grant.runId }, config()),
    /provenance/i
  );
  assert.throws(
    () => p.reserve(result.state, { ...ctx, findingRetry: proof() }, config()),
    /retry|active|reservation/i
  );
});

test("retry cannot bypass wrong ticket, owner, schedule, source grant, stop or usage caps", () => {
  for (const change of [
    { ticket: 97 },
    { actor: "stranger" },
    { triggeringActor: "stranger" },
    { event: "schedule" },
    { runAttempt: 2 },
    { runId: original.grant.runId },
    { phase: "review" },
    { findingRetry: { ...proof(), priorGrant: "11111111-1111-4111-8111-111111111111" } },
    { findingRetry: { ...proof(), head: "c".repeat(40) } },
  ])
    assert.throws(
      () => p.reserve(state(), { ...ctx, findingRetry: proof(), ...change }, config()),
      /retry|Unauthorized|Invalid/i
    );
  for (const changes of [
    { FACTORY_ENABLED: "false" },
    { FACTORY_AUTOMATION_ENABLED: "false" },
    { FACTORY_DISCOVERY_ENABLED: "true" },
    { FACTORY_AUTOMERGE_ENABLED: "true" },
    { FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET: "1" },
    { FACTORY_MAX_AUTOMATIC_RETRIES: "0" },
  ])
    assert.throws(
      () => p.reserve(state(), { ...ctx, findingRetry: proof() }, config(changes)),
      /retry|disabled|limit/i
    );
  const changed = state();
  changed.grants[original.grant.id].at = "2026-11-17T00:00:00.000Z";
  assert.throws(() => p.reserve(changed, { ...ctx, findingRetry: proof() }, config()), /retry/i);
});

function setup(changes = {}) {
  let current = state();
  const registry = structuredClone(original.record),
    calls = [];
  const issue = {
    number: 96,
    title: registry.publication.title,
    body: registry.publication.body,
    state: "open",
    user: { login: "github-actions[bot]", type: "Bot", id: 41898282 },
    labels: [{ name: "factory-ready" }],
  };
  const text = require("../factory/discovery-finding-contract.cjs").issueText(registry);
  Object.assign(issue, text);
  const jobs = [
    {
      name: "cycle1 / coding / agent",
      status: "completed",
      conclusion: "failure",
      steps: [
        {
          name: "Run actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
          conclusion: "failure",
        },
        { name: "Run the one reserved Claude subscription session", conclusion: "skipped" },
        { name: "Prove finding RED without model credentials", conclusion: "skipped" },
      ],
    },
  ];
  const prior = {
    id: Number(original.grant.runId),
    path: ".github/workflows/factory-automatic.yml",
    run_attempt: 1,
    head_sha: original.grant.head,
    head_branch: "main",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "failure",
    repository: { full_name: p.REPOSITORY },
    head_repository: { full_name: p.REPOSITORY },
    actor: { login: p.OWNER, id: 101267861 },
    triggering_actor: { login: p.OWNER, id: 101267861 },
  };
  const api = {
    async request(method, url) {
      calls.push({ method, url });
      assert.equal(method, "GET");
      if (url === ROOT + "/issues/96") return structuredClone(issue);
      if (url === ROOT + "/branches/main") return { commit: { sha: head } };
      if (url === ROOT + "/actions/runs/" + original.grant.runId) return structuredClone(prior);
      if (url.includes("/actions/workflows/")) return { state: "disabled_manually" };
      if (url.includes("/git/ref/heads/agent/factory-96")) {
        const e = Error("missing");
        e.status = 404;
        throw e;
      }
      throw Error("Unexpected route " + url);
    },
    async pages(url) {
      calls.push({ method: "GET", url });
      if (url.includes(original.grant.runId + "/attempts/1/jobs")) return structuredClone(jobs);
      throw Error("Unexpected pages " + url);
    },
  };
  const ledger = {
    async read() {
      return { state: structuredClone(current) };
    },
    async update(fn) {
      const result = await fn(structuredClone(current));
      p.validateState(result.state);
      current = structuredClone(result.state);
      return result;
    },
  };
  const deps = {
    ledger,
    async verifyOrigin(_api, _issue, finding) {
      return finding.origin.issue === 96;
    },
    async testedMain() {
      return { head, ciRunId: "901" };
    },
  };
  return {
    api,
    ledger,
    deps,
    calls,
    issue,
    jobs,
    prior,
    get current() {
      return structuredClone(current);
    },
    async run(options = {}) {
      return retry.retryFinding(
        api,
        config(changes),
        ctx,
        { ticket: 96, dryRun: false, ...options },
        deps
      );
    },
  };
}

test("preview while disabled is read-only, selects #96 directly and never asks for #97 or the queue", async () => {
  const x = setup({ FACTORY_ENABLED: "false", FACTORY_AUTOMATION_ENABLED: "false" }),
    before = x.current;
  const r = await x.run({ dryRun: true });
  assert.equal(r.outcome, "finding-retry-preview");
  assert.equal(r.ticket, 96);
  assert.equal(r.modelCalls, 0);
  assert.equal(r.ready, false);
  assert.equal(r.retryEligible, true);
  assert.deepEqual(x.current, before);
  assert.equal(
    x.calls.some((c) => /\/issues(?:\?|$)|\/issues\/97/.test(c.url)),
    false
  );
});

test("live explicit reservation uses its tested main, does not rewrite finding registry or other tickets", async () => {
  const x = setup(),
    r = await x.run();
  assert.equal(r.ticket, 96);
  assert.equal(r.ready, true);
  assert.equal(r.head, head);
  assert.equal(x.current.tickets["96"].findingRetry.priorGrant, original.grant.id);
  assert.equal(x.current.tickets["96"].coding, 2);
  assert.equal(
    x.calls.every((c) => c.method === "GET"),
    true
  );
  await assert.rejects(x.run(), /retry|reservation|blocked/i);
});

test("wrong ticket, attempted model, ambiguous download failure and changed parent fail without a new grant", async () => {
  for (const mutate of [
    (x) => (x.jobs[0].steps[1].conclusion = "success"),
    (x) => (x.jobs[0].steps[0].conclusion = "success"),
    (x) => x.jobs[0].steps.push({ ...x.jobs[0].steps[0] }),
    (x) => (x.prior.status = "in_progress"),
    (x) => (x.prior.run_attempt = 2),
    (x) => (x.issue.body += "changed"),
  ]) {
    const x = setup(),
      before = x.current;
    mutate(x);
    await assert.rejects(x.run());
    assert.deepEqual(x.current, before);
  }
  const x = setup();
  await assert.rejects(x.run({ ticket: 97 }));
  assert.equal(x.calls.length, 0);
});

test("a raced main or unpaused pickup is refused before writing a reservation", async () => {
  const x = setup(),
    before = x.current;
  const get = x.api.request;
  let branches = 0;
  x.api.request = async (m, u) =>
    u.endsWith("/branches/main") && ++branches > 0
      ? { commit: { sha: "c".repeat(40) } }
      : get(m, u);
  await assert.rejects(x.run(), /main|head|changed/i);
  assert.deepEqual(x.current, before);
  const y = setup(),
    getY = y.api.request;
  y.api.request = async (m, u) =>
    u.includes("/actions/workflows/") ? { state: "active" } : getY(m, u);
  await assert.rejects(y.run(), /paused|disabled/i);
});

test("durable stop, active work and changed discovery provenance cannot reserve the retry", async () => {
  const stopped = state();
  stopped.stop = {
    id: "11111111-1111-4111-8111-111111111111",
    actor: p.OWNER,
    at: "2026-11-18T15:00:00.000Z",
    reason: "Owner emergency stop",
    previous: {
      FACTORY_ENABLED: "true",
      FACTORY_AUTOMATION_ENABLED: "true",
      FACTORY_AUTOMERGE_ENABLED: "false",
    },
  };
  assert.throws(() => p.reserve(stopped, { ...ctx, findingRetry: proof() }, config()), /stopped/i);
  const busy = state();
  busy.active = { ticket: 96, runId: original.grant.runId, runAttempt: 1 };
  assert.throws(() => p.reserve(busy, { ...ctx, findingRetry: proof() }, config()), /retry/i);
  const forged = state();
  forged.tickets["96"].finding.origin.candidateHash = "e".repeat(64);
  assert.throws(() => p.reserve(forged, { ...ctx, findingRetry: proof() }, config()), /retry/i);
  const x = setup(),
    before = x.current;
  x.deps.verifyOrigin = async () => false;
  await assert.rejects(x.run(), /retry/i);
  assert.deepEqual(x.current, before);
});

test("retry preserves another ticket and rejects tampered retry markers on later worker preflight", () => {
  const before = state();
  const other = p.reserve(
    p.emptyState(p.REPOSITORY),
    { ...context, ticket: 97, runId: "700" },
    config()
  );
  const finished = p.finish(other.state, other.grant.id, { status: "blocked" });
  before.tickets["97"] = finished.tickets["97"];
  before.grants[other.grant.id] = finished.grants[other.grant.id];
  before.days["2026-11-18"].push(97);
  const result = p.reserve(before, { ...ctx, findingRetry: proof() }, config());
  assert.deepEqual(result.state.tickets["97"], before.tickets["97"]);
  assert.deepEqual(result.state.grants[other.grant.id], before.grants[other.grant.id]);
  for (const mutate of [
    (s) => (s.tickets["96"].findingRetry.head = "c".repeat(40)),
    (s) => (s.tickets["96"].findingRetry.runId = "999"),
    (s) => (s.tickets["97"].findingRetry = proof()),
    (s) => (s.grants[original.grant.id].outcome = "reviewed"),
    (s) => (s.tickets["96"].automatic.workflowSha = "d".repeat(40)),
  ]) {
    const changed = structuredClone(result.state);
    mutate(changed);
    assert.throws(() => p.validateState(changed), /retry/i);
  }
});

test("the workflow entry keeps retry preview free of activity-store writes", async (t) => {
  const activity = require("../factory/activity.cjs");
  const wake = require("../factory/trusted-wake.cjs");
  let writes = 0;
  t.mock.method(wake, "loadWakeContext", async () => ctx);
  t.mock.method(retry, "retryFinding", async (_api, _config, _ctx, inputs) => {
    assert.deepEqual(inputs, { ticket: 96, dryRun: true });
    return { ready: false, outcome: "finding-retry-preview", ticket: 96, modelCalls: 0 };
  });
  t.mock.method(activity, "recordResult", async () => {
    writes++;
  });
  await require("../factory/automation.cjs").main({
    GH_TOKEN: "fixture-only",
    FACTORY_OPERATION: "auto_pick",
    FACTORY_VARIABLES: JSON.stringify({
      ...vars,
      FACTORY_ENABLED: "false",
      FACTORY_AUTOMATION_ENABLED: "false",
      FACTORY_AUTOMERGE_ENABLED: "false",
      FACTORY_DISCOVERY_ENABLED: "false",
    }),
    FACTORY_INPUTS: JSON.stringify({ operation: "retry-finding", ticket: "96", dry_run: true }),
  });
  assert.equal(writes, 0);
});
