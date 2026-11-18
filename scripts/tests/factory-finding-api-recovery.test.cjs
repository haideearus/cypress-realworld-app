const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../factory/policy.cjs");
const { retryFinding } = require("../factory/finding-retry.cjs");
const { repairBaseline } = require("../factory/discovery-repair.cjs");
const first = require("./fixtures/finding96-blocked.cjs");
const second = require("./fixtures/finding96-context-block.json");
const third = require("./fixtures/finding96-output-block.json");
const fourth = require("./fixtures/finding96-api-block.json");
const { context, vars } = require("./helpers/factory-fixtures.cjs");

const head = "e".repeat(40);
const ctx = {
  ...context,
  ticket: 96,
  runId: "8500",
  workflowRef: p.AUTOMATIC_WORKFLOW_REF,
  workflowSha: head,
  head,
};
const cfg = (overrides) =>
  p.readConfig({
    ...vars,
    FACTORY_ENABLED: "true",
    FACTORY_AUTOMATION_ENABLED: "true",
    FACTORY_AUTOMERGE_ENABLED: "false",
    FACTORY_DISCOVERY_ENABLED: "false",
    FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET: "5",
    FACTORY_MAX_AUTOMATIC_RETRIES: "4",
    FACTORY_GITHUB_APP_CLIENT_ID: "Iv1.fixture123456",
    FACTORY_GITHUB_APP_SLUG: first.ticket.automatic.appSlug,
    ...overrides,
  });
const receipt = {
  version: 1,
  priorGrant: fourth.grant.id,
  runId: ctx.runId,
  runAttempt: 1,
  workflowSha: head,
  head,
  ciRunId: "8501",
  actor: p.OWNER,
  decision: "https://github.com/haideearus/cypress-realworld-app/issues/105",
};
const request = { ...ctx, findingApiRecovery: receipt };

function baseline() {
  const state = p.emptyState(p.REPOSITORY);
  state.tickets["96"] = {
    ...structuredClone(first.ticket),
    coding: 4,
    retries: 3,
    head: fourth.grant.head,
    findingRetry: structuredClone(second.retry),
    findingContinuation: structuredClone(third.continuation),
    findingOutputRecovery: structuredClone(fourth.receipt),
  };
  for (const { grant } of [first, second, third, fourth])
    state.grants[grant.id] = structuredClone(grant);
  state.days["2026-11-18"] = [96];
  return p.validateState(state);
}

test("final handoff charges the last ordinary attempt and preserves all four reservations and receipts", () => {
  const before = baseline();
  const { state, grant } = p.reserve(before, request, cfg());
  const t = state.tickets["96"];
  assert.equal(t.coding, 5);
  assert.equal(t.retries, 4);
  for (const id of Object.keys(before.grants))
    assert.deepEqual(state.grants[id], before.grants[id]);
  for (const key of [
    "finding",
    "automatic",
    "findingRetry",
    "findingContinuation",
    "findingOutputRecovery",
  ])
    assert.deepEqual(t[key], before.tickets["96"][key]);
  assert.deepEqual(state.days, before.days);
  assert.deepEqual(t.findingApiRecovery, receipt);
  assert.equal(repairBaseline(t), head);
  assert.equal(p.preflight(state, grant.id, ctx, cfg()).id, grant.id);
  assert.throws(() => p.reserve(state, request, cfg()));
  const after = p.finish(state, grant.id, { status: "blocked" });
  assert.throws(() => p.reserve(after, request, cfg()));
  for (const change of [
    (s) => (s.tickets["96"].findingOutputRecovery.ciRunId = "8502"),
    (s) => (s.grants[fourth.grant.id].runAttempt = 2),
    (s) => delete s.tickets["96"].findingRetry,
    (s) => (s.tickets["96"].findingApiRecovery.runId = third.grant.runId),
    (s) => (s.grants[grant.id].runId = fourth.grant.runId),
    (s) => {
      s.tickets["96"].findingApiRecovery.runId = Number(fourth.grant.runId);
      s.grants[grant.id].runId = Number(fourth.grant.runId);
    },
    (s) => {
      delete s.tickets["96"].findingApiRecovery;
      s.grants[grant.id] = { ...s.grants[fourth.grant.id], id: grant.id };
    },
  ]) {
    const mutated = structuredClone(state);
    change(mutated);
    assert.throws(() => p.validateState(mutated));
  }
});

test("the final attempt can be reviewed on its resulting PR, but cannot reserve another code grant", () => {
  const { state, grant } = p.reserve(baseline(), request, cfg());
  const publishedHead = "f".repeat(40);
  const published = p.finish(state, grant.id, {
    status: "awaiting_review",
    head: publishedHead,
    pr: 999,
  });
  const review = p.reserve(published, { ...ctx, head: publishedHead, phase: "review" }, cfg());
  assert.equal(
    p.preflight(
      review.state,
      review.grant.id,
      { ...ctx, head: publishedHead, phase: "review" },
      cfg()
    ).id,
    review.grant.id
  );
  const retry = p.finish(review.state, review.grant.id, {
    status: "retry",
    head: publishedHead,
    pr: 999,
  });
  assert.throws(
    () => p.reserve(retry, { ...ctx, head: publishedHead, slot: "cycle2" }, cfg()),
    /limit/i
  );
});

