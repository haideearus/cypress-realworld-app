const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const policy = require("../factory/policy.cjs");
const worker = require("../factory/worker.cjs");
const { Controller, criteriaHash } = require("../factory/controller.cjs");
const { GitHub, Ledger, ROOT } = require("../factory/github.cjs");
const { vars, context, FactoryFixture } = require("./helpers/factory-fixtures.cjs");
const workflowRef =
  "haideearus/cypress-realworld-app/.github/workflows/factory-monitor-drill.yml@refs/heads/main";
const workflowSha = "b".repeat(40);
const incidentId = "12345678-1234-4123-8123-123456789abc";
const now = new Date("2026-11-14T10:00:00.000Z");
const config = policy.readConfig(vars);
function request(overrides = {}) {
  const input = {
    ...context,
    workflowRef,
    workflowSha,
    slot: "drill",
    origin: "drill",
    ...overrides,
  };
  input.drill = overrides.drill || {
    runId: input.runId,
    runAttempt: input.runAttempt,
    workflowRef: input.workflowRef,
    workflowSha: input.workflowSha,
    seedSha: input.head,
    incidentId,
  };
  return input;
}
const fresh = () => policy.emptyState(policy.REPOSITORY);
const reserve = () => policy.reserve(fresh(), request(), config, now);

test("drill reservation consumes one normal daily ticket and exactly one coding grant", () => {
  const { state, grant } = reserve();
  assert.deepEqual(state.days, { "2026-11-14": [10] });
  assert.deepEqual(state.tickets[10], {
    origin: "drill",
    coding: 1,
    reviews: 0,
    retries: 0,
    head: context.head,
    status: "coding",
    pr: null,
    approval: null,
    drill: request().drill,
  });
  assert.equal(grant.slot, "drill");
  assert.doesNotThrow(() => policy.validateState(state));
  assert.doesNotThrow(() => policy.preflight(state, grant.id, request(), config));
});

test("drill rejects altered workflow identity, owner, first attempt, grant and provenance", () => {
  for (const change of [
    { actor: "outsider" },
    { triggeringActor: "outsider" },
    { repository: "outsider/app" },
    { ref: "refs/heads/other" },
    { event: "schedule" },
    { runAttempt: 2 },
    { workflowRef: `${policy.REPOSITORY}/.github/workflows/factory-agents.yml@refs/heads/main` },
    { workflowSha: "invalid" },
    { slot: "cycle1" },
    { phase: "review" },
    { pr: 20 },
    { recovery: "other" },
    { drill: { ...request().drill, seedSha: "c".repeat(40) } },
    { drill: { ...request().drill, runId: "101" } },
    { drill: { ...request().drill, extra: true } },
  ])
    assert.throws(() => policy.reserve(fresh(), request(change), config, now));
  for (const change of [{ automatic: true }, { autoMerge: true }, { coding: 0 }, { daily: 0 }])
    assert.throws(() => policy.reserve(fresh(), request(), { ...config, ...change }, now));
});

test("drill cannot reserve again, move to another issue in the same run or become ordinary work", () => {
  const { state, grant } = reserve();
  const blocked = policy.finish(state, grant.id, { status: "blocked" }, now);
  for (const input of [
    request(),
    request({ runId: "101" }),
    context,
    { ...context, phase: "review", origin: "owner-pr", pr: 20 },
    request({ ticket: 11 }),
  ])
    assert.throws(() => policy.reserve(blocked, input, config, now), /drill|origin|reservation/i);
  const normal = policy.reserve(fresh(), context, config, now);
  const normalBlocked = policy.finish(normal.state, normal.grant.id, { status: "blocked" }, now);
  assert.throws(() => policy.reserve(normalBlocked, request(), config, now), /drill|origin/i);
});

test("drill preflight requires its actual workflow, seed, first attempt and disabled automation", () => {
  const { state, grant } = reserve();
  for (const change of [
    { workflowRef: undefined },
    { workflowSha: "c".repeat(40) },
    { runId: "101" },
    { runAttempt: 2 },
    { head: "c".repeat(40) },
    { slot: "cycle1" },
    { event: "schedule" },
  ])
    assert.throws(() => policy.preflight(state, grant.id, { ...request(), ...change }, config));
  for (const change of [{ automatic: true }, { autoMerge: true }, { enabled: false }])
    assert.throws(() => policy.preflight(state, grant.id, request(), { ...config, ...change }));
  const normal = policy.reserve(fresh(), context, config, now);
  assert.throws(() =>
    policy.preflight(normal.state, normal.grant.id, request({ slot: "cycle1" }), config)
  );
});

