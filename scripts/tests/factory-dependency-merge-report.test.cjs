const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { ROOT } = require("../factory/github.cjs");
const { MemoryStore, repository, sha } = require("./helpers/event-fixtures.cjs");
const { MetadataFixture } = require("./helpers/metadata-fixture.cjs");
const a = require("../factory/activity.cjs");
const observer = require("../factory/activity-observer.cjs");
const alerts = require("../factory/dependency-alert-repair.cjs");

const path = ".github/workflows/factory-dependencies.yml";
const first = 46066424823;
const staleGate = "Refreshed native review gate did not pass";
const bot = { login: "github-actions[bot]", id: 41898282, type: "Bot" };
const owner = { login: "haideearus", id: 101267861, type: "User" };
const app = "haideearus-software-factory";
const grant = "826399c0-aae6-485e-a673-c90d4e1a0d0c";
const key = "1".repeat(64);
const branch = `agent/dependency-alert-${key}`;

function fixture(t) {
  t.mock.method(a, "verifyActivityProducer", async (_api, event) => ({
    ...s.run,
    id: +event.producer.runId,
  }));
  t.mock.method(a, "publishActivity", async () => {});
  const now = Date.now();
  const stamp = (offset) => new Date(now - offset).toISOString();
  const row = {
    issue: 298,
    pr: 299,
    phase: "ready",
    name: "ws",
    candidate: "8.21.0",
    base: sha,
    head: sha,
  };
  const issue = {
    number: 298,
    title: alerts.issueTitle(row),
    body: alerts.issueBody(key, row),
    state: "open",
    labels: [{ name: "factory-dependency-ready" }],
    user: bot,
  };
  const ticket = {
    origin: "dependency-pr",
    status: "reviewed",
    pr: 299,
    head: sha,
    branch,
    approval: { head: sha, grant, verdict: "pass", source: "claude-subscription", fixture: false },
    dependency: {
      appSlug: app,
      attempts: [{ head: sha, workflowSha: sha, runId: String(first), runAttempt: 1 }],
    },
    dependencyMergeRetry: {
      head: sha,
      grant,
      phase: "held",
      at: stamp(1000),
      sourceRun: String(first),
      retryAt: null,
      run: null,
      failure: { stage: "required-checks", reason: staleGate },
    },
  };
  const ledger = new MemoryStore({
    tickets: { 299: ticket },
    grants: {
      [grant]: {
        id: grant,
        head: sha,
        phase: "review",
        runId: String(first),
        runAttempt: 1,
        ticket: 299,
        status: "finished",
        outcome: "reviewed",
      },
    },
    active: null,
    stop: null,
    audit: [],
  });
  const store = new MemoryStore(a.emptyActivity());
  const reportStore = new MemoryStore({ version: 1, repository, notes: {}, harnessFaults: {} });
  const alertStore = new MemoryStore({ records: { [key]: row } });
  const s = {
    ledger,
    store,
    reportStore,
    alertStore,
    issue,
    published: [],
    comments: [],
    calls: [],
    run: {
      id: first,
      path,
      run_attempt: 1,
      head_sha: sha,
      head_branch: "main",
      actor: bot,
      triggering_actor: bot,
      repository: { full_name: repository },
      head_repository: { full_name: repository },
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "failure",
      created_at: stamp(3000),
      updated_at: stamp(500),
    },
    pr: {
      number: 299,
      state: "open",
      draft: false,
      merged: false,
      user: { login: `${app}[bot]`, id: 100, type: "Bot" },
      head: { ref: branch, sha, repo: { full_name: repository } },
      base: { ref: "main", sha, repo: { full_name: repository } },
    },
  };
  s.api = {
    async request(method, route, body) {
      s.calls.push([method, route]);
      if (method === "GET" && route.includes("/actions/runs/")) return structuredClone(s.run);
      if (method === "GET" && route === `${ROOT}/pulls/299`) return structuredClone(s.pr);
      if (method === "GET" && route === `${ROOT}/issues/298`) return structuredClone(s.issue);
      if (method === "GET" && route.startsWith(`${ROOT}/issues/298/comments?`))
        return s.hideComment ? [] : structuredClone(s.comments);
      if (method === "GET" && route.startsWith(`${ROOT}/issues?state=all&creator=`))
        return structuredClone(s.published);
      if (method === "GET" && route === `${ROOT}/labels/factory-priority`)
        return { name: "factory-priority" };
      if (method === "POST" && route === `${ROOT}/issues/298/comments`) {
        const comment = {
          id: 80,
          body: body.body,
          user: bot,
          issue_url: `https://api.github.com${ROOT}/issues/298`,
        };
        s.comments.push(comment);
        if (s.lostPost) throw Error("Lost response");
        return structuredClone(comment);
      }
      if (method === "PATCH" && route === `${ROOT}/issues/comments/80`) {
        s.comments[0].body = body.body;
        return structuredClone(s.comments[0]);
      }
      if (method === "POST" && route === `${ROOT}/issues`) {
        const issue = {
          ...body,
          state: "open",
          user: bot,
          number: 312,
          labels: body.labels.map((name) => ({ name })),
        };
        s.published.push(issue);
        return structuredClone(issue);
      }
      throw Error(`Unexpected ${method} ${route}`);
    },
    async pages() {
      return [];
    },
  };
  s.observe = (preview = false) =>
    observer.observeRun({
      ...s,
      runId: s.run.id,
      runAttempt: s.run.run_attempt,
      journalIssue: 84,
      preview,
    });
  s.nextRun = (verifierHeld = true) => {
    s.run.id++;
    const t = s.ledger.state.tickets[299];
    t.dependencyMergeRetry.sourceRun = String(s.run.id);
    t.dependency.attempts[0].runId = String(s.run.id);
    s.ledger.state.grants[grant].runId = String(s.run.id);
    s.ledger.state.audit.push({
      event: "dependency_merge_preflight_held",
      ticket: t.pr,
      head: t.head,
      runId: String(s.run.id),
      recovery: "held",
      trustedGateRefreshUnavailable: verifierHeld,
    });
  };
  return s;
}

