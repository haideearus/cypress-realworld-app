const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../factory/policy.cjs");
const { AutomaticCoordinator, eligibleIssue } = require("../factory/automation.cjs");
const { Controller, criteriaHash } = require("../factory/controller.cjs");
const { AutomaticMerger } = require("../factory/merge.cjs");
const { GitHub, Ledger, ROOT } = require("../factory/github.cjs");
const { FactoryFixture, context, head, vars } = require("./helpers/factory-fixtures.cjs");

const incidentId = "11111111-1111-4111-8111-111111111111";
const sourceSha = "d".repeat(40);
const workflowRef = `${policy.REPOSITORY}/.github/workflows/factory-automatic.yml@refs/heads/main`;
const automaticContext = { ...context, event: "schedule", workflowRef, workflowSha: head };
const config = {
  ...policy.readConfig(vars),
  automatic: true,
  autoMerge: true,
  appClientId: "Iv1.fixture123456",
  appSlug: "fixture-factory",
};

class MonitorFixture extends FactoryFixture {
  constructor() {
    super();
    this.issue = {
      number: 10,
      title: "Repair unavailable production readiness",
      body: "Production readiness repeatedly failed. Add a regression before fixing the cause.",
      state: "open",
      user: { login: "github-actions[bot]", type: "Bot" },
      labels: [{ name: "factory-ready" }],
      created_at: "2026-11-13T12:00:00Z",
    };
    this.issues.set(10, this.issue);
    this.incident = {
      id: incidentId,
      at: "2026-11-13T12:00:00.000Z",
      day: "2026-11-13",
      phase: "open",
      recovered: false,
      source: { runId: "700", runAttempt: 1, workflowSha: sourceSha },
      criteriaHash: criteriaHash(this.issue),
      issue: 10,
    };
    this.registry = {
      version: 1,
      repository: policy.REPOSITORY,
      active: incidentId,
      incidents: { [incidentId]: this.incident },
    };
    this.monitorAbsent = false;
    this.monitorError = null;
    this.monitorConclusion = "success";
    this.latestMonitorAttempt = 1;
    this.beforeMainRead = null;
    this.pr = {
      number: 20,
      state: "open",
      merged: false,
      draft: false,
      mergeable: true,
      mergeable_state: "clean",
      user: { login: "fixture-factory[bot]" },
      head: { sha: head, ref: "agent/factory-10", repo: { full_name: policy.REPOSITORY } },
      base: { ref: "main", repo: { full_name: policy.REPOSITORY } },
    };
    const association = {
      number: 20,
      url: `https://api.github.com${ROOT}/pulls/20`,
      head: { sha: head, ref: "agent/factory-10", repo: { url: `https://api.github.com${ROOT}` } },
      base: { ref: "main", repo: { url: `https://api.github.com${ROOT}` } },
    };
    this.nativeChecks = [
      [501, 701, 101, 601, "verify", "factory-ci.yml"],
      [502, 702, 102, 602, "Factory review gate", "factory-review-status.yml"],
    ].map(([runId, jobId, checkId, suiteId, name, file]) => ({
      runId,
      file,
      check: {
        id: checkId,
        name,
        head_sha: head,
        status: "completed",
        conclusion: "success",
        app: { id: 15368 },
        check_suite: { id: suiteId },
        pull_requests: [structuredClone(association)],
        details_url: `https://github.com/${policy.REPOSITORY}/actions/runs/${runId}/job/${jobId}`,
      },
      run: {
        id: runId,
        path: `.github/workflows/${file}`,
        event: "pull_request",
        head_sha: head,
        head_branch: "agent/factory-10",
        repository: { full_name: policy.REPOSITORY },
        head_repository: { full_name: policy.REPOSITORY },
        pull_requests: [structuredClone(association)],
        check_suite_id: suiteId,
        status: "completed",
        conclusion: "success",
      },
      job: {
        id: jobId,
        run_id: runId,
        name,
        check_run_url: `https://api.github.com${ROOT}/check-runs/${checkId}`,
        status: "completed",
        conclusion: "success",
      },
    }));
    this.integrationCalls = [];
    const inherited = this.fetch;
    this.fetch = async (url, options = {}) => {
      const u = new URL(url);
      const path = u.pathname.slice(ROOT.length);
      const method = options.method || "GET";
      this.integrationCalls.push({ path, method });
      const reply = (status, value) => new Response(JSON.stringify(value), { status });
      if (method === "GET" && path === "/issues") return reply(200, [...this.issues.values()]);
      if (method === "GET" && path === "/branches/main" && this.beforeMainRead)
        this.beforeMainRead();
      if (method === "GET" && path === "/git/ref/heads/factory/monitor") {
        if (this.monitorError) return reply(this.monitorError, {});
        return this.monitorAbsent
          ? reply(404, {})
          : reply(200, { object: { sha: "e".repeat(40) } });
      }
      if (method === "GET" && path === "/contents/monitor.json")
        return reply(200, {
          type: "file",
          encoding: "base64",
          content: Buffer.from(JSON.stringify(this.registry)).toString("base64"),
        });
      if (method === "GET" && path === "/actions/workflows/factory-monitor.yml")
        return reply(200, { id: 44, path: ".github/workflows/factory-monitor.yml" });
      if (
        method === "GET" &&
        [
          `/actions/runs/${this.incident.source.runId}/attempts/1`,
          `/actions/runs/${this.incident.source.runId}`,
        ].includes(path)
      ) {
        const attempt = path.endsWith("/attempts/1") ? 1 : this.latestMonitorAttempt;
        return reply(200, {
          id: Number(this.incident.source.runId),
          workflow_id: 44,
          path: ".github/workflows/factory-monitor.yml",
          event: "schedule",
          head_branch: "main",
          head_sha: sourceSha,
          run_attempt: attempt,
          status: "completed",
          conclusion: attempt === 1 ? this.monitorConclusion : "skipped",
          repository: { full_name: policy.REPOSITORY },
          head_repository: { full_name: policy.REPOSITORY },
          actor: { login: policy.OWNER },
          triggering_actor: { login: policy.OWNER },
        });
      }
      if (
        method === "GET" &&
        path === `/actions/runs/${this.incident.source.runId}/attempts/1/jobs`
      )
        return reply(200, {
          jobs: [
            {
              name: "monitor",
              status: "completed",
              conclusion: this.monitorConclusion,
              steps: [
                {
                  name: "Observe production and publish incident",
                  status: "completed",
                  conclusion: this.monitorConclusion,
                },
              ],
            },
          ],
        });
      if (method === "GET" && path === "/pulls/20") return reply(200, this.pr);
      if (method === "GET" && path === "/pulls/20/files")
        return reply(200, [{ filename: "src/example.ts", status: "modified" }]);
      if (method === "GET" && path === `/commits/${head}/check-runs`)
        return reply(200, { check_runs: this.nativeChecks.map((entry) => entry.check) });
      for (const native of this.nativeChecks) {
        if (method === "GET" && path === `/actions/runs/${native.runId}`)
          return reply(200, native.run);
        if (method === "GET" && path === `/actions/runs/${native.runId}/jobs`)
          return reply(200, { jobs: [native.job] });
      }
      if (method === "GET" && path === "/actions/runs/503")
        return reply(200, {
          id: 503,
          head_sha: head,
          display_title: "Factory CI / 22222222-2222-4222-8222-222222222222",
          event: "workflow_dispatch",
          path: ".github/workflows/factory-ci.yml",
          status: "completed",
          conclusion: "success",
        });
      if (method === "PUT" && path === "/pulls/20/merge") {
        assert.equal(JSON.parse(options.body).sha, head);
        this.pr.state = "closed";
        this.pr.merged = true;
        this.pr.merge_commit_sha = "c".repeat(40);
        this.issue.state = "closed";
        return reply(200, { merged: true, sha: this.pr.merge_commit_sha });
      }
      return inherited(url, options);
    };
  }
}

