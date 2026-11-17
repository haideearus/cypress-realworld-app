const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../factory/policy.cjs");
const { stopFactory, resumeFactory, AGENT_WORKFLOWS } = require("../factory/stop.cjs");
const { context, vars } = require("./helpers/factory-fixtures.cjs");
const evidence = require("../../docs/factory/evidence/stale-run-43467058965/evidence.json");
function fixture({
  stuck = false,
  cancellationError = false,
  variableWriteError = false,
  variableReadError = false,
  inventoryError = false,
  quarantined = false,
  two = false,
  partial = false,
  omitSecond = false,
} = {}) {
  let elapsed = 0;
  let state = policy.reserve(
    policy.emptyState(policy.REPOSITORY),
    context,
    policy.readConfig(vars)
  ).state;
  if (two) {
    state.version = 2;
    state.activeTickets = { [state.active.ticket]: state.active };
    delete state.active;
    state = policy.reserve(
      state,
      { ...context, ticket: 11, runId: "101" },
      { ...policy.readConfig(vars), concurrent: 2 }
    ).state;
  }
  if (quarantined) {
    state.tickets[38] = structuredClone(evidence.sentinel.ticket);
    Object.assign(state.grants, structuredClone(evidence.sentinel.grants));
    state.days["2026-11-14"] = [38];
    policy.validateState(state);
  }
  const before = structuredClone(state);
  const facts = structuredClone(evidence);
  const switches = {
    FACTORY_ENABLED: "true",
    FACTORY_AUTOMATION_ENABLED: "false",
    FACTORY_AUTOMERGE_ENABLED: "true",
  };
  const runs = [
    {
      id: 100,
      path: ".github/workflows/factory-agents.yml",
      status: "in_progress",
      run_attempt: 1,
    },
    { id: 101, path: ".github/workflows/factory-automatic.yml", status: "queued", run_attempt: 1 },
    { id: 102, path: ".github/workflows/factory-deploy.yml", status: "waiting", run_attempt: 1 },
  ];
  const writes = [];
  if (quarantined)
    runs.push({
      ...facts.run,
      repository: { full_name: policy.REPOSITORY },
      actor: { login: policy.OWNER },
      triggering_actor: { login: policy.OWNER },
    });
  const ledger = {
    async read() {
      return { state: structuredClone(state) };
    },
    async update(fn) {
      const next = await fn(structuredClone(state));
      policy.validateState(next.state);
      state = structuredClone(next.state);
      writes.push({ method: "LEDGER", stop: state.stop?.id });
      return next;
    },
  };
  const api = {
    async request(method, url, body) {
      if (method !== "GET") writes.push({ method, url, body });
      if (method === "GET" && url.includes("/actions/variables")) {
        if (variableReadError && state.stop) throw new Error("private variable error");
        return {
          variables: Object.entries(switches).map(([name, value]) => ({ name, value })),
          total_count: 3,
        };
      }
      if (method === "PATCH" && url.includes("/actions/variables/")) {
        if (variableWriteError) throw new Error("private variable error");
        switches[url.split("/").pop()] = body.value;
        return null;
      }
      if (method === "GET" && url.includes("/actions/runs?")) {
        if (inventoryError) throw new Error("private inventory error");
        const listed = runs.filter((run) => !omitSecond || run.id !== 101);
        return { workflow_runs: structuredClone(listed), total_count: listed.length };
      }
      if (method === "GET" && quarantined) {
        if (url.includes(`/runs/${evidence.run.id}/jobs?`)) return facts.jobs;
        if (url.endsWith(`/runs/${evidence.run.id}/artifacts?per_page=100`)) return facts.artifacts;
        if (url.endsWith(`/runs/${evidence.run.id}/pending_deployments`))
          return facts.pendingDeployments;
        if (url.endsWith(`/check-suites/${evidence.run.check_suite_id}`)) return facts.checkSuite;
        if (url.endsWith(`/check-suites/${evidence.run.check_suite_id}/check-runs?per_page=100`))
          return facts.checkRuns;
      }
      const id = Number(url.match(/\/runs\/(\d+)/)?.[1]);
      if (method === "GET" && id) return structuredClone(runs.find((run) => run.id === id));
      if (method === "POST" && id) {
        if (cancellationError)
          throw Object.assign(new Error("private cancellation error"), { status: 409 });
        if (!stuck && !(partial && id === 101))
          runs.find((run) => run.id === id).status = "completed";
        return {};
      }
      throw new Error(`Unexpected ${method} ${url}`);
    },
  };
  return {
    args: {
      api,
      ledger,
      actor: policy.OWNER,
      clock: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    },
    before,
    writes,
    switches,
    runs,
    facts,
    get state() {
      return state;
    },
  };
}
test("two-parent stop cancels both, including an omitted inventory parent, preserving quarantine and counters", async () => {
  const f = fixture({ two: true, omitSecond: true, quarantined: true });
  const result = await stopFactory({ ...f.args, execute: true });
  assert.equal(result.stopped, true);
  assert.deepEqual(f.state.activeTickets, {});
  assert.deepEqual(f.state.days, f.before.days);
  assert.deepEqual(f.state.tickets[38], f.before.tickets[38]);
  assert.equal(Object.values(f.state.grants).filter((g) => g.status === "reserved").length, 0);
  assert.equal(result.pendingRunIds.length, 0);
});
test("partial two-parent stop keeps B reserved and cannot resume", async () => {
  const f = fixture({ two: true, partial: true });
  const result = await stopFactory({ ...f.args, execute: true });
  assert.equal(result.stopped, false);
  assert.ok(f.state.stop);
  assert.ok(f.state.activeTickets["11"]);
  assert.equal(Object.values(f.state.grants).find((g) => g.ticket === 11).status, "reserved");
  await assert.rejects(resumeFactory({ ...f.args, execute: true }), /active|running/i);
});
test("stop preview is read-only and targets all agent parents, not deployments", async () => {
  const f = fixture();
  const result = await stopFactory(f.args);
  assert.equal(result.preview, true);
  assert.deepEqual(result.runIds, [100, 101]);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.state, f.before);
});
test("known contained queued record is explicit in preview and never called terminal", async () => {
  const f = fixture({ quarantined: true });
  const result = await stopFactory(f.args);
  assert.deepEqual(result.runIds, [100, 101]);
  assert.deepEqual(result.quarantinedRunIds, [evidence.run.id]);
  assert.equal(result.quarantinedRuns[0].status, "queued");
  assert.equal(f.writes.length, 0);
});
test("stop and resume preserve the contained record and all history without cancelling or refunding it", async () => {
  const f = fixture({ quarantined: true });
  const result = await stopFactory({ ...f.args, execute: true });
  assert.equal(result.stopped, true);
  assert.deepEqual(result.terminalRunIds, [100, 101]);
  assert.deepEqual(result.quarantinedRunIds, [evidence.run.id]);
  assert.equal(f.runs.find((run) => run.id === evidence.run.id).status, "queued");
  assert.ok(!f.writes.some((w) => w.method === "POST" && w.url.includes(String(evidence.run.id))));
  assert.deepEqual(f.state.days, f.before.days);
  assert.deepEqual(f.state.tickets[38], f.before.tickets[38]);
  assert.deepEqual(f.state.audit.at(-1).quarantinedRunIds, [evidence.run.id]);
  const resumed = await resumeFactory({ ...f.args, execute: true });
  assert.equal(resumed.resumed, true);
  assert.deepEqual(resumed.quarantinedRunIds, [evidence.run.id]);
  assert.deepEqual(f.state.audit.at(-1).quarantinedRunIds, [evidence.run.id]);
});
test("resume rechecks quarantine and cannot release the stop after jobs appear", async () => {
  const f = fixture({ quarantined: true });
  assert.equal((await stopFactory({ ...f.args, execute: true })).stopped, true);
  f.facts.jobs = { total_count: 1, jobs: [{ id: 500, status: "queued" }] };
  const before = f.writes.length;
  await assert.rejects(
    () => resumeFactory({ ...f.args, execute: true }),
    /active|running|terminal/i
  );
  assert.equal(f.writes.length, before);
  assert.ok(f.state.stop);
});
test("changed containment falls back to ordinary cancellation and retains an unresolved stop", async () => {
  const f = fixture({ quarantined: true, stuck: true, cancellationError: true });
  f.facts.checkRuns = { total_count: 1, check_runs: [{ id: 501 }] };
  const result = await stopFactory({ ...f.args, execute: true });
  assert.equal(result.stopped, false);
  assert.deepEqual(result.quarantinedRunIds, []);
  assert.ok(result.pendingRunIds.includes(evidence.run.id));
  assert.ok(
    f.writes.some((w) => w.method === "POST" && w.url.endsWith(`/${evidence.run.id}/cancel`))
  );
  assert.ok(f.state.stop);
});
test("a quarantine exemption is rechecked while another agent is still stopping", async () => {
  const f = fixture({ quarantined: true, stuck: true, cancellationError: true });
  const sleep = f.args.sleep;
  f.args.sleep = async (ms) => {
    await sleep(ms);
    f.facts.jobs = { total_count: 1, jobs: [{ id: 501 }] };
  };
  const result = await stopFactory({ ...f.args, execute: true });
  assert.equal(result.stopped, false);
  assert.deepEqual(result.quarantinedRunIds, []);
  assert.ok(result.pendingRunIds.includes(evidence.run.id));
  assert.ok(
    f.writes.some((w) => w.method === "POST" && w.url.endsWith(`/${evidence.run.id}/force-cancel`))
  );
});
test("quarantine cannot acknowledge a stop if the retained containment changes before settlement", async () => {
  const f = fixture({ quarantined: true });
  const update = f.args.ledger.update.bind(f.args.ledger);
  f.args.ledger.update = (fn) =>
    update(async (state) => {
      if (state.stop) {
        // This remains valid current history, but no longer proves this completed drill.
        state.tickets[38].status = "blocked";
        Object.values(state.grants).find((g) => g.ticket === 38).outcome = "blocked";
      }
      return fn(state);
    });
  const result = await stopFactory({ ...f.args, execute: true });
  assert.equal(result.stopped, false);
  assert.deepEqual(result.quarantinedRunIds, []);
  assert.ok(result.pendingRunIds.includes(evidence.run.id));
  assert.ok(f.state.stop);
  assert.ok(f.state.active);
});
test("resume checks again after switch acknowledgement and retains its marker on changed facts", async () => {
  const f = fixture({ quarantined: true });
  await stopFactory({ ...f.args, execute: true });
  const request = f.args.api.request.bind(f.args.api);
  f.args.api.request = async (method, url, body) => {
    const value = await request(method, url, body);
    if (method === "PATCH") f.facts.jobs = { total_count: 1, jobs: [{ id: 502 }] };
    return value;
  };
  await assert.rejects(() => resumeFactory({ ...f.args, execute: true }), /running|changed/i);
  assert.ok(f.state.stop);
});
test("one executed command stops admissions and all agents while preserving counters", async () => {
  const f = fixture();
  const result = await stopFactory({ ...f.args, execute: true });
  assert.equal(result.stopped, true);
  assert.equal(result.withinMinute, true);
  assert.ok(f.state.stop);
  assert.ok(f.writes[0].stop);
  assert.equal(f.state.active, null);
  assert.deepEqual(f.state.days, f.before.days);
  assert.equal(f.state.tickets[10].coding, 1);
  assert.equal(f.state.tickets[10].status, "blocked");
  assert.deepEqual(Object.values(f.switches), ["false", "false", "false"]);
  assert.equal(f.runs[2].status, "waiting");
  assert.throws(
    () =>
      policy.reserve(f.state, { ...context, runId: "200", ticket: 20 }, policy.readConfig(vars)),
    /stopped/i
  );
  assert.throws(
    () =>
      policy.preflight(f.state, Object.keys(f.before.grants)[0], context, policy.readConfig(vars)),
    /stopped/i
  );
});
test("cancellation errors and stuck sessions report incomplete and retain the active lock", async () => {
  for (const options of [{ stuck: true }, { cancellationError: true }]) {
    const f = fixture(options);
    const result = await stopFactory({ ...f.args, execute: true });
    assert.equal(result.stopped, false);
    assert.ok(result.elapsedMs <= 55000);
    assert.ok(f.state.stop);
    assert.equal(f.state.active.ticket, 10);
    assert.equal(Object.values(f.state.grants)[0].status, "reserved");
    assert.equal(JSON.stringify(result).includes("private cancellation error"), false);
  }
});