test("drill completion clears its lock with no review, PR, approval or changed seed", () => {
  const { state, grant } = reserve();
  const complete = policy.finish(state, grant.id, { status: "drill_complete" }, now);
  assert.equal(complete.active, null);
  assert.equal(complete.tickets[10].status, "drill_complete");
  assert.equal(complete.tickets[10].pr, null);
  assert.equal(complete.tickets[10].approval, null);
  assert.equal(complete.grants[grant.id].outcome, "drill_complete");
  assert.doesNotThrow(() => policy.validateState(complete));
  assert.equal(policy.reviewGate(complete, { number: 20, head: context.head }).ok, false);
  for (const outcome of [
    { status: "reviewed" },
    { status: "retry" },
    { status: "awaiting_review" },
    { status: "drill_complete", head: "c".repeat(40) },
    { status: "drill_complete", pr: 20 },
    { status: "drill_complete", approval: {} },
    { status: "drill_complete", verdict: "pass" },
  ])
    assert.throws(() => policy.finish(state, grant.id, outcome, now));
  const normal = policy.reserve(fresh(), context, config, now);
  assert.throws(() =>
    policy.finish(normal.state, normal.grant.id, { status: "drill_complete" }, now)
  );
});

test("ledger validation rejects forged drill review fields and every provenance/head mismatch", () => {
  const { state, grant } = reserve();
  for (const change of [
    { pr: 20 },
    { approval: {} },
    { reviews: 1 },
    { retries: 1 },
    { coding: 2 },
    { automatic: {} },
    { monitor: {} },
    { merge: {} },
    { status: "reviewed" },
    { head: "c".repeat(40) },
    { drill: { ...request().drill, seedSha: "c".repeat(40) } },
    { drill: undefined },
    { origin: "factory" },
  ]) {
    const forged = structuredClone(state);
    Object.assign(forged.tickets[10], change);
    assert.throws(() => policy.validateState(forged));
    assert.equal(policy.reviewGate(forged, { number: 20, head: context.head }).ok, false);
  }
  for (const change of [
    { slot: "cycle1" },
    { head: "c".repeat(40) },
    { runId: "101" },
    { runAttempt: 2 },
    { phase: "review" },
  ]) {
    const forged = structuredClone(state);
    Object.assign(forged.grants[grant.id], change);
    assert.throws(() => policy.validateState(forged));
  }
  const fakeComplete = structuredClone(state);
  fakeComplete.tickets[10].status = "drill_complete";
  assert.throws(() => policy.validateState(fakeComplete));
});

async function setup() {
  const fixture = new FactoryFixture();
  const api = new GitHub({ token: "fixture-only", fetch: fixture.fetch });
  const ledger = new Ledger(api);
  await ledger.initialize();
  fixture.branchHeads.set("agent/owner", context.head);
  fixture.prs.push({
    number: 30,
    branch: "agent/owner",
    state: "open",
    user: { login: policy.OWNER },
  });
  return { fixture, api, ledger, controller: new Controller(api, config, context) };
}

test("ordinary issue and owner PR admission reject drill labels or titles before spending allowance", async () => {
  for (const change of [
    { title: "[DRILL] Readiness failed" },
    { labels: ["factory-drill", "factory-ready"] },
    { labels: [{ name: "factory-drill" }] },
  ]) {
    const { fixture, ledger, controller } = await setup();
    Object.assign(fixture.issues.get(10), change);
    await assert.rejects(controller.admit(10), /drill/i);
    await assert.rejects(controller.admitPR(10, 30), /drill/i);
    assert.deepEqual((await ledger.read()).state.days, {});
  }
});

test("drill registry receipt blocks admission after title, labels and criteria are replaced", async () => {
  const { fixture, ledger, api, controller } = await setup();
  const incident = {
    id: incidentId,
    at: now.toISOString(),
    day: "2026-11-14",
    phase: "open",
    recovered: false,
    source: { runId: "100", runAttempt: 1, workflowSha },
    criteriaHash: "d".repeat(64),
    issue: 10,
  };
  const registry = {
    version: 1,
    repository: policy.REPOSITORY,
    active: incidentId,
    incidents: { [incidentId]: incident },
  };
  const transport = api.fetch;
  api.fetch = async (url, options) => {
    const u = new URL(url);
    if (u.pathname === `${ROOT}/git/ref/heads/factory/monitor-drill`)
      return new Response(JSON.stringify({ object: { sha: workflowSha } }), { status: 200 });
    if (u.pathname === `${ROOT}/contents/monitor.json` && u.searchParams.get("ref") === workflowSha)
      return new Response(
        JSON.stringify({
          type: "file",
          encoding: "base64",
          content: Buffer.from(JSON.stringify(registry)).toString("base64"),
        }),
        { status: 200 }
      );
    return transport(url, options);
  };
  Object.assign(fixture.issues.get(10), {
    title: "Ordinary maintenance",
    body: "Replacement criteria",
    labels: ["factory-ready"],
  });
  await assert.rejects(controller.admit(10), /drill/i);
  await assert.rejects(controller.admitPR(10, 30), /drill/i);
  assert.deepEqual((await ledger.read()).state.days, {});
});