async function setup() {
  const fixture = new MonitorFixture();
  const api = new GitHub({ token: "fixture-only", fetch: fixture.fetch });
  const ledger = new Ledger(api);
  await ledger.initialize();
  fixture.calls.length = 0;
  fixture.integrationCalls.length = 0;
  return {
    fixture,
    api,
    ledger,
    coordinator: new AutomaticCoordinator(api, config, automaticContext),
    controller: new Controller(api, config, automaticContext),
    merger: new AutomaticMerger(api, config, automaticContext),
  };
}

async function approve(s, admission) {
  await s.ledger.update((state) => {
    let next = policy.finish(state, admission.grantId, {
      status: "awaiting_review",
      head,
      pr: 20,
    });
    const reserved = policy.reserve(next, { ...automaticContext, phase: "review" }, config);
    next = policy.finish(reserved.state, reserved.grant.id, {
      status: "reviewed",
      head,
      pr: 20,
      verdict: "pass",
      evidence: `https://github.com/${policy.REPOSITORY}/actions/runs/100`,
    });
    Object.assign(next.tickets["10"], {
      branch: "agent/factory-10",
      ci: { requestId: "22222222-2222-4222-8222-222222222222", runId: 503, head, passed: true },
    });
    return { state: next };
  });
}

test("trusted monitoring receipt admits a bot issue and survives independent review and merge", async () => {
  const s = await setup();
  assert.equal(eligibleIssue(s.fixture.issue), false, "public owner-only predicate stays narrow");
  const admission = await s.coordinator.pick();
  assert.equal(admission.ready, true);
  const admitted = (await s.ledger.read()).state.tickets["10"];
  assert.equal(admitted.monitor.incidentId, incidentId);
  assert.equal(admitted.monitor.runId, "700");
  assert.equal(admitted.coding, 1);
  await approve(s, admission);
  const result = await s.merger.merge(10);
  assert.equal(result.merged, true);
  const state = (await s.ledger.read()).state;
  assert.deepEqual(state.tickets["10"].monitor, admitted.monitor);
  assert.equal(state.tickets["10"].reviews, 1);
  assert.equal(state.tickets["10"].merge.status, "merged");
});