test("switch outages cannot skip cancellation and cannot produce a false stop acknowledgement", async () => {
  for (const options of [{ variableWriteError: true }, { variableReadError: true }]) {
    const f = fixture(options);
    const result = await stopFactory({ ...f.args, execute: true });
    assert.equal(result.stopped, false);
    assert.ok(f.state.stop);
    assert.ok(
      f.writes.some((write) => write.method === "POST" && write.url.endsWith("/100/cancel"))
    );
    assert.equal(f.runs[0].status, "completed");
    assert.equal(JSON.stringify(result).includes("private variable error"), false);
  }
});

test("inventory outages retain the stop marker and still cancel the known active reservation", async () => {
  const f = fixture({ inventoryError: true });
  const result = await stopFactory({ ...f.args, execute: true });
  assert.equal(result.stopped, false);
  assert.ok(f.state.stop);
  assert.ok(f.writes.some((write) => write.method === "POST" && write.url.endsWith("/100/cancel")));
  assert.deepEqual(f.state.days, f.before.days);
});
test("resume is explicit, checks stopped runs, and restores only the recorded switches", async () => {
  const f = fixture();
  await stopFactory({ ...f.args, execute: true });
  const writes = f.writes.length;
  assert.equal((await resumeFactory(f.args)).preview, true);
  assert.equal(f.writes.length, writes);
  const result = await resumeFactory({ ...f.args, execute: true });
  assert.equal(result.resumed, true);
  assert.equal(f.state.stop, undefined);
  assert.deepEqual(f.switches, {
    FACTORY_ENABLED: "true",
    FACTORY_AUTOMATION_ENABLED: "false",
    FACTORY_AUTOMERGE_ENABLED: "true",
  });
  assert.deepEqual(f.state.days, f.before.days);
});
test("resuming an unresolved stop or using another actor cannot enable anything", async () => {
  const f = fixture({ stuck: true });
  await stopFactory({ ...f.args, execute: true });
  await assert.rejects(
    () => resumeFactory({ ...f.args, execute: true }),
    /active|running|terminal/i
  );
  const g = fixture();
  await assert.rejects(
    () => stopFactory({ ...g.args, actor: "stranger", execute: true }),
    /owner|actor/i
  );
  assert.equal(g.writes.length, 0);
});
test("stop marker validation rejects forged metadata and policy refuses normal publication outcomes", async () => {
  const f = fixture();
  await stopFactory({ ...f.args, execute: true });
  const malformed = structuredClone(f.state);
  malformed.stop.actor = "stranger";
  assert.throws(() => policy.validateState(malformed), /stop/i);
  const g = fixture({ stuck: true });
  await stopFactory({ ...g.args, execute: true });
  const id = Object.keys(g.state.grants)[0];
  assert.throws(() => policy.finish(g.state, id, { status: "awaiting_review" }), /stopped/i);
  assert.ok(AGENT_WORKFLOWS.includes(".github/workflows/factory-monitor-drill.yml"));
});