test("ordinary publisher rejects a valid drill grant before creating any branch, blob or PR", async () => {
  const { api, fixture, ledger } = await setup();
  const saved = await ledger.update((state) => policy.reserve(state, request(), config, now));
  const controller = new Controller(api, config, request());
  const callCount = fixture.calls.length;
  await assert.rejects(
    controller.publish(saved.grant.id, {
      kind: "code",
      grantId: saved.grant.id,
      base: context.head,
      files: [
        {
          path: "backend/factory-drill/readiness.cjs",
          mode: "100644",
          content: "module.exports = true;\n",
        },
      ],
      evidence: "No commands executed; trusted verification is pending.",
    }),
    /drill/i
  );
  assert.equal(fixture.prs.length, 1);
  assert.ok(fixture.calls.slice(callCount).every((call) => call.method === "GET"));
});

test("drill cancellation waits for the originating run and retains consumed counters", async () => {
  const { api, fixture, ledger } = await setup();
  const saved = await ledger.update((state) => policy.reserve(state, request(), config, now));
  fixture.activeRunStatus = "in_progress";
  const controller = new Controller(
    api,
    config,
    { ...context, runId: "101" },
    { sleep: async () => {} }
  );
  assert.deepEqual(await controller.cancel(), { canceled: true, ticket: 10 });
  const { state } = await ledger.read();
  assert.equal(state.active, null);
  assert.equal(state.tickets[10].status, "blocked");
  assert.equal(state.tickets[10].coding, 1);
  assert.equal(state.tickets[10].reviews, 0);
  assert.equal(state.tickets[10].retries, 0);
  assert.equal(state.tickets[10].approval, null);
  assert.equal(state.grants[saved.grant.id].outcome, "blocked");
  assert.throws(() => policy.reserve(state, request({ runId: "102" }), config, now), /drill/i);
});

test("unavailable drill receipt storage blocks ordinary admission without spending allowance", async () => {
  const { api, ledger, controller } = await setup();
  const transport = api.fetch;
  api.fetch = async (url, options) => {
    if (new URL(url).pathname === `${ROOT}/git/ref/heads/factory/monitor-drill`)
      return new Response("{}", { status: 503 });
    return transport(url, options);
  };
  await assert.rejects(controller.admit(10), /503/);
  await assert.rejects(controller.admitPR(10, 30), /503/);
  assert.deepEqual((await ledger.read()).state.tickets, {});
});

function repo(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "factory-drill-worker-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(cwd)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(cwd).startsWith("factory-drill-worker-"));
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.name", "Factory Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(cwd, "fixture.txt"), "synthetic fixture\n");
  git("add", ".");
  git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "Fixture", "--no-gpg-sign");
  return { cwd, head: git("rev-parse", "HEAD") };
}

test("verified drill worker exposes only read/edit tools and delegates all command evidence", async (t) => {
  const app = repo(t);
  const { fixture, api, ledger } = await setup();
  const ctx = request({ head: app.head });
  const saved = await ledger.update((state) => {
    const result = policy.reserve(state, ctx, config, now);
    result.state.tickets[10].criteriaHash = criteriaHash(fixture.issues.get(10));
    return result;
  });
  const prepared = await worker.prepare(api, config, ctx, {
    grantId: saved.grant.id,
    cwd: app.cwd,
    environment: {},
    drill: false,
  });
  assert.match(prepared.claudeArgs, /--tools "Read,Glob,Grep,Edit,Write"/);
  const allowedTools = prepared.claudeArgs.match(/--allowedTools "([^"]+)"/)[1].split(",");
  assert.deepEqual(allowedTools, [
    "Read",
    "Glob",
    "Grep",
    "Edit(/backend/factory-drill/readiness.cjs)",
    "Edit(/.factory-output/evidence.md)",
  ]);
  assert.ok(!allowedTools.includes("Edit") && !allowedTools.includes("Write"));
  for (const name of ["Bash", "PowerShell", "Agent", "Task", "WebFetch", "WebSearch", "mcp__*"])
    assert.ok(
      prepared.claudeArgs
        .match(/--disallowedTools "([^"]+)"/)[1]
        .split(",")
        .includes(name)
    );
  const input = JSON.parse(
    fs.readFileSync(path.join(app.cwd, ".factory-input/context.json"), "utf8")
  );
  assert.deepEqual(input.capabilities.shellCommands, []);
  assert.deepEqual(input.capabilities.editablePaths, ["backend/factory-drill/readiness.cjs"]);
  assert.match(JSON.parse(prepared.promptJson), /src\/__tests__\/factory-drill-readiness.test.ts/);
  assert.match(JSON.parse(prepared.promptJson), /No commands executed/);
  assert.doesNotMatch(JSON.parse(prepared.promptJson), /bare Bash call/);
});