test("#299 leaves one durable hold comment on verified #298 and replays safely after a lost POST", async (t) => {
  const s = fixture(t);
  const before = structuredClone(s.ledger.state);
  s.lostPost = true;
  s.hideComment = true;
  await s.observe();
  assert.equal(s.comments.length, 1);
  assert.match(s.comments[0].body, /PR #299/);
  assert.match(s.comments[0].body, /46066424823/);
  assert.match(s.comments[0].body, /saved independent review/i);
  s.hideComment = false;
  await s.observe();
  s.nextRun(false);
  await s.observe();
  assert.equal(s.comments.length, 1);
  assert.match(s.comments[0].body, /46066424824/);
  assert.equal(s.issue.body, alerts.issueBody(key, s.alertStore.state.records[key]));
  assert.deepEqual(s.ledger.state.active, before.active);
  assert.equal(s.ledger.writes, 0);
});

test("common verifier unavailability opens one maintenance issue only after two distinct trusted holds", async (t) => {
  const s = fixture(t);
  s.nextRun();
  await s.observe();
  await s.observe();
  assert.equal(s.published.length, 0);
  s.nextRun();
  await s.observe();
  await s.observe();
  assert.equal(s.published.length, 1);
  assert.deepEqual(s.published[0].labels, [{ name: "factory-priority" }]);
  assert.match(s.published[0].body, /46066424824/);
  assert.match(s.published[0].body, /46066424825/);
  assert.equal(s.comments.length, 1);
});

test("closed, forged, superseded, preview and stopped holds do not produce notification writes", async (t) => {
  const s = fixture(t);
  await s.observe(true);
  s.issue.state = "closed";
  await s.observe();
  s.issue.state = "open";
  s.issue.user = owner;
  await s.observe();
  s.issue.user = bot;
  s.pr.head.sha = "b".repeat(40);
  await s.observe();
  s.pr.head.sha = sha;
  s.ledger.state.stop = { reason: "owner stop" };
  await s.observe();
  assert.equal(s.comments.length, 0);
  assert.equal(s.published.length, 0);
});

test("ledger read failure has a fixed model-free Actions summary without publishing", async (t) => {
  const s = fixture(t);
  s.ledger.read = async () => {
    throw Error("untrusted authorization: ghs_unsafe-text");
  };
  s.env = { GITHUB_STEP_SUMMARY: "summary.txt" };
  const write = t.mock.method(fs, "appendFileSync", () => {});
  const result = await s.observe();
  assert.deepEqual(result, {
    outcome: "ledger_unavailable",
    events: 0,
    status: "completed",
    modelCalls: 0,
  });
  assert.equal(write.mock.callCount(), 1);
  assert.match(write.mock.calls[0].arguments[1], /ledger/i);
  assert.doesNotMatch(write.mock.calls[0].arguments[1], /ghs_|unsafe-text/);
  assert.equal(s.comments.length, 0);
  assert.equal(s.published.length, 0);
});

test("concurrent observers share one real metadata claim and never create a second note", async (t) => {
  const s = fixture(t);
  const metadata = new MetadataFixture();
  const request = s.api.request;
  s.api.request = (method, path, body) =>
    path.includes("/git/") || path.includes("/contents/")
      ? metadata.request(method, path, body)
      : request(method, path, body);
  s.reportStore = undefined;
  await Promise.all([s.observe(), s.observe()]);
  assert.equal(s.comments.length, 1);
  assert.ok(metadata.refs.has("factory/merge-reports"));
  s.nextRun(false);
  await s.observe();
  assert.equal(s.comments.length, 1);
  assert.match(s.comments[0].body, /46066424824/);
});

test("a later held run reconciles the earlier lost response before updating the same note", async (t) => {
  const s = fixture(t);
  s.lostPost = true;
  await s.observe();
  assert.equal(s.comments.length, 1);
  s.nextRun(false);
  await s.observe();
  assert.equal(s.comments.length, 1);
  assert.match(s.comments[0].body, /46066424824/);
});
