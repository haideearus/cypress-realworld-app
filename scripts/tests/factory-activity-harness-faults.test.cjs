const test = require("node:test");
const assert = require("node:assert/strict");
const { MemoryStore, repository, sha } = require("./helpers/event-fixtures.cjs");
const activity = require("../factory/activity.cjs");
const { observeRun } = require("../factory/activity-observer.cjs");
const { ROOT } = require("../factory/github.cjs");

const path = ".github/workflows/factory-ci.yml";
const controller =
  "Load the controller action and validate disabled configuration without AI or state writes";
const scanner = "Install the checksum-pinned secret scanner";
const owner = { login: "haideearus", id: 101267861 };
const bot = { login: "github-actions[bot]", id: 41898282, type: "Bot" };

function setup(t) {
  // The journal uses an external scanner and its own publication receipts.
  const publish = t.mock.method(activity, "publishActivity", async () => {});
  const warn = t.mock.method(console, "warn", () => {});
  const now = Date.now();
  const at = (minutes) => new Date(now - minutes * 60000).toISOString();
  const store = new MemoryStore({
    version: 1,
    repository,
    events: {},
    lastMonitor: null,
    staleFor: null,
    controlAfter: at(30),
  });
  const ledger = new MemoryStore({ grants: {}, tickets: {}, stop: null });
  const runs = new Map();
  const issues = [];
  const s = { store, ledger, issues, publish, warn, at, hasLabel: true };
  const update = store.update.bind(store);
  store.update = async (change) => {
    const result = await update(async (state) => {
      const next = await change(state);
      activity.validateActivity(next.state);
      return next;
    });
    if (s.loseClaim && Object.values(result.state.harnessFaults).some((row) => row.claim)) {
      s.loseClaim = false;
      throw Error("Claim response disappeared");
    }
    if (s.loseReceipt && issues.length === 1) {
      s.loseReceipt = false;
      throw Error("Receipt response disappeared");
    }
    return result;
  };
  const api = {
    async request(method, route, body) {
      if (method === "GET" && route === `${ROOT}/actions/workflows/factory-ci.yml`)
        return { id: 81, path };
      const attempt = route.match(/\/actions\/runs\/(\d+)\/attempts\/(\d+)$/);
      if (method === "GET" && attempt) return structuredClone(runs.get(+attempt[1]).run);
      if (method === "GET" && route === `${ROOT}/labels/factory-priority`) {
        if (!s.hasLabel) throw Object.assign(Error("Label missing"), { status: 404 });
        if (s.stopOnLabelCheck) ledger.state.stop = { reason: "Owner stop" };
        return { name: "factory-priority" };
      }
      if (method === "POST" && route === `${ROOT}/labels`) {
        s.hasLabel = true;
        assert.equal(body.name, "factory-priority");
        return body;
      }
      if (method === "GET" && route.startsWith(`${ROOT}/issues?state=all&creator=`))
        return s.hideLookup ? [] : structuredClone(issues);
      if (method === "POST" && route === `${ROOT}/issues`) {
        const issue = {
          ...body,
          number: issues.length + 50,
          state: "open",
          user: bot,
          labels: body.labels.map((name) => ({ name })),
        };
        issues.push(issue);
        if (s.loseResponse) throw Error("Create response disappeared");
        return structuredClone(issue);
      }
      throw Error(`Unexpected fixture request ${method} ${route}`);
    },
    async pages(route, key) {
      const attempt = route.match(/\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/);
      assert.ok(attempt);
      assert.equal(key, "jobs");
      return structuredClone(runs.get(+attempt[1]).jobs);
    },
  };
  s.observe = (
    id,
    {
      run: runOverrides = {},
      job: jobOverrides = {},
      steps = [controller],
      triage = true,
      preview = false,
    } = {}
  ) => {
    const run = {
      id,
      run_attempt: 1,
      path,
      workflow_id: 81,
      head_sha: sha,
      head_branch: "main",
      repository: { full_name: repository },
      head_repository: { full_name: repository },
      actor: owner,
      triggering_actor: owner,
      event: "push",
      status: "completed",
      conclusion: "failure",
      created_at: at(5),
      updated_at: at(2),
      ...runOverrides,
    };
    const jobs = [
      {
        id: id + 1000,
        name: "verify",
        run_id: id,
        run_attempt: run.run_attempt,
        head_sha: run.head_sha,
        status: "completed",
        conclusion: "failure",
        steps: steps.map((name, number) => ({
          number: number + 2,
          name,
          status: "completed",
          conclusion: "failure",
        })),
        ...jobOverrides,
      },
    ];
    runs.set(id, { run, jobs });
    return observeRun({
      api,
      store,
      ledger,
      runId: id,
      runAttempt: run.run_attempt,
      journalIssue: 10,
      triage,
      preview,
    });
  };
  return s;
}