test("caller drill flags cannot change ordinary worker capabilities", async (t) => {
  const app = repo(t);
  const { fixture, api, ledger } = await setup();
  const ctx = { ...context, head: app.head };
  const saved = await ledger.update((state) => {
    const result = policy.reserve(state, ctx, config, now);
    result.state.tickets[10].criteriaHash = criteriaHash(fixture.issues.get(10));
    return result;
  });
  const prepared = await worker.prepare(
    api,
    config,
    { ...ctx, drill: true },
    { grantId: saved.grant.id, cwd: app.cwd, environment: {}, drill: true }
  );
  assert.match(prepared.claudeArgs, /--tools "Read,Glob,Grep,Edit,Write,Bash"/);
});

const drillFixture = require("../factory/drill-fixture.cjs");
const implementationPath = "backend/factory-drill/readiness.cjs";
const regressionPath = "src/__tests__/factory-drill-readiness.test.ts";
const candidateSource =
  'module.exports = (available) => ({statusCode: available === true ? 200 : 503, body: {status: available === true ? "ok" : "unavailable"}});\n';
function seededCheckout(t) {
  const app = repo(t);
  for (const [name, content] of [
    [implementationPath, candidateSource],
    [regressionPath, drillFixture.regressionSource],
    [".factory-output/evidence.md", "No commands executed; trusted verification is pending."],
  ]) {
    fs.mkdirSync(path.dirname(path.join(app.cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(app.cwd, name), content);
  }
  return { ...app, grantId: incidentId };
}
function collectionEnvironment(app, overrides = {}) {
  return {
    GITHUB_REPOSITORY: policy.REPOSITORY,
    GITHUB_ACTOR: policy.OWNER,
    GITHUB_TRIGGERING_ACTOR: policy.OWNER,
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF: workflowRef,
    GITHUB_WORKFLOW_SHA: workflowSha,
    GITHUB_RUN_ID: "100",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKSPACE: app.cwd,
    FACTORY_OPERATION: "collect",
    FACTORY_VARIABLES: JSON.stringify(vars),
    FACTORY_INPUTS: JSON.stringify({
      ticket: "10",
      phase: "code",
      slot: "drill",
      head: app.head,
      grantId: app.grantId,
    }),
    FACTORY_ARTIFACT_DIR: path.join(app.cwd, ".collected-artifact"),
    ...overrides,
  };
}

test("drill collection never executes malicious Git filters or includes unrelated checkout edits", async (t) => {
  const app = seededCheckout(t);
  execFileSync("git", ["add", implementationPath], { cwd: app.cwd });
  execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "Seed implementation", "--no-gpg-sign"],
    { cwd: app.cwd }
  );
  app.head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: app.cwd, encoding: "utf8" }).trim();
  fs.writeFileSync(
    path.join(app.cwd, implementationPath),
    candidateSource + "// candidate change\n"
  );
  fs.writeFileSync(
    path.join(app.cwd, "filter.cjs"),
    'require("node:fs").writeFileSync("FILTER_RAN", "unsafe execution"); process.stdin.pipe(process.stdout);\n'
  );
  fs.writeFileSync(path.join(app.cwd, ".gitattributes"), `${implementationPath} filter=drill\n`);
  fs.appendFileSync(
    path.join(app.cwd, ".git/config"),
    '\n[filter "drill"]\n\tclean = node filter.cjs\n\trequired = true\n'
  );
  fs.writeFileSync(
    path.join(app.cwd, "package.json"),
    '{"scripts":{"postinstall":"node filter.cjs"}}'
  );
  const env = collectionEnvironment(app);
  let failure;
  try {
    await worker.main(env);
  } catch (error) {
    failure = error;
  }
  assert.equal(
    fs.existsSync(path.join(app.cwd, "FILTER_RAN")),
    false,
    "collection must not execute Git's configured filter"
  );
  if (failure) throw failure;
  const bundle = JSON.parse(
    fs.readFileSync(path.join(env.FACTORY_ARTIFACT_DIR, "bundle.json"), "utf8")
  );
  assert.deepEqual(
    bundle.files.map((file) => file.path),
    [implementationPath]
  );
  assert.equal(bundle.files[0].content, candidateSource + "// candidate change\n");
  assert.equal(bundle.base, app.head);
  assert.equal(bundle.grantId, app.grantId);
});

