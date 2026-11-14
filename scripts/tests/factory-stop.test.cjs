const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../factory/policy.cjs");
const { stopFactory, resumeFactory, AGENT_WORKFLOWS } = require("../factory/stop.cjs");
const { context, vars } = require("./helpers/factory-fixtures.cjs");
function fixture({
  stuck = false,
  cancellationError = false,
  variableWriteError = false,
  variableReadError = false,
  inventoryError = false,
} = {}) {
  let elapsed = 0;
  let state = policy.reserve(
    policy.emptyState(policy.REPOSITORY),
    context,
    policy.readConfig(vars)
  ).state;
  const before = structuredClone(state);
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
        return { workflow_runs: structuredClone(runs), total_count: runs.length };
      }
      const id = Number(url.match(/\/runs\/(\d+)/)?.[1]);
      if (method === "GET" && id) return structuredClone(runs.find((run) => run.id === id));
      if (method === "POST" && id) {
        if (cancellationError)
          throw Object.assign(new Error("private cancellation error"), { status: 409 });
        if (!stuck) runs.find((run) => run.id === id).status = "completed";
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
    get state() {
      return state;
    },
  };
}
test("stop preview is read-only and targets all agent parents, not deployments", async () => {
  const f = fixture();
  const result = await stopFactory(f.args);
  assert.equal(result.preview, true);
  assert.deepEqual(result.runIds, [100, 101]);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.state, f.before);
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