test("durable stop blocks publication, automatic pickup, merge and live drill admission with stale enabled variables", async () => {
  const f = fixture({ stuck: true });
  await stopFactory({ ...f.args, execute: true });
  const config = { ...policy.readConfig(vars), automatic: true, autoMerge: true };
  const { Controller } = require("../factory/controller.cjs");
  const publisher = new Controller(f.args.api, config, context);
  publisher.ledger = f.args.ledger;
  const writes = f.writes.length;
  await assert.rejects(() => publisher.publish(Object.keys(f.state.grants)[0], {}), /stopped/i);
  const { AutomaticCoordinator } = require("../factory/automation.cjs");
  const automatic = {
    ...context,
    workflowRef: policy.AUTOMATIC_WORKFLOW_REF,
    workflowSha: "b".repeat(40),
  };
  const coordinator = new AutomaticCoordinator(f.args.api, config, automatic);
  coordinator.ledger = f.args.ledger;
  assert.match((await coordinator.pick()).reason, /stopped/i);
  const { AutomaticMerger } = require("../factory/merge.cjs");
  assert.throws(
    () => new AutomaticMerger(f.args.api, config, automatic).stateTicket(f.state, 10),
    /stopped/i
  );
  const { DrillCoordinator } = require("../factory/monitor-drill.cjs");
  assert.throws(
    () => DrillCoordinator.prototype.available.call({ config }, f.state, new Date().toISOString()),
    /stopped/i
  );
  assert.equal(f.writes.length, writes);
});

test("all workflows capable of a subscription invocation are inventoried by the direct stop", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const yaml = require("js-yaml");
  const directory = path.resolve(__dirname, "../../.github/workflows");
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith(".yml"))) {
    const flow = yaml.load(fs.readFileSync(path.join(directory, file), "utf8"));
    const invokes = Object.values(flow.jobs || {}).some(
      (job) =>
        /factory-(?:cycle|model|pr-review)\.yml/.test(job.uses || "") ||
        (job.steps || []).some((step) => step.uses?.startsWith("anthropics/claude-code-action@"))
    );
    if (invokes)
      assert.ok(
        AGENT_WORKFLOWS.includes(`.github/workflows/${file}`),
        `${file} missing from stop inventory`
      );
  }
});