test("drill collector needs no Git metadata and never loads candidate code", (t) => {
  const app = seededCheckout(t);
  fs.renameSync(path.join(app.cwd, ".git"), path.join(app.cwd, "discarded-git"));
  const content = 'require("node:fs").writeFileSync("CANDIDATE_RAN", "unsafe execution");\n';
  fs.writeFileSync(path.join(app.cwd, implementationPath), content);
  const bundle = worker.collectDrillCode(app);
  assert.equal(fs.existsSync(path.join(app.cwd, "CANDIDATE_RAN")), false);
  assert.deepEqual(bundle.files, [{ path: implementationPath, mode: "100644", content }]);
});

test("drill filesystem collector rejects changed tests and malformed candidate or evidence", (t) => {
  assert.equal(typeof worker.collectDrillCode, "function", "missing filesystem-only collector");
  for (const [name, content] of [
    [regressionPath, drillFixture.regressionSource + "// modified test\n"],
    [implementationPath, drillFixture.brokenSource],
    [implementationPath, ""],
    [implementationPath, Buffer.from([0xff, 0xfe])],
    [implementationPath, "\0binary"],
    [implementationPath, "x".repeat(32769)],
    [implementationPath, "ghp_" + "A".repeat(40)],
    [".factory-output/evidence.md", ""],
    [".factory-output/evidence.md", "x".repeat(20001)],
    [".factory-output/evidence.md", "\0binary"],
    [".factory-output/evidence.md", "ghp_" + "A".repeat(40)],
  ]) {
    const app = seededCheckout(t);
    fs.writeFileSync(path.join(app.cwd, name), content);
    assert.throws(
      () => worker.collectDrillCode(app),
      /drill|artifact|fixture|test|binary|UTF|secret|change|evidence/i,
      name
    );
  }
  const missing = seededCheckout(t);
  fs.unlinkSync(path.join(missing.cwd, implementationPath));
  assert.throws(() => worker.collectDrillCode(missing));
});

test("drill collector refuses linked directories along every fixed artifact path", (t) => {
  assert.equal(typeof worker.collectDrillCode, "function", "missing filesystem-only collector");
  for (const component of [
    "backend",
    "backend/factory-drill",
    "src",
    "src/__tests__",
    ".factory-output",
  ]) {
    const app = seededCheckout(t);
    const target = path.join(app.cwd, "relocated");
    fs.renameSync(path.join(app.cwd, component), target);
    fs.symlinkSync(
      target,
      path.join(app.cwd, component),
      process.platform === "win32" ? "junction" : "dir"
    );
    assert.throws(() => worker.collectDrillCode(app), /link|path|artifact/i, component);
  }
});

test(
  "drill collection refuses executable file modes",
  { skip: process.platform === "win32" },
  (t) => {
    const app = seededCheckout(t);
    fs.chmodSync(path.join(app.cwd, implementationPath), 0o755);
    assert.throws(() => worker.collectDrillCode(app), /mode|executable|artifact/i);
  }
);

test("drill collector selection is bound to the real workflow context and coding slot", async (t) => {
  const app = seededCheckout(t);
  for (const change of [
    {
      GITHUB_WORKFLOW_REF: `${policy.REPOSITORY}/.github/workflows/factory-agents.yml@refs/heads/main`,
    },
    { GITHUB_RUN_ATTEMPT: "2" },
    { GITHUB_ACTOR: "outsider" },
    {
      FACTORY_INPUTS: JSON.stringify({
        phase: "review",
        slot: "drill",
        head: app.head,
        grantId: app.grantId,
      }),
    },
    {
      FACTORY_INPUTS: JSON.stringify({
        phase: "code",
        slot: "cycle1",
        head: app.head,
        grantId: app.grantId,
      }),
    },
  ])
    await assert.rejects(
      worker.main(collectionEnvironment(app, change)),
      /drill.*context|context.*drill/i
    );
});