test("passing review releases its slot and future automatic runs leave the PR for manual merge", async () => {
  const source = baseline();
  source.version = 2;
  delete source.active;
  source.activeTickets = {};
  const { state, grant } = p.reserve(source, request, cfg());
  const publishedHead = "f".repeat(40);
  const published = p.finish(state, grant.id, {
    status: "awaiting_review",
    head: publishedHead,
    pr: 999,
  });
  const reserved = p.reserve(published, { ...ctx, head: publishedHead, phase: "review" }, cfg());
  const reviewed = p.finish(reserved.state, reserved.grant.id, {
    status: "reviewed",
    verdict: "pass",
    head: publishedHead,
    pr: 999,
    evidence: "https://github.com/haideearus/cypress-realworld-app/actions/runs/8500",
  });
  assert.deepEqual(reviewed.activeTickets, {});
  p.validateState(reviewed);
  const { AutomaticCoordinator } = require("../factory/automation.cjs");
  const { AutomaticMerger } = require("../factory/merge.cjs");
  const future = { ...ctx, runId: "8600", event: "schedule" };
  const api = { request: async () => assert.fail("No API writes or merge reads expected") };
  const coordinator = new AutomaticCoordinator(api, cfg(), future);
  coordinator.ledger = { read: async () => ({ state: reviewed }) };
  coordinator.candidate = async () => ({ number: 106 });
  assert.equal((await coordinator.pick({ dryRun: true })).ticket, 106);
  const merger = new AutomaticMerger(api, cfg({ FACTORY_AUTOMERGE_ENABLED: "true" }), future);
  merger.ledger = { read: async () => ({ state: reviewed }) };
  await assert.rejects(merger.merge(96), /manual merge/i);
});

test("unapproved identity, replay, switched scope and ordinary limits fail closed", () => {
  for (const change of [
    { ticket: 97 },
    { runAttempt: 2 },
    { event: "schedule" },
    { triggeringActor: "foreign" },
    { phase: "review" },
    { findingOutputRecovery: fourth.receipt },
    { wake: {} },
    { runId: fourth.grant.runId },
    { findingApiRecovery: { ...receipt, priorGrant: third.grant.id } },
  ])
    assert.throws(() => p.reserve(baseline(), { ...request, ...change }, cfg()));
  for (const change of [
    { FACTORY_ENABLED: "false" },
    { FACTORY_DISCOVERY_ENABLED: "true" },
    { FACTORY_AUTOMERGE_ENABLED: "true" },
    { FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET: "4" },
    { FACTORY_MAX_AUTOMATIC_RETRIES: "3" },
  ])
    assert.throws(() => p.reserve(baseline(), request, cfg(change)));
});

test("preview uses pinned pre-Claude failure evidence and never writes or reads issue 97", async () => {
  const state = baseline();
  const issue = {
    ...require("../factory/discovery-finding-contract.cjs").issueText(first.record),
    number: 96,
    state: "open",
  };
  const owner = { login: p.OWNER, id: 101267861 };
  const parent = {
    id: Number(fourth.grant.runId),
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
    head_branch: "main",
    head_sha: fourth.grant.head,
    path: ".github/workflows/factory-automatic.yml",
    event: "workflow_dispatch",
    repository: { full_name: p.REPOSITORY },
    head_repository: { full_name: p.REPOSITORY },
    actor: owner,
    triggering_actor: owner,
  };
  const steps = [
    ["Check out only the reserved commit", "success"],
    ["Reject secrets in the reserved source before model file access", "success"],
    ["Resolve receipt-backed discovery origin", "failure"],
    ["Prove finding RED without model credentials", "skipped"],
    ["Run the one reserved Claude subscription session", "skipped"],
  ].map(([name, conclusion]) => ({ name, conclusion }));
  const jobs = [
    {
      id: 135133729529,
      name: "cycle1 / coding / agent",
      status: "completed",
      conclusion: "failure",
      steps,
    },
    { name: "cycle1 / assess", status: "completed", conclusion: "success" },
    { name: "cycle1 / publish", status: "completed", conclusion: "skipped" },
    { name: "merge", status: "completed", conclusion: "skipped" },
  ];
  const api = {
    async request(method, path) {
      assert.equal(method, "GET");
      if (path.endsWith("/issues/96")) return issue;
      if (path.endsWith("/actions/runs/" + fourth.grant.runId)) return parent;
      if (path.endsWith("/branches/main")) return { commit: { sha: head } };
      if (path.includes("/actions/workflows/")) return { state: "disabled_manually" };
      if (path.endsWith("/git/ref/heads/agent/factory-96"))
        throw Object.assign(Error("Missing"), { status: 404 });
      assert.fail("Unexpected route: " + path);
    },
    async pages(path, field) {
      assert.match(path, /44398068245\/attempts\/1\/jobs/);
      assert.equal(field, "jobs");
      return jobs;
    },
  };
  const deps = {
    ledger: { read: async () => ({ state }), update: async () => assert.fail("Unexpected write") },
    testedMain: async () => ({ head, ciRunId: "8501" }),
    verifyOrigin: async () => true,
  };
  const preview = () =>
    retryFinding(
      api,
      cfg({ FACTORY_ENABLED: "false", FACTORY_AUTOMATION_ENABLED: "false" }),
      ctx,
      { ticket: 96, dryRun: true, apiRecovery: true },
      deps
    );
  const before = structuredClone(state);
  const result = await preview();
  assert.equal(result.apiRecoveryEligible, true);
  assert.equal(result.ready, false);
  assert.equal(result.modelCalls, 0);
  assert.deepEqual(state, before);
  steps.at(-1).conclusion = "success";
  await assert.rejects(preview(), /API recovery/i);
});
