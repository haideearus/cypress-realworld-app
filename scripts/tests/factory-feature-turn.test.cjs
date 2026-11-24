const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../factory/policy.cjs");
const t = require("../factory/feature-turn.cjs");
const { main } = require("../factory/feature-run.cjs");
const { MemoryStore } = require("./helpers/event-fixtures.cjs");
const { vars, context, head } = require("./helpers/factory-fixtures.cjs");
const c = require("../factory/feature-contract.cjs");

const variables = {
  ...vars,
  FACTORY_ENABLED: "true",
  FACTORY_AUTOMATION_ENABLED: "true",
  FACTORY_FEATURE_MODE: "live",
  FACTORY_GITHUB_APP_CLIENT_ID: "Iv123456789",
  FACTORY_GITHUB_APP_SLUG: "factory-example",
};
const config = p.readConfig(variables);
const now = new Date("2026-11-24T09:04:00Z");

test("one feature turn waits without consuming a model or ticket allowance", () => {
  const state = p.emptyState(p.REPOSITORY);
  assert.equal(t.enqueue(state, config, "701", now), true);
  assert.equal(t.enqueue(state, config, "702", now), false);
  assert.equal(t.priority(state, config, now).runId, "701");
  assert.equal(p.dailyAdmissions(state, "2026-11-24"), 0);
  assert.deepEqual(state.grants, {});
  t.update(state, "701", { ticket: 75 });
  assert.equal(t.priority(state, config, now).ticket, 75);
  t.update(state, "701", { status: "finished" });
  assert.equal(t.priority(state, config, now), null);
  assert.equal(t.enqueue(state, config, "701", now), false);
});

test("a quota hold yields the slot until its retry time", () => {
  const state = p.emptyState(p.REPOSITORY);
  t.enqueue(state, config, "701", now);
  const reset = new Date("2026-11-24T09:21:00Z");
  t.update(state, "701", { retryAt: reset.toISOString() });
  assert.equal(t.priority(state, config, now), null);
  assert.equal(t.priority(state, config, reset).runId, "701");
  assert.equal(t.priority(state, { ...config, featureMode: "off" }, reset), null);
  assert.equal(t.priority(state, { ...config, daily: 0 }, reset), null);
  assert.equal(t.priority(state, config, new Date("2026-11-25T09:05:00Z")), null);
});

test("a failed selector lease expires and a feature coding limit does not block other lanes", () => {
  const state = p.emptyState(p.REPOSITORY);
  t.enqueue(state, config, "701", now);
  t.update(state, "701", { attemptAt: now.toISOString() });
  const later = new Date(now.getTime() + 6 * 60000);
  assert.equal(t.priority(state, config, later), null);
  assert.equal(t.eligible(state, config, later).runId, "701");
  t.update(state, "701", { ticket: 75, attemptAt: null });
  assert.equal(t.priority(state, { ...config, coding: 0 }, later), null);
});

test("the usage ledger validates optional feature turn records and still reads older states", () => {
  const state = p.emptyState(p.REPOSITORY);
  assert.doesNotThrow(() => p.validateState(state));
  t.enqueue(state, config, "701", now);
  assert.doesNotThrow(() => p.validateState(state));
  state.featureTurn.ticket = -1;
  assert.throws(() => p.validateState(state), /feature turn/i);
});

function workflowFixture() {
  const repository = { full_name: p.REPOSITORY };
  const owner = { login: p.OWNER, id: 101267861 };
  const run = (id, path, workflow_id, event, actor = owner) => ({
    id,
    path,
    workflow_id,
    event,
    actor,
    triggering_actor: actor,
    head_sha: head,
    head_branch: "main",
    repository,
    head_repository: repository,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
  });
  const source = run(
    801,
    ".github/workflows/factory-dependencies.yml",
    91,
    "workflow_dispatch",
    c.BOT
  );
  const ci = run(802, ".github/workflows/factory-ci.yml", 92, "push");
  const runs = {
    701: { ...run(701, c.WORKFLOW, 90, "schedule"), status: "in_progress" },
    702: { ...run(702, c.WORKFLOW, 90, "workflow_run", c.BOT), status: "in_progress" },
  };
  const ledger = new MemoryStore(p.emptyState(p.REPOSITORY));
  const fixture = {
    ledger,
    monitor: null,
    source,
    store: new MemoryStore(c.emptyRegistry()),
    now: () => now,
    event: { action: "completed", repository, workflow_run: structuredClone(source) },
  };
  fixture.api = {
    primaryQuota: { limit: 1000, remaining: 900, reset: now.getTime() + 1800000 },
    async request(method, url) {
      assert.equal(method, "GET");
      if (url.endsWith("/branches/main")) return { commit: { sha: head } };
      if (url.endsWith("/actions/workflows/factory-dependencies.yml"))
        return { id: source.workflow_id, path: source.path };
      if (url.endsWith("/git/ref/heads/factory/monitor")) {
        if (!fixture.monitor) throw Object.assign(Error("No monitor registry"), { status: 404 });
        return { object: { sha: head } };
      }
      if (url.includes("/contents/monitor.json?"))
        return {
          type: "file",
          encoding: "base64",
          content: Buffer.from(JSON.stringify(fixture.monitor)).toString("base64"),
        };
      const id = /\/runs\/(\d+)\/attempts\/1$/.exec(url)?.[1];
      if (id === "801") return structuredClone(source);
      if (runs[id]) return structuredClone(runs[id]);
      throw Error("Unexpected fixture request " + url);
    },
    async pages(url) {
      if (url.includes("/factory-ci.yml/runs?")) return [ci];
      if (url.includes("/runs/802/attempts/1/jobs"))
        return [{ name: "verify", head_sha: head, conclusion: "success" }];
      throw Error("Unexpected fixture pages " + url);
    },
  };
  fixture.run = (id) =>
    main(
      {
        GITHUB_REPOSITORY: p.REPOSITORY,
        GITHUB_ACTOR: runs[id].actor.login,
        GITHUB_REF: "refs/heads/main",
        GITHUB_EVENT_NAME: runs[id].event,
        GITHUB_WORKFLOW_REF: p.REPOSITORY + "/" + c.WORKFLOW + "@refs/heads/main",
        GITHUB_WORKFLOW_SHA: head,
        GITHUB_RUN_ID: String(id),
        GITHUB_RUN_ATTEMPT: "1",
        FACTORY_VARIABLES: JSON.stringify(variables),
        FACTORY_OPERATION: "select",
      },
      fixture
    );
  return fixture;
}

