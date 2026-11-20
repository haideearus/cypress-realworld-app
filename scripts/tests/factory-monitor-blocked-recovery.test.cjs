const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../factory/policy.cjs");
const { monitor } = require("../factory/monitor.cjs");
const { acknowledge } = require("../factory/monitor-ack.cjs");
const { proofFromIncident } = require("../factory/monitor-proof.cjs");
const { fixture, sha } = require("./helpers/monitor-ack-fixture.cjs");
const { vars, head, context: factoryContext } = require("./helpers/factory-fixtures.cjs");

const firstAt = "2026-11-16T08:30:00.000Z";
const secondAt = "2026-11-16T09:00:00.000Z";
const ownerAt = "2026-11-16T09:05:00.000Z";
const release = "d".repeat(40);
const ownerWorkflow = ".github/workflows/factory-monitor-acknowledge.yml";
const monitorWorkflow = ".github/workflows/factory-monitor.yml";

function blocked() {
  const f = fixture();
  f.incident.probeMode = "feed-contract";
  const { stop } = f.state;
  const cfg = { ...policy.readConfig(vars), appSlug: "fixture", automatic: true };
  const code = {
    ...factoryContext,
    ticket: f.issue.number,
    event: "schedule",
    head,
    workflowSha: head,
    workflowRef: policy.AUTOMATIC_WORKFLOW_REF,
  };
  const held = policy.reserve(
    policy.emptyState(policy.REPOSITORY),
    code,
    cfg,
    new Date("2026-11-16T08:01:00.000Z")
  );
  Object.assign(held.state.tickets[65], {
    criteriaHash: f.incident.criteriaHash,
    monitor: proofFromIncident(f.incident),
    automatic: {
      runId: code.runId,
      runAttempt: code.runAttempt,
      workflowRef: code.workflowRef,
      workflowSha: code.workflowSha,
      appSlug: cfg.appSlug,
    },
  });
  Object.assign(f.state, policy.finish(held.state, held.grant.id, { status: "blocked" }));
  f.state.stop = stop;
  f.grant = held.grant;
  f.settings.FACTORY_FEED_CONTRACT_CHECK_ENABLED = "true";
  f.observation.release = release;
  f.report.kind = "feed-contract-recovery-observation";
  f.report.at = ownerAt;
  f.report.result.releases = { before: release, after: release };
  f.report.result.feedContract = "ok";
  f.now = () => ownerAt;
  const request = f.api.request;
  const times = new Map();
  f.api.request = async (method, url, body) => {
    const p = new URL("https://api.github.com" + url);
    if (
      !/\/git\/ref\/heads\/factory\/state$|\/contents\/state.json$|\/pulls$|\/git\/ref\/heads\/agent\/factory-65$|\/actions\/runs\/(?:100|80[1-5])\/attempts\/1(?:\/jobs)?$/.test(
        p.pathname
      )
    )
      return request(method, url, body);
    f.calls.push({ method, path: p.pathname, body });
    assert.equal(method, "GET");
    if (p.pathname.endsWith("/git/ref/heads/factory/state")) return { object: { sha } };
    if (p.pathname.endsWith("/contents/state.json"))
      return {
        type: "file",
        encoding: "base64",
        content: Buffer.from(JSON.stringify(f.state)).toString("base64"),
      };
    if (p.pathname.endsWith("/pulls")) {
      assert.equal(p.searchParams.get("head"), "haideearus:agent/factory-65");
      assert.equal(p.searchParams.get("state"), "all");
      return f.pulls || [];
    }
    if (p.pathname.endsWith("agent/factory-65")) {
      if (f.branch) return { object: { sha } };
      throw Object.assign(Error("no branch"), { status: 404 });
    }
    const id = Number(p.pathname.match(/runs\/(\d+)/)[1]);
    const isRepair = id === Number(code.runId);
    const at = times.get(String(id));
    if (p.pathname.endsWith("/jobs"))
      return {
        total_count: 1,
        jobs: [
          {
            name: "monitor",
            status: "completed",
            conclusion: "success",
            head_sha: sha,
            steps: [
              "Check synthetic-user API journey",
              "Scan credential-free app check report",
              "Observe production and publish incident",
            ].map((name) => ({ name, status: "completed", conclusion: "success" })),
          },
        ],
      };
    return {
      id,
      run_attempt: 1,
      workflow_id: 10,
      status: "completed",
      conclusion: isRepair ? "failure" : f.invalidScheduledRun === id ? "failure" : "success",
      head_sha: isRepair ? head : sha,
      head_branch: "main",
      event: "schedule",
      repository: { full_name: policy.REPOSITORY },
      head_repository: { full_name: policy.REPOSITORY },
      actor: { login: policy.OWNER },
      triggering_actor: { login: policy.OWNER },
      path: isRepair ? ".github/workflows/factory-automatic.yml" : monitorWorkflow,
      run_started_at: isRepair ? "2026-11-16T08:01:00.000Z" : at,
      updated_at: isRepair ? "2026-11-16T08:10:00.000Z" : at,
    };
  };
  f.scheduled = (runId, at, extras = {}) => {
    times.set(runId, at);
    return monitor({
      api: f.api,
      store: f.store,
      context: {
        ...f.context,
        eventName: "schedule",
        runId,
        workflowRef: `${policy.REPOSITORY}/${monitorWorkflow}@refs/heads/main`,
      },
      enabled: true,
      dryRun: false,
      probe: async () => f.observation,
      now: () => at,
      appChecks: f.report.result,
      ...extras,
    });
  };
  f.ownerAck = (extra = {}) =>
    acknowledge({
      ...f.options(),
      context: {
        ...f.context,
        workflowRef: `${policy.REPOSITORY}/${ownerWorkflow}@refs/heads/main`,
      },
      blockedRepair: true,
      ...extra,
    });
  return f;
}

