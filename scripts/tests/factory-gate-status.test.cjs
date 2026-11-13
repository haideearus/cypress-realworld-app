const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { spawnSync } = require("node:child_process");
const yaml = require("js-yaml");
const { Controller } = require("../factory/controller.cjs");
const { GitHub, Ledger } = require("../factory/github.cjs");
const { readConfig, REPOSITORY } = require("../factory/policy.cjs");
const { FactoryFixture, vars, context } = require("./helpers/factory-fixtures.cjs");
const root = path.resolve(__dirname, "../..");
const workflow = path.join(root, ".github/workflows/factory-review-status.yml");

function loadWorkflow() {
  assert.ok(
    fs.existsSync(workflow),
    "a real pull-request gate job must publish the required status"
  );
  return yaml.load(fs.readFileSync(workflow, "utf8"));
}
function verifier() {
  const flow = loadWorkflow();
  const source = flow.jobs.gate.steps.find((s) => s.id === "verify").run;
  const match = source.match(/^node <<'NODE'\n([\s\S]+)\nNODE\s*$/);
  assert.ok(match, "the verifier must be the actual inline workflow entry");
  const filename = path.join(root, ".factory-inline-gate.cjs");
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(root);
  compiled._compile(match[1], filename);
  return compiled.exports.verify;
}
class GateFixture extends FactoryFixture {
  constructor() {
    super();
    this.gateRuns = [];
    this.refreshes = [];
    const baseFetch = this.fetch;
    this.fetch = async (url, options = {}) => {
      const u = new URL(url);
      const route = u.pathname.replace(`/repos/${REPOSITORY}`, "");
      const method = options.method || "GET";
      const respond = (status, data) =>
        new Response(data === null ? null : JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (method === "GET" && route === "/actions/workflows/factory-review-status.yml/runs") {
        this.onGateList?.();
        this.calls.push({ url: String(url), method });
        return respond(200, { workflow_runs: this.gateRuns });
      }
      if (method === "POST" && /^\/actions\/runs\/\d+\/rerun-failed-jobs$/.test(route)) {
        if (this.refuseRefresh) return respond(403, { message: "fixture refusal" });
        const id = Number(route.split("/")[3]);
        const run = this.gateRuns.find((r) => r.id === id);
        if (!run) return respond(404, {});
        this.refreshes.push({ id, method, route });
        run.status = "queued";
        run.run_attempt++;
        return respond(201, this.emptyRefreshResponse ? null : {});
      }
      const response = await baseFetch(url, options);
      if (this.patchPR && method === "GET" && route === "/pulls/30")
        return respond(200, this.patchPR(await response.json()));
      return response;
    };
  }
}
function run(overrides = {}) {
  return {
    id: 901,
    name: "Factory review status",
    path: ".github/workflows/factory-review-status.yml",
    event: "pull_request",
    head_sha: "d".repeat(40),
    status: "completed",
    conclusion: "failure",
    run_attempt: 1,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    pull_requests: [{ number: 30 }],
    ...overrides,
  };
}
async function setup(approved = true) {
  const fixture = new GateFixture();
  const api = new GitHub({ token: "fixture-only", fetch: fixture.fetch });
  const ledger = new Ledger(api);
  await ledger.initialize();
  fixture.branchHeads.set("agent/owner-gate", "d".repeat(40));
  fixture.prs.push({
    number: 30,
    branch: "agent/owner-gate",
    state: "open",
    user: { login: "haideearus" },
  });
  const controller = new Controller(api, readConfig(vars), context, {
    sleep: async () => {},
    maxPolls: 2,
  });
  if (approved) {
    const grant = await controller.admitPR(10, 30);
    const ci = await controller.ci(10);
    await controller.assessPR(10, { ci: "success", review: "success" }, ci.runId, grant.grantId, {
      kind: "review",
      grantId: grant.grantId,
      base: grant.head,
      result: { head: grant.head, verdict: "pass", summary: "Fixture review", findings: [] },
    });
  }
  const env = {
    GITHUB_REPOSITORY: REPOSITORY,
    FACTORY_PR: "30",
    FACTORY_HEAD: "d".repeat(40),
    FACTORY_ENABLED: "false",
  };
  return { fixture, api, ledger, controller, env };
}
function corrupt(fixture, mutate) {
  const commit = fixture.objects.get(fixture.head);
  const tree = fixture.objects.get(commit.tree);
  const blob = fixture.objects.get(tree.tree.find((f) => f.path === "state.json").sha);
  const state = JSON.parse(Buffer.from(blob.content, "base64"));
  mutate(state);
  blob.content = Buffer.from(JSON.stringify(state)).toString("base64");
}

test("required review status is a native pull-request job with trusted base code and no model credential", () => {
  const flow = loadWorkflow();
  assert.deepEqual(Object.keys(flow.on), ["pull_request"]);
  assert.deepEqual(flow.on.pull_request.branches, ["main"]);
  const job = flow.jobs.gate;
  assert.equal(job.name, "Factory review gate");
  assert.deepEqual(job.permissions, { contents: "read", "pull-requests": "read" });
  assert.equal(job["timeout-minutes"], 5);
  assert.equal(job.if, undefined, "the required job must not silently skip missing review proof");
  assert.notEqual(job["continue-on-error"], true);
  assert.notEqual(job.steps.find((s) => s.id === "verify")["continue-on-error"], true);
  const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ github.event.pull_request.base.sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  assert.doesNotMatch(JSON.stringify(flow), /secrets\.|CLAUDE|ANTHROPIC|OPENAI|workflow_dispatch/);
  for (const step of job.steps) if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
});
test("the actual native verifier passes genuine exact-head fixture proof while the factory is disabled without writes", async () => {
  const { api, ledger, fixture, env } = await setup();
  const before = fixture.head;
  const calls = fixture.calls.length;
  assert.equal((await verifier()(env, api)).ok, true);
  assert.equal(fixture.head, before);
  assert.ok(fixture.calls.slice(calls).every((c) => c.method === "GET"));
  assert.equal((await ledger.read()).state.tickets["10"].reviews, 1);
});
test("native verifier fails for missing approval and an unavailable ledger", async () => {
  const s = await setup(false);
  await assert.rejects(verifier()(s.env, s.api), /review/i);
  s.fixture.head = null;
  await assert.rejects(verifier()(s.env, s.api), /GitHub|ledger/i);
});
test("the exact stdin command really invokes the verifier and exits unsuccessfully without approval", async () => {
  for (const approved of [false, true]) {
    const s = await setup(approved);
    const source = loadWorkflow().jobs.gate.steps.find((step) => step.id === "verify").run;
    const inline = source.match(/^node <<'NODE'\n([\s\S]+)\nNODE\s*$/)[1];
    const snapshot = {
      head: s.fixture.head,
      objects: [...s.fixture.objects],
      branchHeads: [...s.fixture.branchHeads],
      prs: s.fixture.prs,
    };
    const preload = `const fixture = new (require('./scripts/tests/helpers/factory-fixtures.cjs').FactoryFixture)();
      const snapshot = ${JSON.stringify(snapshot)};
      fixture.head = snapshot.head; fixture.objects = new Map(snapshot.objects);
      fixture.branchHeads = new Map(snapshot.branchHeads); fixture.prs = snapshot.prs;
      global.fetch = fixture.fetch;\n`;
    const result = spawnSync(process.execPath, ["-"], {
      cwd: root,
      input: preload + inline,
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, ...s.env, GH_TOKEN: "fixture-only" },
    });
    assert.equal(result.status, approved ? 0 : 1, result.stderr);
    assert.match(approved ? result.stdout : result.stderr, /[Ii]ndependent.*review/);
  }
});
test("native verifier refuses stale, fake and failed approval or corrupt serialized state", async () => {
  for (const mutation of [
    (t) => {
      t.approval = null;
    },
    (t) => {
      t.approval.fixture = true;
    },
    (t) => {
      t.approval.source = "invented";
    },
    (t) => {
      t.approval.head = "e".repeat(40);
    },
    (t) => {
      t.approval.verdict = "changes_requested";
    },
    (t) => {
      t.reviews = 0;
    },
  ]) {
    const s = await setup();
    corrupt(s.fixture, (state) => mutation(state.tickets["10"]));
    await assert.rejects(verifier()(s.env, s.api), /review|state|ledger|count/i);
  }
});
test("native verifier refuses changed heads, closed PRs and events outside this fork", async () => {
  const s = await setup();
  const verify = verifier();
  await assert.rejects(verify({ ...s.env, FACTORY_HEAD: "e".repeat(40) }, s.api), /PR|head/i);
  await assert.rejects(verify({ ...s.env, FACTORY_PR: "invalid" }, s.api), /PR/i);
  await assert.rejects(verify({ ...s.env, GITHUB_REPOSITORY: "other/repo" }, s.api), /repository/i);
  s.fixture.patchPR = (pr) => ({ ...pr, head: { ...pr.head, repo: { full_name: "other/repo" } } });
  await assert.rejects(verify(s.env, s.api), /repository/i);
  s.fixture.patchPR = (pr) => ({ ...pr, base: { ref: "other" } });
  await assert.rejects(verify(s.env, s.api), /PR/i);
  s.fixture.patchPR = null;
  s.fixture.prs[0].state = "closed";
  await assert.rejects(verify(s.env, s.api), /PR/i);
});
test("controller publishes informational evidence and refreshes only the native failed gate without usage changes", async () => {
  const s = await setup();
  s.fixture.gateRuns.push(run());
  const before = s.fixture.head;
  const result = await s.controller.gate(30);
  assert.equal(result.ok, true);
  assert.equal(s.fixture.checks.at(-1).name, "Factory review evidence");
  assert.deepEqual(
    s.fixture.refreshes.map((r) => r.id),
    [901]
  );
  assert.equal(s.fixture.head, before);
  assert.equal(
    s.fixture.runs.length,
    1,
    "only the fixture's existing CI run exists; refresh must not dispatch CI or agents"
  );
  await s.controller.gate(30);
  assert.equal(s.fixture.refreshes.length, 1, "a queued refresh must not be repeated");
});
test("no native gate refresh is possible without current-head genuine approval", async () => {
  const s = await setup(false);
  s.fixture.gateRuns.push(run());
  assert.equal((await s.controller.gate(30)).ok, false);
  assert.deepEqual(s.fixture.refreshes, []);
});
test("an accepted gate refresh may return an empty HTTP 201 body", async () => {
  const s = await setup();
  s.fixture.gateRuns.push(run());
  s.fixture.emptyRefreshResponse = true;
  assert.equal((await s.controller.gate(30)).gateRefreshed, true);
  assert.deepEqual(
    s.fixture.refreshes.map((r) => r.id),
    [901]
  );
});
test("refresh refuses wrong workflow, trigger, repository, head, PR, cancellation and repeated attempts", async () => {
  for (const change of [
    { path: ".github/workflows/factory-agents.yml" },
    { event: "workflow_dispatch" },
    { head_sha: "e".repeat(40) },
    { pull_requests: [{ number: 31 }] },
    { pull_requests: [] },
    { repository: { full_name: "other/repo" } },
    { head_repository: { full_name: "other/repo" } },
    { status: "in_progress" },
    { conclusion: "cancelled" },
    { conclusion: "success" },
    { run_attempt: 2 },
    { id: "901" },
  ]) {
    const s = await setup();
    s.fixture.gateRuns.push(run(change));
    await s.controller.gate(30);
    assert.deepEqual(s.fixture.refreshes, [], JSON.stringify(change));
  }
});
test("refresh never revives an older failed run after a newer matching run passed", async () => {
  const s = await setup();
  s.fixture.gateRuns.push(run(), run({ id: 902, conclusion: "success" }));
  await s.controller.gate(30);
  assert.deepEqual(s.fixture.refreshes, []);
});
test("refresh rechecks PR identity before the fixed write and does not hide API refusal", async () => {
  const changed = await setup();
  changed.fixture.gateRuns.push(run());
  changed.fixture.onGateList = () => {
    changed.fixture.prHeadOverride = "e".repeat(40);
  };
  await assert.rejects(changed.controller.gate(30), /head|PR/i);
  assert.deepEqual(changed.fixture.refreshes, []);
  const denied = await setup();
  denied.fixture.gateRuns.push(run());
  denied.fixture.refuseRefresh = true;
  await assert.rejects(denied.controller.gate(30), /403/);
  assert.deepEqual(denied.fixture.refreshes, []);
});
test("only trusted metadata jobs can request the deterministic native refresh", () => {
  for (const file of ["factory-pr-review.yml", "factory-cycle.yml"]) {
    const flow = yaml.load(fs.readFileSync(path.join(root, ".github/workflows", file), "utf8"));
    assert.equal(flow.jobs.assess.permissions.actions, "write");
    assert.equal(flow.jobs.review.permissions.contents, "read");
  }
  const wrapper = yaml.load(
    fs.readFileSync(path.join(root, ".github/workflows/factory-review-gate.yml"), "utf8")
  );
  assert.equal(wrapper.jobs.gate.permissions.actions, "write");
});