test("two distinct trusted main runs create one priority-only ticket linked to both runs", async (t) => {
  const s = setup(t);
  assert.doesNotThrow(() => activity.validateActivity(s.store.state));
  await s.observe(800);
  await s.observe(800);
  assert.equal(s.issues.length, 0);
  await Promise.all([s.observe(801), s.observe(802)]);
  assert.equal(s.issues.length, 1);
  assert.deepEqual(s.issues[0].labels, [{ name: "factory-priority" }]);
  assert.match(s.issues[0].body, /actions\/runs\/800\b/);
  assert.match(s.issues[0].body, /actions\/runs\/80[12]\b/);
  assert.match(s.issues[0].body, /validate disabled configuration/);
  assert.equal(s.publish.mock.callCount(), 4);
});

test("different infrastructure signals do not count as recurrence", async (t) => {
  const s = setup(t);
  await s.observe(800, { steps: [scanner] });
  await s.observe(801);
  assert.equal(s.issues.length, 0);
  await s.observe(802, { steps: [scanner] });
  assert.equal(s.issues.length, 1);
  assert.match(s.issues[0].body, /Install the checksum-pinned secret scanner/);
  assert.match(s.issues[0].body, /actions\/runs\/80[02]\b/);
  assert.doesNotMatch(s.issues[0].body, /actions\/runs\/801\b/);
});

test("stale, foreign, nonterminal, rerun, app, model and expected stop outcomes cannot count as evidence", async (t) => {
  const s = setup(t);
  await s.observe(800, { run: { created_at: s.at(1441), updated_at: s.at(1440) } });
  await assert.rejects(
    s.observe(801, { run: { head_repository: { full_name: "fork/repo" } } }),
    /Untrusted source/
  );
  await s.observe(802, { run: { event: "pull_request" } });
  await s.observe(803, { run: { run_attempt: 2 } });
  await s.observe(804, { run: { status: "in_progress" } });
  await s.observe(805, { run: { conclusion: "cancelled" } });
  await s.observe(806, { steps: ["API and browser regression tests without cloud recording"] });
  await s.observe(807, { steps: ["Run the one reserved Claude subscription session"] });
  await s.observe(808, { steps: [`${controller} (similar step)`] });
  await s.observe(809, { job: { run_id: 800 } });
  await s.observe(810, { preview: true });
  await s.observe(811, { triage: false });
  s.ledger.state.stop = { reason: "Owner stop" };
  await s.observe(812);
  s.ledger.state.stop = null;
  await s.observe(813);
  assert.equal(s.issues.length, 0);
  await s.observe(814);
  assert.equal(s.issues.length, 1);
  assert.match(s.issues[0].body, /actions\/runs\/813\b/);
  assert.match(s.issues[0].body, /actions\/runs\/814\b/);
});

test("a committed issue whose response is lost reconciles without a second create", async (t) => {
  const s = setup(t);
  await s.observe(800);
  s.loseResponse = true;
  s.hideLookup = true;
  await s.observe(801);
  assert.equal(s.issues.length, 1);
  assert.equal(s.warn.mock.callCount(), 1);
  s.loseResponse = false;
  s.hideLookup = false;
  await s.observe(802, { run: { conclusion: "success" } });
  await s.observe(803);
  assert.equal(s.issues.length, 1);
  assert.match(JSON.stringify(s.store.state.harnessFaults), /"issue":50/);
});

test("a lost durable receipt response leaves work journal processing independent", async (t) => {
  const s = setup(t);
  await s.observe(800);
  s.loseReceipt = true;
  await s.observe(801);
  await s.observe(802);
  assert.equal(s.issues.length, 1);
  assert.equal(s.publish.mock.callCount(), 3);
});

test("a lost durable claim response still creates one issue", async (t) => {
  const s = setup(t);
  await s.observe(800);
  s.loseClaim = true;
  await s.observe(801);
  await s.observe(802);
  assert.equal(s.issues.length, 1);
  assert.equal(s.warn.mock.callCount(), 0);
});

test("a stop during preparation defers creation until a fresh recurrence after resume", async (t) => {
  const s = setup(t);
  await s.observe(800);
  s.stopOnLabelCheck = true;
  await s.observe(801);
  assert.equal(s.issues.length, 0);
  s.ledger.state.stop = null;
  s.stopOnLabelCheck = false;
  s.hasLabel = false;
  await s.observe(802);
  assert.equal(s.issues.length, 1);
  assert.equal(s.hasLabel, true);
  assert.deepEqual(s.issues[0].labels, [{ name: "factory-priority" }]);
});