test("scheduled full health evidence surfaces owner action after two distinct runs with zero closure or usage writes", async () => {
  const f = blocked();
  delete f.state.stop;
  const original = JSON.stringify(f.state);
  assert.equal((await f.scheduled("801", firstAt)).outcome, "blocked_repair_recovery_observed");
  const ready = await f.scheduled("802", secondAt);
  assert.equal(ready.outcome, "blocked_repair_recovery_ready");
  assert.equal(ready.issue, 65);
  assert.deepEqual(
    ready.recovery.observations.map(({ runId }) => runId),
    ["801", "802"]
  );
  assert.equal(ready.recovery.repair.grantId, f.grant.id);
  assert.match(ready.nextAction, /Acknowledge recovered monitor incident/);
  assert.equal(f.registry.active, f.incident.id);
  assert.equal(f.issue.state, "open");
  assert.equal(JSON.stringify(f.state), original);
  assert.ok(f.calls.every(({ method }) => ["GET", "SAVE"].includes(method)));
});

test("fresh owner acknowledgment closes a terminal blocked repair as not planned and retains usage and exact recovery evidence", async () => {
  const f = blocked();
  f.state.version = 2;
  delete f.state.active;
  f.state.activeTickets = {};
  const ledger = JSON.stringify(f.state);
  await f.scheduled("801", firstAt);
  await f.scheduled("802", secondAt);
  const preview = await f.ownerAck();
  assert.equal(preview.outcome, "acknowledgment_preview");
  assert.equal(preview.scope, "feed-contract");
  assert.equal(f.issue.state, "open");
  const result = await f.ownerAck({ dryRun: false });
  assert.equal(result.outcome, "incident_acknowledged");
  assert.equal(result.reason, "observed-recovered-no-code-repair");
  assert.equal(f.issue.state_reason, "not_planned");
  assert.equal(f.registry.active, null);
  const closed = f.registry.incidents[f.incident.id];
  assert.equal(closed.acknowledgment.phase, "complete");
  assert.equal(closed.acknowledgment.blockedRecovery.repair.grantId, f.grant.id);
  assert.equal(closed.retirement, undefined);
  assert.equal(JSON.stringify(f.state), ledger);
});