test("scheduled feature waits for the current job, then a verified completion resumes it once", async () => {
  const s = workflowFixture();
  s.ledger.state.active = { ticket: 56, runId: "801", runAttempt: 1 };
  assert.match((await s.run(701)).reason, /active work finishes/);
  assert.equal(s.ledger.state.featureTurn.status, "waiting");
  assert.equal(s.ledger.state.featurePlans, undefined);
  assert.equal(s.ledger.state.active.ticket, 56);
  s.ledger.state.active = null;
  assert.equal((await s.run(702)).ready, true);
  assert.equal(s.ledger.state.featureTurn.status, "finished");
  assert.equal(Object.values(s.ledger.state.featurePlans)[0].runId, "702");
  assert.equal((await s.run(702)).ready, false);
  assert.equal(Object.keys(s.ledger.state.featurePlans).length, 1);
});

test("a released version one slot still waits for the current repair merge to finish", async () => {
  const s = workflowFixture();
  s.ledger.state.tickets["56"] = { automatic: true, status: "reviewed" };
  assert.match((await s.run(701)).reason, /active work finishes/);
  assert.equal(s.ledger.state.featureTurn.status, "waiting");
  assert.equal(s.ledger.state.featurePlans, undefined);
});

test("a completion cannot create a turn and foreign run evidence cannot resume one", async () => {
  const s = workflowFixture();
  assert.match((await s.run(702)).reason, /no scheduled feature turn/i);
  assert.equal(s.ledger.writes, 0);
  t.enqueue(s.ledger.state, config, "701", now);
  s.source.head_repository = { full_name: "untrusted/fork" };
  await assert.rejects(s.run(702), /untrusted source/i);
  assert.equal(s.ledger.state.featureTurn.status, "waiting");
  assert.equal(s.ledger.state.featurePlans, undefined);
});

test("a low-quota scheduled turn defers without reserving a plan or blocking ordinary admission", async () => {
  const s = workflowFixture();
  s.api.primaryQuota.remaining = 20;
  assert.match((await s.run(701)).reason, /GitHub API headroom/);
  assert.equal(s.ledger.state.featureTurn.status, "waiting");
  assert.equal(t.priority(s.ledger.state, config, now), null);
  assert.equal(s.ledger.state.featurePlans, undefined);
});

test("verified production incident leaves the turn waiting without a reservation", async () => {
  const s = workflowFixture();
  const { emptyMonitorState } = require("../factory/monitor-state.cjs");
  const id = "12345678-1234-4123-8123-123456789012";
  s.monitor = emptyMonitorState();
  s.monitor.active = id;
  s.monitor.incidents[id] = {
    id,
    at: now.toISOString(),
    day: "2026-11-24",
    phase: "open",
    recovered: false,
    source: { runId: "800", runAttempt: 1, workflowSha: head },
    criteriaHash: head + "a".repeat(24),
    issue: 50,
  };
  assert.match((await s.run(701)).reason, /production incident/);
  assert.equal(s.ledger.state.featureTurn.status, "waiting");
  assert.equal(s.ledger.state.featurePlans, undefined);
});

test("ordinary Dependabot admission yields until the feature's quota hold", () => {
  const dep = require("../factory/dependency-contract.cjs");
  const { claimDependency } = require("../factory/dependency-policy.cjs");
  const state = p.emptyState(p.REPOSITORY);
  t.enqueue(state, config, "701", now);
  const repo = { full_name: p.REPOSITORY };
  const pr = {
    number: 236,
    state: "open",
    draft: false,
    user: { login: "dependabot[bot]", type: "Bot", id: 49699333 },
    head: { sha: "b".repeat(40), ref: "dependabot/npm_and_yarn/demo-2", repo },
    base: { sha: head, ref: "main", repo },
  };
  const ctx = { ...context, workflowRef: dep.WORKFLOW, workflowSha: head, event: "schedule" };
  assert.throws(() => claimDependency(state, pr, ctx, config, now), /feature turn is next/);
  t.update(state, "701", { retryAt: new Date(now.getTime() + 60000).toISOString() });
  assert.equal(claimDependency(state, pr, ctx, config, now).active.ticket, 236);
});