test("bot name and queue label without a successful matching receipt never admit work", async () => {
  for (const mutate of [
    (f) => (f.monitorAbsent = true),
    (f) => {
      f.registry.incidents = {};
      f.registry.active = null;
    },
    (f) => (f.monitorConclusion = "failure"),
    (f) => (f.issue.user.type = "User"),
    (f) => (f.issue.user.login = "untrusted-bot[bot]"),
    (f) => (f.incident.issue = 11),
    (f) => (f.incident.recovered = true),
  ]) {
    const s = await setup();
    mutate(s.fixture);
    assert.equal((await s.coordinator.pick()).ready, false);
    await assert.rejects(s.controller.admit(10), /owner|monitor|trusted|eligible/i);
    assert.equal(Object.keys((await s.ledger.read()).state.grants).length, 0);
  }
});

test("changed incident criteria cannot enter the queue or merge an admitted ticket", async () => {
  const changedBefore = await setup();
  changedBefore.fixture.issue.body += " Changed criteria.";
  assert.equal((await changedBefore.coordinator.pick()).ready, false);
  assert.equal(Object.keys((await changedBefore.ledger.read()).state.grants).length, 0);

  const s = await setup();
  const admission = await s.coordinator.pick();
  assert.equal(admission.ready, true);
  await approve(s, admission);
  const before = (await s.ledger.read()).state;
  s.fixture.issue.body += " Changed criteria.";
  await assert.rejects(s.merger.merge(10), /criteria|monitor|owner|origin|changed/i);
  assert.deepEqual((await s.ledger.read()).state, before);
  assert.equal(
    s.fixture.integrationCalls.some((call) => call.method === "PUT"),
    false
  );
});

test("incident recovery after admission preserves the immutable proof and permits reviewed merge", async () => {
  const s = await setup();
  const admission = await s.coordinator.pick();
  assert.equal(admission.ready, true);
  await approve(s, admission);
  s.fixture.incident.recovered = true;
  s.fixture.registry.active = null;
  assert.equal((await s.merger.merge(10)).merged, true);
});

test("a later skipped monitor rerun preserves the original successful admission and merge receipt", async () => {
  const s = await setup();
  s.fixture.latestMonitorAttempt = 2;
  const admission = await s.coordinator.pick();
  assert.equal(admission.ready, true);
  await approve(s, admission);
  assert.equal((await s.merger.merge(10)).merged, true);
  const proof = (await s.ledger.read()).state.tickets["10"].monitor;
  assert.equal(proof.runId, "700");
  assert.equal(proof.runAttempt, 1);
});

test("a missing or replaced admission receipt cannot authorize an already reviewed merge", async () => {
  for (const mutate of [
    (f) => (f.monitorAbsent = true),
    (f) => {
      f.incident.source = { ...f.incident.source, runId: "701" };
    },
  ]) {
    const s = await setup();
    const admission = await s.coordinator.pick();
    assert.equal(admission.ready, true);
    await approve(s, admission);
    const before = (await s.ledger.read()).state;
    mutate(s.fixture);
    await assert.rejects(s.merger.merge(10), /criteria|monitor|owner|origin|changed/i);
    assert.deepEqual((await s.ledger.read()).state, before);
    assert.equal(
      s.fixture.integrationCalls.some((call) => call.method === "PUT"),
      false
    );
  }
});

test("replacing a receipt between issue verification and CAS cannot reserve a model grant", async () => {
  const s = await setup();
  s.fixture.beforeMainRead = () => {
    const replacement = { ...s.fixture.incident, id: "33333333-3333-4333-8333-333333333333" };
    s.fixture.incident = replacement;
    s.fixture.registry.incidents = { [replacement.id]: replacement };
    s.fixture.registry.active = replacement.id;
  };
  await assert.rejects(s.controller.admit(10), /monitor|receipt|proof|changed|trusted/i);
  assert.equal(Object.keys((await s.ledger.read()).state.grants).length, 0);
});

test("monitor registry transport failures stop selection rather than silently admitting or skipping", async () => {
  const s = await setup();
  s.fixture.monitorError = 503;
  await assert.rejects(s.coordinator.pick(), /503/);
  assert.equal(Object.keys((await s.ledger.read()).state.grants).length, 0);
});