test("owner cannot acknowledge a blocked repair with stale or failed evidence, an active grant, or any PR or branch", async () => {
  for (const next of [
    async () => {},
    async (f) => {
      f.invalidScheduledRun = 802;
      await f.scheduled("802", secondAt);
    },
    async (f) => {
      await f.scheduled("802", secondAt);
      f.pulls = [{ number: 112 }];
    },
    async (f) => {
      await f.scheduled("802", secondAt);
      f.branch = true;
    },
    async (f) => {
      await f.scheduled("802", secondAt);
      f.report.at = "2026-11-16T10:31:00.000Z";
      f.now = () => f.report.at;
    },
    async (f) => {
      await f.scheduled("802", secondAt);
      f.state.grants[f.grant.id].status = "reserved";
    },
    async (f) => {
      await f.scheduled("802", secondAt);
      await f.scheduled("803", "2026-11-16T09:02:00.000Z", {
        probe: async () => ({
          ...f.observation,
          healthy: false,
          checks: { ...f.observation.checks, health: "failed" },
        }),
      });
    },
    async (f) => {
      await f.scheduled("802", secondAt);
      await f.scheduled("803", "2026-11-16T09:02:00.000Z", {
        appChecks: undefined,
        probe: async () => ({
          ...f.observation,
          healthy: false,
          checks: { ...f.observation.checks, readiness: "failed" },
        }),
      });
    },
  ]) {
    const f = blocked();
    await f.scheduled("801", firstAt);
    await next(f);
    await assert.rejects(f.ownerAck({ dryRun: false }));
    assert.equal(f.issue.state, "open");
    assert.ok(!f.calls.some(({ method }) => method === "PATCH"));
  }
});

test("a failed prior scheduled attempt cannot corroborate the next scheduled observation", async () => {
  const f = blocked();
  await f.scheduled("801", firstAt);
  f.invalidScheduledRun = 801;
  const next = await f.scheduled("802", secondAt);
  assert.equal(next.outcome, "blocked_repair_recovery_observed");
  assert.deepEqual(
    next.recovery.observations.map(({ runId }) => runId),
    ["802"]
  );
});

test("a seven-hour schedule gap can corroborate the latest observation on the same release", async () => {
  const f = blocked();
  await f.scheduled("801", firstAt);
  const result = await f.scheduled("802", "2026-11-16T15:30:00.000Z");
  assert.equal(result.outcome, "blocked_repair_recovery_ready");
  f.report.at = "2026-11-16T15:36:00.000Z";
  f.now = () => f.report.at;
  assert.equal((await f.ownerAck()).outcome, "acknowledgment_preview");
});

test("a new owner run with fresh matching probes reconciles a lost blocked-repair close once", async () => {
  const f = blocked();
  await f.scheduled("801", firstAt);
  await f.scheduled("802", secondAt);
  f.failClose = true;
  await assert.rejects(f.ownerAck({ dryRun: false }));
  assert.equal(f.registry.active, f.incident.id);
  assert.equal(f.registry.incidents[f.incident.id].acknowledgment.phase, "intent");
  f.failClose = false;
  f.context.runId = "901";
  f.report.runId = "901";
  f.report.at = "2026-11-16T10:36:00.000Z";
  f.now = () => f.report.at;
  assert.equal((await f.ownerAck({ dryRun: false })).outcome, "incident_acknowledged");
  assert.equal(f.calls.filter(({ method }) => method === "PATCH").length, 1);
  assert.equal(f.registry.active, null);
});

test("unhealthy production after intent invalidates the pair until two new scheduled observations pass", async () => {
  const f = blocked();
  await f.scheduled("801", firstAt);
  await f.scheduled("802", secondAt);
  f.failClose = true;
  await assert.rejects(f.ownerAck({ dryRun: false }));
  f.failClose = false;
  await f.scheduled("803", "2026-11-16T09:30:00.000Z", {
    probe: async () => ({
      ...f.observation,
      healthy: false,
      checks: { ...f.observation.checks, health: "failed" },
    }),
  });
  f.context.runId = "901";
  f.report.runId = "901";
  f.report.at = "2026-11-16T09:35:00.000Z";
  f.now = () => f.report.at;
  await assert.rejects(f.ownerAck({ dryRun: false }));
  assert.equal(f.registry.active, f.incident.id);
  await f.scheduled("804", "2026-11-16T10:00:00.000Z");
  await f.scheduled("805", "2026-11-16T10:30:00.000Z");
  f.report.at = "2026-11-16T10:35:00.000Z";
  assert.equal((await f.ownerAck({ dryRun: false })).outcome, "incident_acknowledged");
  const ack = f.registry.incidents[f.incident.id].acknowledgment;
  assert.deepEqual(
    ack.blockedRecovery.observations.map(({ runId }) => runId),
    ["801", "802"]
  );
  assert.deepEqual(
    ack.verification.blockedRecovery.observations.map(({ runId }) => runId),
    ["804", "805"]
  );
  assert.equal(f.calls.filter(({ method }) => method === "PATCH").length, 1);
});
